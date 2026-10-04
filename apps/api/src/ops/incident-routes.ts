import {
  CreateIncidentSchema,
  IncidentSchema,
  IncidentsQuerySchema,
  ResolveIncidentSchema,
  STAFF_ERROR_CODES,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { staffOf } from '../auth/http';
import { AppError } from '../errors';
import type { FleetDeps } from '../fleet/service';
import { recordAudit } from '../lib/audit';
import { one, withTransaction } from '../lib/db';

const IdParams = z.object({ id: z.uuid() });

interface IncidentRow {
  id: string;
  kind: z.infer<typeof IncidentSchema>['kind'];
  status: 'open' | 'in_progress' | 'resolved';
  ride_id: string | null;
  scooter_id: string | null;
  scooter_code: string | null;
  device_id: string | null;
  rider_id: string | null;
  reported_by_type: 'system' | 'staff' | 'rider';
  description: string;
  assigned_staff_id: string | null;
  resolution: z.infer<typeof IncidentSchema>['resolution'];
  resolution_note: string | null;
  resolved_by_staff_id: string | null;
  resolved_at: Date | null;
  is_simulated: boolean;
  created_at: Date;
}

const SELECT = `select i.*, i.kind::text as kind, i.status::text as status, i.resolution::text as resolution,
  i.reported_by_type::text as reported_by_type, s.code as scooter_code
  from incidents i left join scooters s on s.id = i.scooter_id`;

function toIncident(row: IncidentRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    rideId: row.ride_id,
    scooterId: row.scooter_id,
    scooterCode: row.scooter_code,
    deviceId: row.device_id,
    riderId: row.rider_id,
    reportedByType: row.reported_by_type,
    description: row.description,
    assignedStaffId: row.assigned_staff_id,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    resolvedByStaffId: row.resolved_by_staff_id,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    isSimulated: row.is_simulated,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Incidents: problems that need a person (late unlock acks, failed
 * completions, rider reports). Handling an incident never sends a device
 * command; ride money is settled through the ride review endpoints.
 */
export const incidentRoutes: FastifyPluginAsyncZod<{ deps: FleetDeps }> = async (app, { deps }) => {
  const load = async (id: string) => one<IncidentRow>(deps.pool, `${SELECT} where i.id = $1`, [id]);

  app.get(
    '/v1/operator/incidents',
    {
      config: { permission: 'incidents.read' },
      schema: { querystring: IncidentsQuerySchema, response: { 200: z.array(IncidentSchema) } },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await deps.pool.query<IncidentRow>(
        `${SELECT}
         where (case when $1 = 'unresolved' then i.status <> 'resolved' else i.status::text = $1 end)
           and ($2::uuid is null or i.scooter_id = $2) and ($3::uuid is null or i.ride_id = $3)
         order by i.created_at desc limit $4`,
        [q.status, q.scooterId ?? null, q.rideId ?? null, q.limit],
      );
      return rows.map(toIncident);
    },
  );

  app.post(
    '/v1/operator/incidents',
    {
      config: { permission: 'incidents.resolve' },
      schema: { body: CreateIncidentSchema, response: { 201: IncidentSchema } },
    },
    async (request, reply) => {
      const b = request.body;
      const id = await withTransaction(deps.pool, async (client) => {
        const row = await one<{ id: string }>(
          client,
          `insert into incidents (kind, ride_id, scooter_id, rider_id, reported_by_type, description, is_simulated)
           values ($1, $2, $3, (select rider_id from rides where id = $2), 'staff', $4,
             coalesce((select d.is_simulated from device_assignments a join devices d on d.id = a.device_id
                       where a.scooter_id = $3 and a.unassigned_at is null), false))
           returning id`,
          [b.kind, b.rideId ?? null, b.scooterId ?? null, b.description],
        );
        await recordAudit(client, request, {
          action: 'incident.created',
          targetType: 'incident',
          targetId: row!.id,
          after: b,
        });
        return row!.id;
      });
      reply.code(201);
      return toIncident((await load(id))!);
    },
  );

  app.post(
    '/v1/operator/incidents/:id/assign',
    {
      config: { permission: 'incidents.resolve' },
      schema: { params: IdParams, response: { 200: IncidentSchema } },
    },
    async (request) => {
      const updated = await one(
        deps.pool,
        `update incidents set status = 'in_progress', assigned_staff_id = $2, updated_at = now()
         where id = $1 and status <> 'resolved' returning id`,
        [request.params.id, staffOf(request).staffId],
      );
      const row = await load(request.params.id);
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Incident not found.');
      if (!updated)
        throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, 'The incident is resolved.');
      return toIncident(row);
    },
  );

  app.post(
    '/v1/operator/incidents/:id/resolve',
    {
      config: { permission: 'incidents.resolve' },
      schema: { params: IdParams, body: ResolveIncidentSchema, response: { 200: IncidentSchema } },
    },
    async (request) => {
      const staffId = staffOf(request).staffId;
      await withTransaction(deps.pool, async (client) => {
        const before = await one<{ status: string }>(
          client,
          `select status::text as status from incidents where id = $1 for update`,
          [request.params.id],
        );
        if (!before) throw new AppError(404, 'NOT_FOUND', 'Incident not found.');
        if (before.status === 'resolved') {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            'The incident is already resolved.',
          );
        }
        await client.query(
          `update incidents set status = 'resolved', resolution = $2, resolution_note = $3, resolved_by_staff_id = $4,
             resolved_at = now(), updated_at = now() where id = $1`,
          [request.params.id, request.body.resolution, request.body.note, staffId],
        );
        await recordAudit(client, request, {
          action: 'incident.resolved',
          targetType: 'incident',
          targetId: request.params.id,
          reason: request.body.note,
          before,
          after: { status: 'resolved', resolution: request.body.resolution },
        });
      });
      return toIncident((await load(request.params.id))!);
    },
  );
};
