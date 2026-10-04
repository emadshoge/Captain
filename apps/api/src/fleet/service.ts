import type { ApiConfig } from '@captain/config';
import { FLEET_ERROR_CODES } from '@captain/contracts';
import { distanceMeters, isValidLatLng, pointInGeometry, type ZoneGeometry } from '@captain/domain';
import type pg from 'pg';
import { AppError } from '../errors';
import { type Queryable, one, withTransaction } from '../lib/db';

export type UnavailableReason =
  | 'in_use'
  | 'reserved'
  | 'maintenance'
  | 'low_battery'
  | 'offline'
  | 'stale_location'
  | 'not_in_service';

export interface FleetDeps {
  config: ApiConfig;
  pool: pg.Pool;
  now: () => Date;
}

/** Scooter joined with its currently assigned device. */
export interface ScooterRow {
  id: string;
  code: string;
  qr_token: string;
  model: string | null;
  status: string;
  battery_percent: number | null;
  last_lat: number | null;
  last_lng: number | null;
  last_telemetry_at: Date | null;
  device_id: string | null;
  supplier_device_id: string | null;
  adapter: 'simulated' | 'supplier_tcp' | null;
  is_simulated: boolean | null;
  online: boolean | null;
  last_seen_at: Date | null;
  firmware_version: string | null;
}

export const SCOOTER_SELECT = `
  select s.id, s.code, s.qr_token, s.model, s.status::text as status, s.battery_percent, s.last_lat, s.last_lng,
         s.last_telemetry_at, d.id as device_id, d.supplier_device_id, d.adapter::text as adapter, d.is_simulated,
         d.online, d.last_seen_at, d.firmware_version
  from scooters s
  left join device_assignments a on a.scooter_id = s.id and a.unassigned_at is null
  left join devices d on d.id = a.device_id`;

/**
 * Why a scooter cannot be rented now, or null if it can. The same rule is
 * used for the map, QR lookup and ride start (Phase 8).
 */
export function unavailableReason(
  row: ScooterRow,
  config: ApiConfig,
  now: Date,
): UnavailableReason | null {
  switch (row.status) {
    case 'in_ride':
      return 'in_use';
    case 'reserved':
      return 'reserved';
    case 'maintenance':
    case 'charging':
      return 'maintenance';
    case 'missing':
    case 'retired':
      return 'not_in_service';
  }
  if (!row.device_id || !row.online) return 'offline';
  // Simulated hardware never serves riders in production.
  if (config.APP_ENV === 'production' && row.is_simulated) return 'not_in_service';
  if (
    row.last_lat === null ||
    row.last_telemetry_at === null ||
    now.getTime() - row.last_telemetry_at.getTime() > config.FLEET_TELEMETRY_STALE_SECONDS * 1000
  ) {
    return 'stale_location';
  }
  if (row.battery_percent === null || row.battery_percent < config.FLEET_MIN_RIDEABLE_BATTERY)
    return 'low_battery';
  return null;
}

export function isStale(
  row: Pick<ScooterRow, 'last_telemetry_at'>,
  config: ApiConfig,
  now: Date,
): boolean {
  return (
    row.last_telemetry_at === null ||
    now.getTime() - row.last_telemetry_at.getTime() > config.FLEET_TELEMETRY_STALE_SECONDS * 1000
  );
}

// ---------------------------------------------------------------------------
// Rider discovery
// ---------------------------------------------------------------------------

export async function nearbyScooters(
  deps: FleetDeps,
  center: { lat: number; lng: number },
  radiusM: number,
  limit: number,
) {
  const now = deps.now();
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  const { rows } = await deps.pool.query<ScooterRow>(
    `${SCOOTER_SELECT}
     where s.status = 'available' and s.last_lat between $1 and $2 and s.last_lng between $3 and $4`,
    [center.lat - dLat, center.lat + dLat, center.lng - dLng, center.lng + dLng],
  );
  return rows
    .filter((row) => unavailableReason(row, deps.config, now) === null)
    .map((row) => ({
      row,
      distance: distanceMeters(center, { lat: row.last_lat!, lng: row.last_lng! }),
    }))
    .filter((entry) => entry.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ row, distance }) => ({
      code: row.code,
      model: row.model,
      batteryPercent: row.battery_percent,
      lat: row.last_lat!,
      lng: row.last_lng!,
      distanceM: Math.round(distance),
      lastUpdateAt: row.last_telemetry_at!.toISOString(),
      ageSeconds: Math.max(
        0,
        Math.floor((now.getTime() - row.last_telemetry_at!.getTime()) / 1000),
      ),
    }));
}

