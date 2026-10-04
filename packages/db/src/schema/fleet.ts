import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, latCheck, lngCheck, ts, updatedAt } from './_common';
import { staffUsers } from './identity';

export const scooterStatus = pgEnum('scooter_status', [
  'available',
  'reserved',
  'in_ride',
  'maintenance',
  'charging',
  'missing',
  'retired',
]);
export const deviceAdapter = pgEnum('device_adapter', ['simulated', 'supplier_tcp']);
export const maintenanceKind = pgEnum('maintenance_kind', [
  'inspection',
  'repair',
  'battery_swap',
  'charging',
  'reposition',
  'other',
]);
export const taskStatus = pgEnum('task_status', ['open', 'in_progress', 'done', 'cancelled']);
export const zoneKind = pgEnum('zone_kind', [
  'service_area',
  'parking',
  'no_parking',
  'restricted',
  'slow',
]);

export const scooters = pgTable(
  'scooters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Short human code printed next to the QR code. */
    code: text('code').notNull(),
    /** Opaque value encoded in the QR code. */
    qrToken: text('qr_token').notNull(),
    model: text('model'),
    status: scooterStatus('status').notNull().default('maintenance'),
    batteryPercent: smallint('battery_percent'),
    lastLat: doublePrecision('last_lat'),
    lastLng: doublePrecision('last_lng'),
    lastLocationAt: ts('last_location_at'),
    lastTelemetryAt: ts('last_telemetry_at'),
    /** Optimistic-concurrency version, bumped on every state change. */
    version: integer('version').notNull().default(0),
    retiredAt: ts('retired_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('scooters_code_uq').on(t.code),
    uniqueIndex('scooters_qr_token_uq').on(t.qrToken),
    index('scooters_status_idx').on(t.status),
    index('scooters_location_idx').on(t.lastLat, t.lastLng),
    check('scooters_code_format', sql`${t.code} ~ '^[A-Z0-9-]{3,16}$'`),
    check(
      'scooters_battery_range',
      sql`${t.batteryPercent} is null or (${t.batteryPercent} between 0 and 100)`,
    ),
    latCheck('scooters_lat_range', t.lastLat),
    lngCheck('scooters_lng_range', t.lastLng),
    check('scooters_location_pair', sql`(${t.lastLat} is null) = (${t.lastLng} is null)`),
  ],
);

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Supplier's identifier for the IoT module (format from supplier docs). */
    supplierDeviceId: text('supplier_device_id').notNull(),
    adapter: deviceAdapter('adapter').notNull(),
    /** Immutable; must match the adapter. Simulated devices never serve real riders. */
    isSimulated: boolean('is_simulated').notNull(),
    firmwareVersion: text('firmware_version'),
    metadata: jsonb('metadata').notNull().default({}),
    online: boolean('online').notNull().default(false),
    lastSeenAt: ts('last_seen_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('devices_supplier_id_uq').on(t.supplierDeviceId),
    check(
      'devices_simulated_matches_adapter',
      sql`${t.isSimulated} = (${t.adapter} = 'simulated')`,
    ),
  ],
);

export const deviceAssignments = pgTable(
  'device_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    scooterId: uuid('scooter_id')
      .notNull()
      .references(() => scooters.id),
    assignedAt: createdAt(),
    unassignedAt: ts('unassigned_at'),
    assignedByStaffId: uuid('assigned_by_staff_id').references(() => staffUsers.id),
  },
  (t) => [
    uniqueIndex('device_assignments_active_device_uq')
      .on(t.deviceId)
      .where(sql`${t.unassignedAt} is null`),
    uniqueIndex('device_assignments_active_scooter_uq')
      .on(t.scooterId)
      .where(sql`${t.unassignedAt} is null`),
  ],
);

export const maintenanceRecords = pgTable(
  'maintenance_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scooterId: uuid('scooter_id')
      .notNull()
      .references(() => scooters.id),
    kind: maintenanceKind('kind').notNull(),
    status: taskStatus('status').notNull().default('open'),
    notes: text('notes'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staffUsers.id),
    assignedToStaffId: uuid('assigned_to_staff_id').references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('maintenance_records_scooter_idx').on(t.scooterId, t.createdAt),
    index('maintenance_records_open_idx')
      .on(t.assignedToStaffId)
      .where(sql`${t.status} in ('open','in_progress')`),
  ],
);

export const zones = pgTable(
  'zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: zoneKind('kind').notNull(),
    /** GeoJSON Polygon or MultiPolygon (WGS84, [lng, lat]). Validated by the API. */
    geometry: jsonb('geometry').notNull(),
    minLat: doublePrecision('min_lat').notNull(),
    minLng: doublePrecision('min_lng').notNull(),
    maxLat: doublePrecision('max_lat').notNull(),
    maxLng: doublePrecision('max_lng').notNull(),
    active: boolean('active').notNull().default(true),
    isDevFixture: boolean('is_dev_fixture').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdByStaffId: uuid('created_by_staff_id').references(() => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('zones_active_bbox_idx')
      .on(t.minLat, t.maxLat, t.minLng, t.maxLng)
      .where(sql`${t.active}`),
    check('zones_bbox_order', sql`${t.minLat} <= ${t.maxLat} and ${t.minLng} <= ${t.maxLng}`),
    latCheck('zones_min_lat', t.minLat),
    latCheck('zones_max_lat', t.maxLat),
    lngCheck('zones_min_lng', t.minLng),
    lngCheck('zones_max_lng', t.maxLng),
  ],
);

export const telemetry = pgTable(
  'device_telemetry',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    recordedAt: ts('recorded_at'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    batteryPercent: smallint('battery_percent'),
    /** Only when the supplier protocol reports it (null = unknown). */
    speedKmh: doublePrecision('speed_kmh'),
    locked: boolean('locked'),
    valid: boolean('valid').notNull(),
    invalidReason: text('invalid_reason'),
    isSimulated: boolean('is_simulated').notNull(),
    raw: jsonb('raw'),
  },
  (t) => [
    index('device_telemetry_device_time_idx').on(t.deviceId, t.receivedAt),
    latCheck('device_telemetry_lat', t.lat),
    lngCheck('device_telemetry_lng', t.lng),
    check(
      'device_telemetry_battery',
      sql`${t.batteryPercent} is null or (${t.batteryPercent} between 0 and 100)`,
    ),
  ],
);
