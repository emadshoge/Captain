import { z } from 'zod';
import { ReasonSchema } from './staff';

export const ScooterStatusSchema = z.enum([
  'available',
  'reserved',
  'in_ride',
  'maintenance',
  'charging',
  'missing',
  'retired',
]);
export const ZoneKindSchema = z.enum([
  'service_area',
  'parking',
  'no_parking',
  'restricted',
  'slow',
]);
export const MaintenanceKindSchema = z.enum([
  'inspection',
  'repair',
  'battery_swap',
  'charging',
  'reposition',
  'other',
]);
export const TaskStatusSchema = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export const CommandTypeSchema = z.enum(['unlock', 'lock', 'locate']);
export const CommandStatusSchema = z.enum([
  'queued',
  'sent',
  'acked',
  'nacked',
  'timed_out',
  'failed',
  'cancelled',
]);

export const FLEET_ERROR_CODES = {
  SCOOTER_NOT_FOUND: 'SCOOTER_NOT_FOUND',
  SCOOTER_UNAVAILABLE: 'SCOOTER_UNAVAILABLE',
  DEVICE_NOT_ASSIGNED: 'DEVICE_NOT_ASSIGNED',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  COMMAND_UNSAFE: 'COMMAND_UNSAFE',
  COMMAND_UNSUPPORTED: 'COMMAND_UNSUPPORTED',
  INVALID_GEOMETRY: 'INVALID_GEOMETRY',
  SIMULATED_NOT_ALLOWED: 'SIMULATED_NOT_ALLOWED',
} as const;

/** Why a scooter cannot be rented right now (shown to riders in plain language). */
export const UnavailableReasonSchema = z.enum([
  'in_use',
  'reserved',
  'maintenance',
  'low_battery',
  'offline',
  'stale_location',
  'not_in_service',
]);

const Coordinate = {
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
};

export const NearbyQuerySchema = z.object({
  ...Coordinate,
  radiusM: z.coerce.number().int().min(50).max(3_000).default(1_000),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const RiderScooterSchema = z.object({
  code: z.string(),
  model: z.string().nullable(),
  batteryPercent: z.number().int().nullable(),
  lat: z.number(),
  lng: z.number(),
  distanceM: z.number().int(),
  lastUpdateAt: z.iso.datetime(),
  /** Seconds since the location was reported. */
  ageSeconds: z.number().int(),
});

export const ScooterLookupQuerySchema = z
  .object({ code: z.string().trim().max(32).optional(), qr: z.string().trim().max(200).optional() })
  .refine((q) => Boolean(q.code) !== Boolean(q.qr), 'provide exactly one of code or qr');

export const ScooterLookupSchema = z.object({
  code: z.string(),
  model: z.string().nullable(),
  available: z.boolean(),
  unavailableReason: UnavailableReasonSchema.nullable(),
  batteryPercent: z.number().int().nullable(),
  lastUpdateAt: z.iso.datetime().nullable(),
});

export const GeometrySchema = z.object({
  type: z.enum(['Polygon', 'MultiPolygon']),
  coordinates: z.array(z.unknown()),
});

export const ZoneSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: ZoneKindSchema,
  geometry: GeometrySchema,
  active: z.boolean(),
  version: z.number().int(),
  isDevFixture: z.boolean(),
});

export const ZonesQuerySchema = z.object({
  minLat: z.coerce.number().min(-90).max(90),
  minLng: z.coerce.number().min(-180).max(180),
  maxLat: z.coerce.number().min(-90).max(90),
  maxLng: z.coerce.number().min(-180).max(180),
});

export const CreateZoneSchema = z.object({
  name: z.string().trim().min(2).max(120),
  kind: ZoneKindSchema,
  geometry: GeometrySchema,
  reason: ReasonSchema,
});

export const UpdateZoneSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  geometry: GeometrySchema.optional(),
  active: z.boolean().optional(),
  reason: ReasonSchema,
});

export const DeviceSummarySchema = z.object({
  id: z.uuid(),
  supplierDeviceId: z.string(),
  adapter: z.enum(['simulated', 'supplier_tcp']),
  isSimulated: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  firmwareVersion: z.string().nullable(),
});