export async function findScooter(q: Queryable, by: { code?: string; qr?: string; id?: string }) {
  const [column, value] = by.id
    ? ['s.id', by.id]
    : by.code
      ? ['s.code', by.code.toUpperCase()]
      : ['s.qr_token', by.qr];
  return one<ScooterRow>(q, `${SCOOTER_SELECT} where ${column} = $1`, [value]);
}

export async function requireScooter(
  q: Queryable,
  by: { code?: string; qr?: string; id?: string },
) {
  const row = await findScooter(q, by);
  if (!row)
    throw new AppError(
      404,
      FLEET_ERROR_CODES.SCOOTER_NOT_FOUND,
      'Scooter not found. Check the code and try again.',
    );
  return row;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface ZoneRow {
  id: string;
  name: string;
  kind: 'service_area' | 'parking' | 'no_parking' | 'restricted' | 'slow';
  geometry: ZoneGeometry;
  active: boolean;
  version: number;
  is_dev_fixture: boolean;
}

export async function zonesContaining(
  q: Queryable,
  point: { lat: number; lng: number },
): Promise<ZoneRow[]> {
  const { rows } = await q.query<ZoneRow>(
    `select id, name, kind::text as kind, geometry, active, version, is_dev_fixture from zones
     where active and min_lat <= $1 and max_lat >= $1 and min_lng <= $2 and max_lng >= $2`,
    [point.lat, point.lng],
  );
  return rows.filter((zone) => pointInGeometry(point, zone.geometry));
}

/**
 * Zone status of a point. When no service area is configured at all,
 * `inServiceArea` is null (unknown) rather than false: zones are an open
 * business decision (D-ZONES) and the absence of data is not a violation.
 */
export async function zoneStatus(q: Queryable, point: { lat: number; lng: number }) {
  const zones = await zonesContaining(q, point);
  const anyServiceArea = await one(
    q,
    `select 1 from zones where active and kind = 'service_area' limit 1`,
  );
  return {
    inServiceArea: anyServiceArea ? zones.some((z) => z.kind === 'service_area') : null,
    inParking: zones.some((z) => z.kind === 'parking'),
    inRestricted: zones.some((z) => z.kind === 'restricted' || z.kind === 'no_parking'),
    zoneIds: zones.map((z) => z.id),
  };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertInput {
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  dedupeKey: string;
  scooterId?: string | null;
  deviceId?: string | null;
  rideId?: string | null;
  data?: Record<string, unknown>;
}

/** Opens an alert unless an unresolved one with the same dedupe key exists. */
export async function openAlert(q: Queryable, alert: AlertInput): Promise<void> {
  await q.query(
    `insert into operational_alerts (kind, severity, dedupe_key, scooter_id, device_id, ride_id, data)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (dedupe_key) where status <> 'resolved' do nothing`,
    [
      alert.kind,
      alert.severity,
      alert.dedupeKey,
      alert.scooterId ?? null,
      alert.deviceId ?? null,
      alert.rideId ?? null,
      JSON.stringify(alert.data ?? {}),
    ],
  );
}

export async function resolveAlert(q: Queryable, dedupeKey: string, now: Date): Promise<void> {
  await q.query(
    `update operational_alerts set status = 'resolved', resolved_at = $2 where dedupe_key = $1 and status <> 'resolved'`,
    [dedupeKey, now],
  );
}

// ---------------------------------------------------------------------------
// Telemetry ingestion
// ---------------------------------------------------------------------------

export interface TelemetryReport {
  supplierDeviceId: string;
  recordedAt?: string;
  lat?: number;
  lng?: number;
  batteryPercent?: number;
  speedKmh?: number;
  locked?: boolean;
  raw?: Record<string, unknown>;
}

const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_REPORT_AGE_MS = 24 * 3_600_000;

/** Validates a report. Invalid data is stored for diagnosis but never moves the scooter. */
export function validateTelemetry(report: TelemetryReport, now: Date): string | null {
  const hasLat = report.lat !== undefined;
  const hasLng = report.lng !== undefined;
  if (hasLat !== hasLng) return 'lat_lng_pair';
  if (hasLat && !isValidLatLng(report.lat!, report.lng!)) return 'invalid_coordinates';
  if (
    report.batteryPercent !== undefined &&
    !(report.batteryPercent >= 0 && report.batteryPercent <= 100)
  ) {
    return 'invalid_battery';
  }
  if (report.speedKmh !== undefined && !(report.speedKmh >= 0 && report.speedKmh < 150))
    return 'invalid_speed';
  if (report.recordedAt !== undefined) {
    const t = Date.parse(report.recordedAt);
    if (t > now.getTime() + MAX_CLOCK_SKEW_MS) return 'recorded_in_future';
    if (t < now.getTime() - MAX_REPORT_AGE_MS) return 'recorded_too_old';
  }
  return null;
}

export type IngestOutcome = 'stored' | 'stored_out_of_order' | 'invalid' | 'unknown_device';

export async function ingestTelemetry(
  deps: FleetDeps,
  report: TelemetryReport,
): Promise<IngestOutcome> {
  const now = deps.now();
  return withTransaction(deps.pool, async (client) => {
    const device = await one<{ id: string; is_simulated: boolean; scooter_id: string | null }>(
      client,
      `select d.id, d.is_simulated, a.scooter_id from devices d
       left join device_assignments a on a.device_id = d.id and a.unassigned_at is null
       where d.supplier_device_id = $1 for update of d`,
      [report.supplierDeviceId],
    );
    if (!device) return 'unknown_device';

    const invalidReason = validateTelemetry(report, now);
    const valid = invalidReason === null;
    const recordedAt = report.recordedAt ? new Date(report.recordedAt) : now;
    const raw = report.raw ? JSON.stringify(report.raw).slice(0, 4_000) : null;
    await client.query(
      `insert into device_telemetry (device_id, recorded_at, received_at, lat, lng, battery_percent, speed_kmh, locked,
         valid, invalid_reason, is_simulated, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        device.id,
        report.recordedAt ? recordedAt : null,
        now,
        valid ? (report.lat ?? null) : null,
        valid ? (report.lng ?? null) : null,
        valid && report.batteryPercent !== undefined ? Math.round(report.batteryPercent) : null,
        valid ? (report.speedKmh ?? null) : null,
        report.locked ?? null,
        valid,
        invalidReason,
        device.is_simulated,
        raw === null ? null : JSON.stringify({ truncated: raw.length >= 4_000, data: report.raw }),
      ],
    );
    // Any contact proves the device is reachable.
    await client.query(
      `update devices set online = true, last_seen_at = $2, updated_at = $2 where id = $1`,
      [device.id, now],
    );
    await resolveAlert(client, `device_offline:${device.id}`, now);

    if (!valid) {
      await openAlert(client, {
        kind: 'invalid_telemetry',
        severity: 'warning',
        dedupeKey: `invalid_telemetry:${device.id}`,
        deviceId: device.id,
        scooterId: device.scooter_id,
        data: { reason: invalidReason },
      });
      return 'invalid';
    }
    await resolveAlert(client, `invalid_telemetry:${device.id}`, now);
    if (!device.scooter_id) return 'stored';

    const scooter = await one<{ last_telemetry_at: Date | null }>(
      client,
      `select last_telemetry_at from scooters where id = $1 for update`,
      [device.scooter_id],
    );
    if (scooter?.last_telemetry_at && recordedAt < scooter.last_telemetry_at) {
      // Older than what we already know: keep the row, do not move the scooter back.
      return 'stored_out_of_order';
    }
    const hasLocation = report.lat !== undefined;
    await client.query(
      `update scooters set
         battery_percent = coalesce($2, battery_percent),
         last_lat = case when $3::double precision is null then last_lat else $3 end,
         last_lng = case when $4::double precision is null then last_lng else $4 end,
         last_location_at = case when $3::double precision is null then last_location_at else $5 end,
         last_telemetry_at = $5, updated_at = $6
       where id = $1`,
      [
        device.scooter_id,
        report.batteryPercent === undefined ? null : Math.round(report.batteryPercent),
        hasLocation ? report.lat : null,
        hasLocation ? report.lng : null,
        recordedAt,
        now,
      ],
    );
    await resolveAlert(client, `stale_telemetry:${device.scooter_id}`, now);

    if (report.batteryPercent !== undefined) {
      if (report.batteryPercent < deps.config.FLEET_LOW_BATTERY_PERCENT) {
        await openAlert(client, {
          kind: 'low_battery',
          severity:
            report.batteryPercent < deps.config.FLEET_MIN_RIDEABLE_BATTERY ? 'critical' : 'warning',
          dedupeKey: `low_battery:${device.scooter_id}`,
          scooterId: device.scooter_id,
          deviceId: device.id,
          data: { batteryPercent: Math.round(report.batteryPercent) },
        });
      } else if (report.batteryPercent >= deps.config.FLEET_LOW_BATTERY_PERCENT + 5) {
        await resolveAlert(client, `low_battery:${device.scooter_id}`, now);
      }
    }
    if (hasLocation) {
      const status = await zoneStatus(client, { lat: report.lat!, lng: report.lng! });
      if (status.inServiceArea === false) {
        await openAlert(client, {
          kind: 'outside_service_area',
          severity: 'warning',
          dedupeKey: `outside_service_area:${device.scooter_id}`,
          scooterId: device.scooter_id,
          deviceId: device.id,
          data: { lat: report.lat, lng: report.lng },
        });
      } else if (status.inServiceArea === true) {
        await resolveAlert(client, `outside_service_area:${device.scooter_id}`, now);
      }
    }
    return 'stored';
  });
}

// ---------------------------------------------------------------------------
// Device commands
// ---------------------------------------------------------------------------

export type CommandType = 'unlock' | 'lock' | 'locate';

export interface CommandRow {
  id: string;
  device_id: string;
  ride_id: string | null;
  type: CommandType;
  status: 'queued' | 'sent' | 'acked' | 'nacked' | 'timed_out' | 'failed' | 'cancelled';
  issued_by: 'system' | 'staff' | 'rider';
  reason: string | null;
  is_simulated: boolean;
  deadline_at: Date;
  created_at: Date;
  resolved_at: Date | null;
  result_code: string | null;
}

/** Listeners for command outcomes (the ride engine subscribes in Phase 8). */
export type CommandListener = (
  client: pg.PoolClient,
  command: CommandRow,
  event: { outcome: 'ack' | 'nack' | 'timeout'; late: boolean },
  now: Date,
) => Promise<void>;

const commandListeners: CommandListener[] = [];
export function onCommandResolved(listener: CommandListener) {
  commandListeners.push(listener);
}

export async function createCommand(
  q: Queryable,
  input: {
    deviceId: string;
    type: CommandType;
    issuedBy: 'system' | 'staff' | 'rider';
    staffId?: string | null;
    rideId?: string | null;
    reason?: string | null;
  },
  now: Date,
  timeoutSeconds: number,
): Promise<CommandRow> {
  const row = await one<CommandRow>(
    q,
    `insert into device_commands (device_id, ride_id, type, issued_by, issued_by_staff_id, reason, is_simulated, deadline_at, created_at)
     select $1, $2, $3, $4, $5, $6, d.is_simulated, $7, $8 from devices d where d.id = $1
     returning *`,
    [
      input.deviceId,
      input.rideId ?? null,
      input.type,
      input.issuedBy,
      input.staffId ?? null,
      input.reason ?? null,
      new Date(now.getTime() + timeoutSeconds * 1000),
      now,
    ],
  );
  return row!;
}

/** Hands queued commands for one adapter to the gateway (marks them sent). */
export async function fetchPendingCommands(
  pool: pg.Pool,
  adapter: 'simulated' | 'supplier_tcp',
  now: Date,
  limit = 50,
) {
  const { rows } = await pool.query<{
    id: string;
    supplier_device_id: string;
    type: CommandType;
    deadline_at: Date;
  }>(
    `with picked as (
       select c.id from device_commands c join devices d on d.id = c.device_id
       where c.status = 'queued' and c.deadline_at > $2 and d.adapter = $1
       order by c.created_at limit $3 for update of c skip locked)
     update device_commands c set status = 'sent', sent_at = $2
     from picked, devices d where c.id = picked.id and d.id = c.device_id
     returning c.id, d.supplier_device_id, c.type::text as type, c.deadline_at`,
    [adapter, now, limit],
  );
  return rows;
}

export interface CommandResultInput {
  outcome: 'ack' | 'nack';
  resultCode?: string;
  payload?: Record<string, unknown>;
}

/**
 * Records a device acknowledgment. Idempotent:
 * - first result before the deadline resolves the command;
 * - a result after the deadline (or after a timeout) is recorded as LATE and
 *   raises an incident for unlock commands. No physical command is ever sent
 *   automatically in response (R-22);
 * - repeated results are recorded as duplicates and change nothing.
 */
export async function recordCommandResult(
  deps: FleetDeps,
  commandId: string,
  input: CommandResultInput,
) {
  const now = deps.now();
  return withTransaction(deps.pool, async (client) => {
    const command = await one<CommandRow>(
      client,
      `select * from device_commands where id = $1 for update`,
      [commandId],
    );
    if (!command) return null;
    let late = false;
    let duplicate = false;
    let resolved = command;

    if (command.status === 'queued' || command.status === 'sent') {
      if (now > command.deadline_at) {
        late = true;
        resolved = (await one<CommandRow>(
          client,
          `update device_commands set status = 'timed_out', resolved_at = $2 where id = $1 returning *`,
          [command.id, now],
        ))!;
        for (const listener of commandListeners)
          await listener(client, resolved, { outcome: 'timeout', late: false }, now);
      } else {
        resolved = (await one<CommandRow>(
          client,
          `update device_commands set status = $2, resolved_at = $3, result_code = $4, result_payload = $5
           where id = $1 returning *`,
          [
            command.id,
            input.outcome === 'ack' ? 'acked' : 'nacked',
            now,
            input.resultCode ?? null,
            JSON.stringify({ ...(input.payload ?? {}), simulated: command.is_simulated }),
          ],
        ))!;
        for (const listener of commandListeners)
          await listener(client, resolved, { outcome: input.outcome, late: false }, now);
      }
    } else if (command.status === 'timed_out') {
      late = true;
    } else {
      duplicate = true;
    }

    await client.query(
      `insert into device_command_acks (command_id, outcome, late, duplicate, payload, created_at) values ($1,$2,$3,$4,$5,$6)`,
      [command.id, input.outcome, late, duplicate, JSON.stringify(input.payload ?? {}), now],
    );

    if (late) {
      const scooter = await one<{ scooter_id: string }>(
        client,
        `select scooter_id from device_assignments where device_id = $1 and unassigned_at is null`,
        [command.device_id],
      );
      if (command.type === 'unlock' && input.outcome === 'ack') {
        // The scooter may now be physically unlocked although we treated the
        // command as failed. Escalate to a human; never auto-lock (R-22, R-23).
        await client.query(
          `insert into incidents (kind, ride_id, scooter_id, device_id, reported_by_type, description, is_simulated)
           values ('late_unlock_ack', $1, $2, $3, 'system', $4, $5)`,
          [
            command.ride_id,
            scooter?.scooter_id ?? null,
            command.device_id,
            'Unlock acknowledged after the command timed out. Check the scooter physically; no automatic action was taken.',
            command.is_simulated,
          ],
        );
      }
      for (const listener of commandListeners) {
        await listener(client, resolved, { outcome: input.outcome, late: true }, now);
      }
    }
    return { late, duplicate, command: resolved };
  });
}

// ---------------------------------------------------------------------------
// Service commands issued by staff
// ---------------------------------------------------------------------------

/**
 * Motion safety (architecture §9, R-23): commands that can lock wheels or
 * change propulsion are only allowed when the device is known to be
 * stationary. Real supplier devices have no documented stationary check yet,
 * so those commands are refused for them.
 */
export async function assertServiceCommandAllowed(
  deps: FleetDeps,
  scooter: ScooterRow,
  type: CommandType,
): Promise<void> {
  if (!scooter.device_id) {
    throw new AppError(
      409,
      FLEET_ERROR_CODES.DEVICE_NOT_ASSIGNED,
      'This scooter has no device assigned.',
    );
  }
  if (!scooter.online)
    throw new AppError(409, FLEET_ERROR_CODES.DEVICE_OFFLINE, 'The device is offline.');
  if (type === 'locate') return;

  if (scooter.status === 'in_ride' || scooter.status === 'reserved') {
    throw new AppError(
      409,
      FLEET_ERROR_CODES.COMMAND_UNSAFE,
      'The scooter is reserved or in a ride.',
    );
  }
  if (scooter.adapter !== 'simulated') {
    throw new AppError(
      409,
      FLEET_ERROR_CODES.COMMAND_UNSUPPORTED,
      'Lock/unlock for this device needs the supplier protocol and its stationary check (not available yet).',
    );
  }
  const latest = await one<{ speed_kmh: number | null; received_at: Date }>(
    deps.pool,
    `select speed_kmh, received_at from device_telemetry where device_id = $1 and valid
     order by received_at desc, id desc limit 1`,
    [scooter.device_id],
  );
  const fresh =
    latest &&
    deps.now().getTime() - latest.received_at.getTime() <=
      deps.config.FLEET_TELEMETRY_STALE_SECONDS * 1000;
  if (!fresh || latest.speed_kmh === null || latest.speed_kmh > 0) {
    throw new AppError(
      409,
      FLEET_ERROR_CODES.COMMAND_UNSAFE,
      'The scooter is not confirmed stationary (recent speed 0 required).',
    );
  }
  if (type === 'unlock' && scooter.status !== 'maintenance' && scooter.status !== 'charging') {
    throw new AppError(
      409,
      FLEET_ERROR_CODES.COMMAND_UNSAFE,
      'Set the scooter to maintenance or charging before a service unlock.',
    );
  }
}
