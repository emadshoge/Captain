import { randomBytes } from 'node:crypto';
import {
  AlertSchema,
  AssignDeviceSchema,
  COMMON_ERROR_CODES,
  CommandSchema,
  CreateMaintenanceSchema,
  CreateScooterSchema,
  CreateZoneSchema,
  DeviceSummarySchema,
  FLEET_ERROR_CODES,
  MaintenanceSchema,
  OperatorScooterDetailSchema,
  OperatorScooterQuerySchema,
  OperatorScooterSchema,
  OperatorStatusUpdateSchema,
  ReasonBodySchema,
  RegisterDeviceSchema,
  STAFF_ERROR_CODES,
  ServiceCommandSchema,
  SimulationScenarioSchema,
  UpdateMaintenanceSchema,
  UpdateZoneSchema,
  ZoneSchema,
} from '@captain/contracts';
import { boundingBox, validateZoneGeometry, type ZoneGeometry } from '@captain/domain';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { staffOf } from '../auth/http';
import { AppError } from '../errors';
import { recordAudit } from '../lib/audit';
import { type Queryable, isUniqueViolation, one, withTransaction } from '../lib/db';
import { toZone } from './rider-routes';
import {
  type CommandRow,
  type FleetDeps,
  SCOOTER_SELECT,
  type ScooterRow,
  type ZoneRow,
  assertServiceCommandAllowed,
  createCommand,
  isStale,
  requireScooter,
} from './service';

const IdParams = z.object({ id: z.uuid() });

function deviceSummary(row: ScooterRow) {
  return row.device_id
    ? {
        id: row.device_id,
        supplierDeviceId: row.supplier_device_id!,
        adapter: row.adapter!,
        isSimulated: row.is_simulated!,
        online: row.online!,
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        firmwareVersion: row.firmware_version,
      }
    : null;
}

function toOperatorScooter(row: ScooterRow & { open_alerts?: number }, deps: FleetDeps) {
  return {
    id: row.id,
    code: row.code,
    status: row.status as z.infer<typeof OperatorScooterSchema>['status'],
    model: row.model,
    batteryPercent: row.battery_percent,
    lat: row.last_lat,
    lng: row.last_lng,
    lastTelemetryAt: row.last_telemetry_at?.toISOString() ?? null,
    stale: isStale(row, deps.config, deps.now()),
    device: deviceSummary(row),
    openAlerts: Number(row.open_alerts ?? 0),
  };
}

interface AlertRow {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  scooter_id: string | null;
  scooter_code: string | null;
  device_id: string | null;
  ride_id: string | null;
  data: unknown;
  created_at: Date;
  resolved_at: Date | null;
}
const toAlert = (r: AlertRow) => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  status: r.status,
  scooterId: r.scooter_id,
  scooterCode: r.scooter_code,
  deviceId: r.device_id,
  rideId: r.ride_id,
  data: r.data,
  createdAt: r.created_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
});

interface MaintenanceRow {
  id: string;
  scooter_id: string;
  scooter_code: string;
  kind: z.infer<typeof MaintenanceSchema>['kind'];
  status: z.infer<typeof MaintenanceSchema>['status'];
  notes: string | null;
  assigned_to_staff_id: string | null;
  created_by_staff_id: string | null;
  created_at: Date;
  completed_at: Date | null;
}
const toMaintenance = (r: MaintenanceRow) => ({
  id: r.id,
  scooterId: r.scooter_id,
  scooterCode: r.scooter_code,
  kind: r.kind,
  status: r.status,
  notes: r.notes,
  assignedToStaffId: r.assigned_to_staff_id,
  createdByStaffId: r.created_by_staff_id,
  createdAt: r.created_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
});
const MAINTENANCE_SELECT = `select m.*, m.kind::text as kind, m.status::text as status, s.code as scooter_code
  from maintenance_records m join scooters s on s.id = m.scooter_id`;

