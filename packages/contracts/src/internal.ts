import { z } from 'zod';
import { CommandTypeSchema } from './fleet';

/**
 * Internal gateway <-> API contract (authenticated with INTERNAL_API_TOKEN,
 * reachable on the private network only). Protocol-neutral: no supplier
 * packet formats appear here.
 */
export const InternalDeviceSchema = z.object({
  id: z.uuid(),
  supplierDeviceId: z.string(),
  adapter: z.enum(['simulated', 'supplier_tcp']),
  isSimulated: z.boolean(),
  scooterCode: z.string().nullable(),
  lastLat: z.number().nullable(),
  lastLng: z.number().nullable(),
  batteryPercent: z.number().int().nullable(),
  simulation: z.unknown().optional(),
});

export const InternalPendingCommandSchema = z.object({
  id: z.uuid(),
  supplierDeviceId: z.string(),
  type: CommandTypeSchema,
  deadlineAt: z.iso.datetime(),
});

export const InternalTelemetrySchema = z.object({
  supplierDeviceId: z.string().min(1).max(64),
  recordedAt: z.iso.datetime().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  batteryPercent: z.number().optional(),
  speedKmh: z.number().optional(),
  locked: z.boolean().optional(),
  /** Adapter-specific raw data for diagnostics (bounded). */
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const InternalTelemetryBatchSchema = z.object({
  reports: z.array(InternalTelemetrySchema).min(1).max(500),
});

export const InternalCommandResultSchema = z.object({
  outcome: z.enum(['ack', 'nack']),
  resultCode: z.string().max(64).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const InternalCommandResultResponseSchema = z.object({
  accepted: z.literal(true),
  late: z.boolean(),
  duplicate: z.boolean(),
});
