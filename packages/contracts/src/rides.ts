import { z } from 'zod';
import { SantimSchema } from './common';
import { ReasonSchema } from './staff';

export const RIDE_ERROR_CODES = {
  RIDE_ALREADY_ACTIVE: 'RIDE_ALREADY_ACTIVE',
  RIDE_NOT_FOUND: 'RIDE_NOT_FOUND',
  RIDE_INVALID_STATE: 'RIDE_INVALID_STATE',
  BALANCE_TOO_LOW: 'BALANCE_TOO_LOW',
  PRICING_NOT_CONFIGURED: 'PRICING_NOT_CONFIGURED',
  PAUSE_NOT_OFFERED: 'PAUSE_NOT_OFFERED',
  RESERVATIONS_NOT_OFFERED: 'RESERVATIONS_NOT_OFFERED',
  RESERVATION_ACTIVE: 'RESERVATION_ACTIVE',
  SCOOTER_NOT_STATIONARY: 'SCOOTER_NOT_STATIONARY',
  PARKING_NOT_ALLOWED: 'PARKING_NOT_ALLOWED',
  RIDER_NOT_ACTIVE: 'RIDER_NOT_ACTIVE',
} as const;

export const RideStatusSchema = z.enum([
  'start_requested',
  'unlock_pending',
  'active',
  'paused',
  'end_requested',
  'completion_pending',
  'completed',
  'start_failed',
  'operator_review',
]);
export const ParkingStatusSchema = z.enum(['ok', 'outside', 'unknown', 'not_checked']);

export const PricingSummarySchema = z.object({
  planId: z.uuid(),
  name: z.string(),
  /** True for development fixture pricing (never production prices). */
  isDevFixture: z.boolean(),
  currency: z.literal('ETB'),
  unlockFeeSantim: z.number().int(),
  perMinuteSantim: z.number().int(),
  billingIncrementSeconds: z.number().int(),
  pausePerMinuteSantim: z.number().int().nullable(),
  maxPauseMinutes: z.number().int().nullable(),
  minStartBalanceSantim: z.number().int(),
  holdAmountSantim: z.number().int(),
  reservationMinutes: z.number().int().nullable(),
  reservationFeeSantim: z.number().int().nullable(),
  maxRideMinutes: z.number().int().nullable(),
  lowBalanceFloorSantim: z.number().int(),
});

/** Identify the scooter by id, printed code or QR token (exactly one). */
export const StartRideSchema = z
  .object({
    scooterId: z.uuid().optional(),
    code: z.string().trim().min(1).max(32).optional(),
    qr: z.string().trim().min(8).max(200).optional(),
  })
  .refine((v) => [v.scooterId, v.code, v.qr].filter((x) => x !== undefined).length === 1, {
    message: 'Provide exactly one of scooterId, code or qr.',
  });

export const EndRideSchema = z.object({
  /** The rider's phone location (the device location is preferred when fresh). */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const FareSchema = z.object({
  unlockFeeSantim: z.number().int(),
  ridingSeconds: z.number().int(),
  ridingSantim: z.number().int(),
  pausedSeconds: z.number().int(),
  pausedSantim: z.number().int(),
  totalSantim: z.number().int(),
});

export const RideSchema = z.object({
  id: z.uuid(),
  status: RideStatusSchema,
  scooterId: z.uuid(),
  scooterCode: z.string(),
  isSimulated: z.boolean(),
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  endRequestedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  billingCutoffAt: z.iso.datetime().nullable(),
  pausedSince: z.iso.datetime().nullable(),
  pausedSeconds: z.number().int(),
  parkingStatus: ParkingStatusSchema,
  /** Final fare (completed rides) or a running estimate (open rides). */
  fare: FareSchema.nullable(),
  fareIsEstimate: z.boolean(),
  chargedSantim: z.number().int().nullable(),
  unpaidSantim: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  pricing: PricingSummarySchema,
});

export const RideHistoryQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const CurrentRideSchema = z.object({ ride: RideSchema.nullable() });

export const ReservationSchema = z.object({
  id: z.uuid(),
  scooterId: z.uuid(),
  scooterCode: z.string(),
  status: z.enum(['active', 'expired', 'cancelled', 'converted']),
  expiresAt: z.iso.datetime(),
  feeSantim: z.number().int(),
});
export const CreateReservationSchema = z.object({ scooterId: z.uuid() });
export const CurrentReservationSchema = z.object({ reservation: ReservationSchema.nullable() });

// --- Staff ---------------------------------------------------------------

export const RideEventSchema = z.object({
  id: z.number().int(),
  fromStatus: RideStatusSchema.nullable(),
  toStatus: RideStatusSchema,
  cause: z.enum(['rider', 'device', 'timeout', 'operator', 'system']),
  actorStaffId: z.uuid().nullable(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});

export const StaffRideSchema = RideSchema.extend({
  riderId: z.uuid(),
  deviceId: z.uuid(),
});
export const StaffRideDetailSchema = z.object({
  ride: StaffRideSchema,
  events: z.array(RideEventSchema),
});
export const StaffRidesQuerySchema = z.object({
  status: RideStatusSchema.optional(),
  riderId: z.uuid().optional(),
  scooterId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Send an open ride to operator review (e.g. rider cannot end it). */
export const RideReviewSchema = z.object({ reason: ReasonSchema });

/** Resolve a ride in operator review. */
export const RideResolveSchema = z.object({
  action: z.enum(['complete', 'complete_no_charge']),
  /** Billing cutoff chosen by the operator (defaults to the end request, else now). */
  endedAt: z.iso.datetime().optional(),
  reason: ReasonSchema,
});

export const PricingPlanCreateSchema = z.object({
  name: z.string().trim().min(3).max(100),
  unlockFeeSantim: SantimSchema,
  perMinuteSantim: SantimSchema,
  billingIncrementSeconds: z.number().int().min(1).max(3_600),
  pausePerMinuteSantim: SantimSchema.nullable(),
  maxPauseMinutes: z.number().int().positive().nullable(),
  minStartBalanceSantim: SantimSchema,
  holdAmountSantim: SantimSchema,
  reservationMinutes: z.number().int().positive().nullable(),
  reservationFeeSantim: SantimSchema.nullable(),
  maxRideMinutes: z.number().int().positive().nullable(),
  lowBalanceFloorSantim: z.number().int().max(0).min(-Number.MAX_SAFE_INTEGER),
  reason: ReasonSchema,
});

export const PricingPlanSchema = PricingSummarySchema.extend({
  status: z.enum(['draft', 'active', 'retired']),
  activatedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