const toCommand = (r: CommandRow) => ({
  id: r.id,
  deviceId: r.device_id,
  rideId: r.ride_id,
  type: r.type,
  status: r.status,
  issuedBy: r.issued_by,
  reason: r.reason,
  isSimulated: r.is_simulated,
  createdAt: r.created_at.toISOString(),
  deadlineAt: r.deadline_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  resultCode: r.result_code,
});

async function loadZone(q: Queryable, id: string): Promise<ZoneRow> {
  const row = await one<ZoneRow>(
    q,
    `select id, name, kind::text as kind, geometry, active, version, is_dev_fixture from zones where id = $1`,
    [id],
  );
  if (!row) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
  return row;
}

function checkedGeometry(geometry: unknown): ZoneGeometry {
  const problems = validateZoneGeometry(geometry);
  if (problems.length > 0) {
    throw new AppError(400, FLEET_ERROR_CODES.INVALID_GEOMETRY, 'The zone shape is invalid.', {
      problems,
    });
  }
  return geometry as ZoneGeometry;
}

export const fleetStaffRoutes: FastifyPluginAsyncZod<{ deps: FleetDeps }> = async (
  app,
  { deps },
) => {
  // ---- Operator: fleet ----------------------------------------------------
  app.get(
    '/v1/operator/scooters',
    {
      config: { permission: 'fleet.read' },
      schema: {
        querystring: OperatorScooterQuerySchema,
        response: { 200: z.array(OperatorScooterSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (q.status) add('s.status = ?', q.status);
      if (q.q) add('s.code ilike ?', `%${q.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      if (q.batteryBelow !== undefined) add('s.battery_percent < ?', q.batteryBelow);
      if (q.simulated) add('coalesce(d.is_simulated, false) = ?', q.simulated === 'true');
      if (q.stale) {
        const threshold = new Date(
          deps.now().getTime() - deps.config.FLEET_TELEMETRY_STALE_SECONDS * 1000,
        );
        add(
          q.stale === 'true'
            ? '(s.last_telemetry_at is null or s.last_telemetry_at < ?)'
            : 's.last_telemetry_at >= ?',
          threshold,
        );
      }
      params.push(q.limit, q.offset);
      const { rows } = await deps.pool.query<ScooterRow & { open_alerts: number }>(
        `with base as (${SCOOTER_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''})
         select base.*, (select count(*)::int from operational_alerts o where o.scooter_id = base.id and o.status <> 'resolved') as open_alerts
         from base order by base.code limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return rows.map((row) => toOperatorScooter(row, deps));
    },
  );

  app.get(
    '/v1/operator/scooters/:id',
    {
      config: { permission: 'fleet.read' },
      schema: { params: IdParams, response: { 200: OperatorScooterDetailSchema } },
    },
    async (request) => {
      const row = await requireScooter(deps.pool, { id: request.params.id });
      const telemetry = row.device_id
        ? (
            await deps.pool.query(
              `select * from device_telemetry where device_id = $1 order by received_at desc limit 20`,
              [row.device_id],
            )
          ).rows
        : [];
      const alerts = (
        await deps.pool.query<AlertRow>(
          `select o.*, o.kind::text as kind, s.code as scooter_code from operational_alerts o
           left join scooters s on s.id = o.scooter_id
           where o.scooter_id = $1 order by o.created_at desc limit 20`,
          [row.id],
        )
      ).rows;
      const maintenance = (
        await deps.pool.query<MaintenanceRow>(
          `${MAINTENANCE_SELECT} where m.scooter_id = $1 order by m.created_at desc limit 20`,
          [row.id],
        )
      ).rows;
      const commands = row.device_id
        ? (
            await deps.pool.query<CommandRow>(
              `select *, type::text as type, status::text as status from device_commands where device_id = $1 order by created_at desc limit 20`,
              [row.device_id],
            )
          ).rows
        : [];
      return {
        ...toOperatorScooter(
          { ...row, open_alerts: alerts.filter((a) => a.status !== 'resolved').length },
          deps,
        ),
        qrToken: row.qr_token,
        recentTelemetry: telemetry.map((t) => ({
          receivedAt: t.received_at.toISOString(),
          recordedAt: t.recorded_at?.toISOString() ?? null,
          lat: t.lat,
          lng: t.lng,
          batteryPercent: t.battery_percent,
          speedKmh: t.speed_kmh,
          locked: t.locked,
          valid: t.valid,
          invalidReason: t.invalid_reason,
        })),
        alerts: alerts.map(toAlert),
        maintenance: maintenance.map(toMaintenance),
        commands: commands.map(toCommand),
      };
    },
  );

  app.patch(
    '/v1/operator/scooters/:id/status',
    {
      config: { permission: 'fleet.status.update' },
      schema: {
        params: IdParams,
        body: OperatorStatusUpdateSchema,
        response: { 200: OperatorScooterSchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        const before = await one<{ status: string }>(
          client,
          `select status::text as status from scooters where id = $1 for update`,
          [request.params.id],
        );
        if (!before)
          throw new AppError(404, FLEET_ERROR_CODES.SCOOTER_NOT_FOUND, 'Scooter not found.');
        if (['in_ride', 'reserved', 'retired'].includes(before.status)) {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            `The scooter is ${before.status}.`,
          );
        }
        await client.query(
          `update scooters set status = $2, version = version + 1, updated_at = now() where id = $1`,
          [request.params.id, request.body.status],
        );
        await recordAudit(client, request, {
          action: 'scooter.status_changed',
          targetType: 'scooter',
          targetId: request.params.id,
          reason: request.body.reason,
          before,
          after: { status: request.body.status },
        });
      });
      return toOperatorScooter(await requireScooter(deps.pool, { id: request.params.id }), deps);
    },
  );

  app.post(
    '/v1/operator/scooters/:id/commands',
    {
      config: { permission: 'device.command.service' },
      schema: { params: IdParams, body: ServiceCommandSchema, response: { 202: CommandSchema } },
    },
    async (request, reply) => {
      const staff = staffOf(request);
      const scooter = await requireScooter(deps.pool, { id: request.params.id });
      await assertServiceCommandAllowed(deps, scooter, request.body.type);
      const command = await withTransaction(deps.pool, async (client) => {
        const created = await createCommand(
          client,
          {
            deviceId: scooter.device_id!,
            type: request.body.type,
            issuedBy: 'staff',
            staffId: staff.staffId,
            reason: request.body.reason,
          },
          deps.now(),
          deps.config.COMMAND_TIMEOUT_SECONDS,
        );
        await recordAudit(client, request, {
          action: 'device.command.issued',
          targetType: 'scooter',
          targetId: scooter.id,
          reason: request.body.reason,
          after: {
            type: request.body.type,
            commandId: created.id,
            simulated: created.is_simulated,
          },
        });
        return created;
      });
      return reply.code(202).send(toCommand(command));
    },
  );

  // ---- Operator: alerts -----------------------------------------------------
  app.get(
    '/v1/operator/alerts',
    {
      config: { permission: 'fleet.read' },
      schema: {
        querystring: z.object({
          status: z.enum(['open', 'acknowledged', 'resolved', 'unresolved']).default('unresolved'),
        }),
        response: { 200: z.array(AlertSchema) },
      },
    },
    async (request) => {
      const filter =
        request.query.status === 'unresolved' ? `o.status <> 'resolved'` : `o.status = $1`;
      const { rows } = await deps.pool.query<AlertRow>(
        `select o.*, o.kind::text as kind, s.code as scooter_code from operational_alerts o
         left join scooters s on s.id = o.scooter_id
         where ${filter} order by o.severity desc, o.created_at desc limit 200`,
        request.query.status === 'unresolved' ? [] : [request.query.status],
      );
      return rows.map(toAlert);
    },
  );

  for (const action of ['acknowledge', 'resolve'] as const) {
    app.post(
      `/v1/operator/alerts/:id/${action}`,
      {
        config: { permission: 'alerts.manage' },
        schema: { params: IdParams, response: { 200: AlertSchema } },
      },
      async (request) => {
        const staff = staffOf(request);
        const row = await withTransaction(deps.pool, async (client) => {
          const updated = await one<AlertRow>(
            client,
            action === 'acknowledge'
              ? `update operational_alerts set status = 'acknowledged', acknowledged_by_staff_id = $2
                 where id = $1 and status = 'open' returning *, kind::text as kind`
              : `update operational_alerts set status = 'resolved', resolved_at = now(), acknowledged_by_staff_id = coalesce(acknowledged_by_staff_id, $2)
                 where id = $1 and status <> 'resolved' returning *, kind::text as kind`,
            [request.params.id, staff.staffId],
          );
          if (!updated)
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'The alert cannot change to that state.',
            );
          await recordAudit(client, request, {
            action: `alert.${action}d`,
            targetType: 'alert',
            targetId: updated.id,
          });
          return updated;
        });
        return toAlert({ ...row, scooter_code: null });
      },
    );
  }

  // ---- Operator: maintenance & repositioning -----------------------------------
  app.get(
    '/v1/operator/maintenance',
    {
      config: { permission: 'fleet.read' },
      schema: {
        querystring: z.object({
          status: z.enum(['open', 'in_progress', 'done', 'cancelled', 'active']).default('active'),
          mine: z.enum(['true', 'false']).optional(),
        }),
        response: { 200: z.array(MaintenanceSchema) },
      },
    },
    async (request) => {
      const staff = staffOf(request);
      const params: unknown[] = [];
      const where =
        request.query.status === 'active'
          ? [`m.status in ('open','in_progress')`]
          : [`m.status = $${params.push(request.query.status)}`];
      if (request.query.mine === 'true')
        where.push(`m.assigned_to_staff_id = $${params.push(staff.staffId)}`);
      const { rows } = await deps.pool.query<MaintenanceRow>(
        `${MAINTENANCE_SELECT} where ${where.join(' and ')} order by m.created_at desc limit 200`,
        params,
      );
      return rows.map(toMaintenance);
    },
  );

  app.post(
    '/v1/operator/maintenance',
    {
      config: { permission: 'maintenance.manage' },
      schema: { body: CreateMaintenanceSchema, response: { 201: MaintenanceSchema } },
    },
    async (request, reply) => {
      const staff = staffOf(request);
      await requireScooter(deps.pool, { id: request.body.scooterId });
      const id = await withTransaction(deps.pool, async (client) => {
        const row = await one<{ id: string }>(
          client,
          `insert into maintenance_records (scooter_id, kind, notes, created_by_staff_id, assigned_to_staff_id)
           values ($1,$2,$3,$4,$5) returning id`,
          [
            request.body.scooterId,
            request.body.kind,
            request.body.notes ?? null,
            staff.staffId,
            request.body.assignedToStaffId ?? null,
          ],
        );
        await recordAudit(client, request, {
          action: 'maintenance.created',
          targetType: 'scooter',
          targetId: request.body.scooterId,
          after: { kind: request.body.kind, maintenanceId: row!.id },
        });
        return row!.id;
      });
      const created = await one<MaintenanceRow>(
        deps.pool,
        `${MAINTENANCE_SELECT} where m.id = $1`,
        [id],
      );
      return reply.code(201).send(toMaintenance(created!));
    },
  );

  app.patch(
    '/v1/operator/maintenance/:id',
    {
      config: { permission: 'maintenance.manage' },
      schema: {
        params: IdParams,
        body: UpdateMaintenanceSchema,
        response: { 200: MaintenanceSchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        const before = await one<MaintenanceRow>(
          client,
          `select * from maintenance_records where id = $1 for update`,
          [request.params.id],
        );
        if (!before) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
        if (before.status === 'done' || before.status === 'cancelled') {
          throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, 'This task is closed.');
        }
        const status = request.body.status ?? before.status;
        await client.query(
          `update maintenance_records set status = $2::task_status, notes = coalesce($3, notes),
             assigned_to_staff_id = case when $5 then $4 else assigned_to_staff_id end,
             completed_at = case when $2::task_status in ('done','cancelled') then now() else completed_at end,
             updated_at = now()
           where id = $1`,
          [
            request.params.id,
            status,
            request.body.notes ?? null,
            request.body.assignedToStaffId ?? null,
            request.body.assignedToStaffId !== undefined,
          ],
        );
        await recordAudit(client, request, {
          action: 'maintenance.updated',
          targetType: 'maintenance',
          targetId: request.params.id,
          before: { status: before.status },
          after: { status },
        });
      });
      const row = await one<MaintenanceRow>(deps.pool, `${MAINTENANCE_SELECT} where m.id = $1`, [
        request.params.id,
      ]);
      return toMaintenance(row!);
    },
  );

  app.get(
    '/v1/operator/zones',
    { config: { permission: 'fleet.read' }, schema: { response: { 200: z.array(ZoneSchema) } } },
    async () => {
      const { rows } = await deps.pool.query<ZoneRow>(
        `select id, name, kind::text as kind, geometry, active, version, is_dev_fixture from zones order by active desc, kind, name`,
      );
      return rows.map(toZone);
    },
  );

  // ---- Admin: fleet onboarding (fleet.manage) ---------------------------------
  app.post(
    '/v1/admin/scooters',
    {
      config: { permission: 'fleet.manage' },
      schema: { body: CreateScooterSchema, response: { 201: OperatorScooterSchema } },
    },
    async (request, reply) => {
      const id = await withTransaction(deps.pool, async (client) => {
        let row: { id: string } | undefined;
        try {
          row = await one<{ id: string }>(
            client,
            `insert into scooters (code, qr_token, model, status) values ($1, $2, $3, 'maintenance') returning id`,
            [
              request.body.code,
              `cap-${randomBytes(18).toString('base64url')}`,
              request.body.model ?? null,
            ],
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'That scooter code is already used.',
            );
          throw error;
        }
        await recordAudit(client, request, {
          action: 'scooter.created',
          targetType: 'scooter',
          targetId: row!.id,
          reason: request.body.reason,
          after: { code: request.body.code },
        });
        return row!.id;
      });
      return reply.code(201).send(toOperatorScooter(await requireScooter(deps.pool, { id }), deps));
    },
  );

  app.post(
    '/v1/admin/devices',
    {
      config: { permission: 'fleet.manage' },
      schema: { body: RegisterDeviceSchema, response: { 201: DeviceSummarySchema } },
    },
    async (request, reply) => {
      if (request.body.adapter === 'simulated' && deps.config.APP_ENV === 'production') {
        throw new AppError(
          403,
          FLEET_ERROR_CODES.SIMULATED_NOT_ALLOWED,
          'Simulated devices cannot be registered in production.',
        );
      }
      const row = await withTransaction(deps.pool, async (client) => {
        let device:
          | {
              id: string;
              supplier_device_id: string;
              adapter: 'simulated' | 'supplier_tcp';
              is_simulated: boolean;
              online: boolean;
              last_seen_at: Date | null;
              firmware_version: string | null;
            }
          | undefined;
        try {
          device = await one(
            client,
            `insert into devices (supplier_device_id, adapter, is_simulated, firmware_version) values ($1, $2, $3, $4)
             returning id, supplier_device_id, adapter::text as adapter, is_simulated, online, last_seen_at, firmware_version`,
            [
              request.body.supplierDeviceId,
              request.body.adapter,
              request.body.adapter === 'simulated',
              request.body.firmwareVersion ?? null,
            ],
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'That device is already registered.',
            );
          throw error;
        }
        await recordAudit(client, request, {
          action: 'device.registered',
          targetType: 'device',
          targetId: device!.id,
          reason: request.body.reason,
          after: { supplierDeviceId: request.body.supplierDeviceId, adapter: request.body.adapter },
        });
        return device!;
      });
      return reply.code(201).send({
        id: row.id,
        supplierDeviceId: row.supplier_device_id,
        adapter: row.adapter,
        isSimulated: row.is_simulated,
        online: row.online,
        lastSeenAt: row.last_seen_at?.toISOString() ?? null,
        firmwareVersion: row.firmware_version,
      });
    },
  );

  app.post(
    '/v1/admin/scooters/:id/device',
    {
      config: { permission: 'fleet.manage' },
      schema: {
        params: IdParams,
        body: AssignDeviceSchema,
        response: { 200: OperatorScooterSchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        const scooter = await one<{ status: string }>(
          client,
          `select status::text as status from scooters where id = $1 for update`,
          [request.params.id],
        );
        if (!scooter)
          throw new AppError(404, FLEET_ERROR_CODES.SCOOTER_NOT_FOUND, 'Scooter not found.');
        if (scooter.status === 'in_ride' || scooter.status === 'reserved') {
          throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, 'The scooter is in use.');
        }
        try {
          await client.query(
            `update device_assignments set unassigned_at = now() where scooter_id = $1 and unassigned_at is null`,
            [request.params.id],
          );
          await client.query(
            `insert into device_assignments (device_id, scooter_id, assigned_by_staff_id) values ($1,$2,$3)`,
            [request.body.deviceId, request.params.id, staffOf(request).staffId],
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'That device is assigned to another scooter.',
            );
          if ((error as { code?: string }).code === '23503')
            throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Device not found.');
          throw error;
        }
        await recordAudit(client, request, {
          action: 'device.assigned',
          targetType: 'scooter',
          targetId: request.params.id,
          reason: request.body.reason,
          after: { deviceId: request.body.deviceId },
        });
      });
      return toOperatorScooter(await requireScooter(deps.pool, { id: request.params.id }), deps);
    },
  );

  app.post(
    '/v1/admin/scooters/:id/device/unassign',
    {
      config: { permission: 'fleet.manage' },
      schema: {
        params: IdParams,
        body: ReasonBodySchema,
        response: { 200: OperatorScooterSchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        const scooter = await one<{ status: string }>(
          client,
          `select status::text as status from scooters where id = $1 for update`,
          [request.params.id],
        );
        if (!scooter)
          throw new AppError(404, FLEET_ERROR_CODES.SCOOTER_NOT_FOUND, 'Scooter not found.');
        if (scooter.status === 'in_ride' || scooter.status === 'reserved') {
          throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, 'The scooter is in use.');
        }
        await client.query(
          `update device_assignments set unassigned_at = now() where scooter_id = $1 and unassigned_at is null`,
          [request.params.id],
        );
        await client.query(
          `update scooters set status = 'maintenance', version = version + 1, updated_at = now() where id = $1`,
          [request.params.id],
        );
        await recordAudit(client, request, {
          action: 'device.unassigned',
          targetType: 'scooter',
          targetId: request.params.id,
          reason: request.body.reason,
        });
      });
      return toOperatorScooter(await requireScooter(deps.pool, { id: request.params.id }), deps);
    },
  );

  app.post(
    '/v1/admin/scooters/:id/retire',
    {
      config: { permission: 'fleet.manage' },
      schema: {
        params: IdParams,
        body: ReasonBodySchema,
        response: { 200: OperatorScooterSchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        const scooter = await one<{ status: string }>(
          client,
          `select status::text as status from scooters where id = $1 for update`,
          [request.params.id],
        );
        if (!scooter)
          throw new AppError(404, FLEET_ERROR_CODES.SCOOTER_NOT_FOUND, 'Scooter not found.');
        if (['in_ride', 'reserved', 'retired'].includes(scooter.status)) {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            `The scooter is ${scooter.status}.`,
          );
        }
        await client.query(
          `update device_assignments set unassigned_at = now() where scooter_id = $1 and unassigned_at is null`,
          [request.params.id],
        );
        await client.query(
          `update scooters set status = 'retired', retired_at = now(), version = version + 1, updated_at = now() where id = $1`,
          [request.params.id],
        );
        await recordAudit(client, request, {
          action: 'scooter.retired',
          targetType: 'scooter',
          targetId: request.params.id,
          reason: request.body.reason,
          before: scooter,
        });
      });
      return toOperatorScooter(await requireScooter(deps.pool, { id: request.params.id }), deps);
    },
  );

  /** Development/test only: scripted behaviour for a SIMULATED device. */
  app.patch(
    '/v1/admin/devices/:id/simulation',
    {
      config: { permission: 'fleet.manage' },
      schema: {
        params: IdParams,
        body: SimulationScenarioSchema,
        response: { 200: SimulationScenarioSchema },
      },
    },
    async (request) => {
      if (deps.config.APP_ENV === 'production' || deps.config.APP_ENV === 'staging') {
        throw new AppError(
          403,
          FLEET_ERROR_CODES.SIMULATED_NOT_ALLOWED,
          'Simulation controls are disabled here.',
        );
      }
      await withTransaction(deps.pool, async (client) => {
        const device = await one<{ is_simulated: boolean }>(
          client,
          `select is_simulated from devices where id = $1 for update`,
          [request.params.id],
        );
        if (!device) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
        if (!device.is_simulated) {
          throw new AppError(
            409,
            FLEET_ERROR_CODES.SIMULATED_NOT_ALLOWED,
            'Only simulated devices have scenarios.',
          );
        }
        await client.query(
          `update devices set metadata = jsonb_set(metadata, '{simulation}', $2::jsonb) where id = $1`,
          [request.params.id, JSON.stringify(request.body)],
        );
        await recordAudit(client, request, {
          action: 'device.simulation_changed',
          targetType: 'device',
          targetId: request.params.id,
          after: request.body,
        });
      });
      return request.body;
    },
  );

  // ---- Admin: zones (zones.manage) -----------------------------------------
  app.post(
    '/v1/admin/zones',
    {
      config: { permission: 'zones.manage' },
      schema: { body: CreateZoneSchema, response: { 201: ZoneSchema } },
    },
    async (request, reply) => {
      const geometry = checkedGeometry(request.body.geometry);
      const bbox = boundingBox(geometry);
      const id = await withTransaction(deps.pool, async (client) => {
        const row = await one<{ id: string }>(
          client,
          `insert into zones (name, kind, geometry, min_lat, min_lng, max_lat, max_lng, created_by_staff_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [
            request.body.name,
            request.body.kind,
            JSON.stringify(geometry),
            bbox.minLat,
            bbox.minLng,
            bbox.maxLat,
            bbox.maxLng,
            staffOf(request).staffId,
          ],
        );
        await recordAudit(client, request, {
          action: 'zone.created',
          targetType: 'zone',
          targetId: row!.id,
          reason: request.body.reason,
          after: { name: request.body.name, kind: request.body.kind },
        });
        return row!.id;
      });
      return reply.code(201).send(toZone(await loadZone(deps.pool, id)));
    },
  );

  app.patch(
    '/v1/admin/zones/:id',
    {
      config: { permission: 'zones.manage' },
      schema: { params: IdParams, body: UpdateZoneSchema, response: { 200: ZoneSchema } },
    },
    async (request) => {
      const geometry = request.body.geometry ? checkedGeometry(request.body.geometry) : null;
      await withTransaction(deps.pool, async (client) => {
        const before = await loadZone(client, request.params.id);
        const bbox = geometry ? boundingBox(geometry) : null;
        await client.query(
          `update zones set name = coalesce($2, name), active = coalesce($3, active),
             geometry = coalesce($4, geometry), min_lat = coalesce($5, min_lat), min_lng = coalesce($6, min_lng),
             max_lat = coalesce($7, max_lat), max_lng = coalesce($8, max_lng), version = version + 1, updated_at = now()
           where id = $1`,
          [
            request.params.id,
            request.body.name ?? null,
            request.body.active ?? null,
            geometry ? JSON.stringify(geometry) : null,
            bbox?.minLat ?? null,
            bbox?.minLng ?? null,
            bbox?.maxLat ?? null,
            bbox?.maxLng ?? null,
          ],
        );
        await recordAudit(client, request, {
          action: 'zone.updated',
          targetType: 'zone',
          targetId: request.params.id,
          reason: request.body.reason,
          before: { name: before.name, active: before.active, version: before.version },
          after: {
            name: request.body.name,
            active: request.body.active,
            geometryChanged: Boolean(geometry),
          },
        });
      });
      return toZone(await loadZone(deps.pool, request.params.id));
    },
  );
};