export const OperatorScooterSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  status: ScooterStatusSchema,
  model: z.string().nullable(),
  batteryPercent: z.number().int().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  lastTelemetryAt: z.iso.datetime().nullable(),
  stale: z.boolean(),
  device: DeviceSummarySchema.nullable(),
  openAlerts: z.number().int(),
});

export const OperatorScooterQuerySchema = z.object({
  status: ScooterStatusSchema.optional(),
  q: z.string().trim().max(32).optional(),
  batteryBelow: z.coerce.number().int().min(1).max(100).optional(),
  stale: z.enum(['true', 'false']).optional(),
  simulated: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const TelemetryPointSchema = z.object({
  receivedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  batteryPercent: z.number().int().nullable(),
  speedKmh: z.number().nullable(),
  locked: z.boolean().nullable(),
  valid: z.boolean(),
  invalidReason: z.string().nullable(),
});

export const AlertSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'critical']),
  status: z.enum(['open', 'acknowledged', 'resolved']),
  scooterId: z.uuid().nullable(),
  scooterCode: z.string().nullable(),
  deviceId: z.uuid().nullable(),
  rideId: z.uuid().nullable(),
  data: z.unknown(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const MaintenanceSchema = z.object({
  id: z.uuid(),
  scooterId: z.uuid(),
  scooterCode: z.string(),
  kind: MaintenanceKindSchema,
  status: TaskStatusSchema,
  notes: z.string().nullable(),
  assignedToStaffId: z.uuid().nullable(),
  createdByStaffId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});

export const CommandSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  rideId: z.uuid().nullable(),
  type: CommandTypeSchema,
  status: CommandStatusSchema,
  issuedBy: z.enum(['system', 'staff', 'rider']),
  reason: z.string().nullable(),
  isSimulated: z.boolean(),
  createdAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resultCode: z.string().nullable(),
});

export const OperatorScooterDetailSchema = OperatorScooterSchema.extend({
  qrToken: z.string(),
  recentTelemetry: z.array(TelemetryPointSchema),
  alerts: z.array(AlertSchema),
  maintenance: z.array(MaintenanceSchema),
  commands: z.array(CommandSchema),
});

export const OperatorStatusUpdateSchema = z.object({
  status: z.enum(['available', 'maintenance', 'charging', 'missing']),
  reason: ReasonSchema,
});

export const CreateScooterSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9-]{3,16}$/),
  model: z.string().trim().max(80).optional(),
  reason: ReasonSchema,
});

export const RegisterDeviceSchema = z.object({
  supplierDeviceId: z.string().trim().min(3).max(64),
  adapter: z.enum(['simulated', 'supplier_tcp']),
  firmwareVersion: z.string().trim().max(40).optional(),
  reason: ReasonSchema,
});

export const AssignDeviceSchema = z.object({ deviceId: z.uuid(), reason: ReasonSchema });

export const CreateMaintenanceSchema = z.object({
  scooterId: z.uuid(),
  kind: MaintenanceKindSchema,
  notes: z.string().trim().max(2_000).optional(),
  assignedToStaffId: z.uuid().optional(),
});

export const UpdateMaintenanceSchema = z.object({
  status: TaskStatusSchema.optional(),
  notes: z.string().trim().max(2_000).optional(),
  assignedToStaffId: z.uuid().nullable().optional(),
});

export const ServiceCommandSchema = z.object({ type: CommandTypeSchema, reason: ReasonSchema });

/** Development/test only: scripted outcomes for a simulated device. */
export const SimulationScenarioSchema = z.object({
  unlock: z.enum(['ack', 'nack', 'silence']).default('ack'),
  lock: z.enum(['ack', 'nack', 'silence']).default('ack'),
  locate: z.enum(['ack', 'nack', 'silence']).default('ack'),
  delayMs: z.number().int().min(0).max(120_000).default(500),
  /** Simulated movement (km/h) reported in telemetry; > 0 makes lock unsafe. */
  speedKmh: z.number().min(0).max(60).default(0),
});
