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
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  currency,
  currencyIsEtb,
  latCheck,
  lngCheck,
  santim,
  ts,
  updatedAt,
} from './_common';
import { devices, scooters } from './fleet';
import { riders, staffUsers } from './identity';

export const pricingStatus = pgEnum('pricing_status', ['draft', 'active', 'retired']);

/**
 * Versioned pricing. Once a plan leaves `draft` its numbers are immutable
 * (database trigger); every ride stores a snapshot. Values for production are
 * unresolved business decisions (D-PRICE, D-ROUND, D-MINBAL, D-RESERVE,
 * D-PAUSE, D-MAXRIDE, D-LOWBAL); development fixtures set `is_dev_fixture`.
 */
export const pricingPlans = pgTable(
  'pricing_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: pricingStatus('status').notNull().default('draft'),
    isDevFixture: boolean('is_dev_fixture').notNull().default(false),
    currency: currency(),
    unlockFeeSantim: santim('unlock_fee_santim').notNull(),
    perMinuteSantim: santim('per_minute_santim').notNull(),
    /** Billing granularity: 60 = per started minute, 1 = per second. */
    billingIncrementSeconds: integer('billing_increment_seconds').notNull(),
    /** Null = pausing not offered. */
    pausePerMinuteSantim: santim('pause_per_minute_santim'),
    maxPauseMinutes: integer('max_pause_minutes'),
    minStartBalanceSantim: santim('min_start_balance_santim').notNull(),
    holdAmountSantim: santim('hold_amount_santim').notNull().default(0),
    /** Null = reservations not offered. */
    reservationMinutes: integer('reservation_minutes'),
    reservationFeeSantim: santim('reservation_fee_santim'),
    /** Null = no limit. Reaching it alerts only; never a hardware action. */
    maxRideMinutes: integer('max_ride_minutes'),
    /** Lowest balance a ride may drive the wallet to (<= 0). */
    lowBalanceFloorSantim: santim('low_balance_floor_santim').notNull().default(0),
    activatedAt: ts('activated_at'),
    retiredAt: ts('retired_at'),
    createdByStaffId: uuid('created_by_staff_id').references(() => staffUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('pricing_plans_single_active_uq')
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    currencyIsEtb(t, 'pricing_plans_currency'),
    check(
      'pricing_plans_amounts',
      sql`${t.unlockFeeSantim} >= 0 and ${t.perMinuteSantim} >= 0 and ${t.minStartBalanceSantim} >= 0
        and ${t.holdAmountSantim} >= 0 and coalesce(${t.pausePerMinuteSantim}, 0) >= 0
        and coalesce(${t.reservationFeeSantim}, 0) >= 0 and ${t.lowBalanceFloorSantim} <= 0`,
    ),
    check('pricing_plans_increment', sql`${t.billingIncrementSeconds} between 1 and 3600`),
    check(
      'pricing_plans_durations',
      sql`coalesce(${t.reservationMinutes}, 1) > 0 and coalesce(${t.maxRideMinutes}, 1) > 0
        and coalesce(${t.maxPauseMinutes}, 1) > 0`,
    ),
  ],
);

export const reservationStatus = pgEnum('reservation_status', [
  'active',
  'expired',
  'cancelled',
  'converted',
]);

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    scooterId: uuid('scooter_id')
      .notNull()
      .references(() => scooters.id),
    pricingPlanId: uuid('pricing_plan_id')
      .notNull()
      .references(() => pricingPlans.id),
    status: reservationStatus('status').notNull().default('active'),
    expiresAt: ts('expires_at').notNull(),
    endedAt: ts('ended_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reservations_active_rider_uq')
      .on(t.riderId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('reservations_active_scooter_uq')
      .on(t.scooterId)
      .where(sql`${t.status} = 'active'`),
    index('reservations_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const rideStatus = pgEnum('ride_status', [
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
export const completionSource = pgEnum('completion_source', ['device', 'operator']);
export const parkingStatus = pgEnum('parking_status', ['ok', 'outside', 'unknown', 'not_checked']);
export const eventCause = pgEnum('event_cause', [
  'rider',
  'device',
  'timeout',
  'operator',
  'system',
]);

/** Terminal ride states; any other state occupies the rider and the scooter. */
export const TERMINAL_RIDE_STATUSES = ['completed', 'start_failed'] as const;

export const rides = pgTable(
  'rides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    scooterId: uuid('scooter_id')
      .notNull()
      .references(() => scooters.id),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    pricingPlanId: uuid('pricing_plan_id')
      .notNull()
      .references(() => pricingPlans.id),
    pricingSnapshot: jsonb('pricing_snapshot').notNull(),
    status: rideStatus('status').notNull().default('start_requested'),
    isSimulated: boolean('is_simulated').notNull(),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    unlockConfirmedAt: ts('unlock_confirmed_at'),
    endRequestedAt: ts('end_requested_at'),
    endRequestLat: doublePrecision('end_request_lat'),
    endRequestLng: doublePrecision('end_request_lng'),
    completionConfirmedAt: ts('completion_confirmed_at'),
    completionSource: completionSource('completion_source'),
    billingCutoffAt: ts('billing_cutoff_at'),
    completedAt: ts('completed_at'),
    pausedSeconds: integer('paused_seconds').notNull().default(0),
    pausedSince: ts('paused_since'),
    parkingStatus: parkingStatus('parking_status').notNull().default('not_checked'),
    fareSantim: santim('fare_santim'),
    currency: currency(),
    failureReason: text('failure_reason'),
    version: integer('version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rides_open_rider_uq')
      .on(t.riderId)
      .where(sql`${t.status} not in ('completed', 'start_failed')`),
    uniqueIndex('rides_open_scooter_uq')
      .on(t.scooterId)
      .where(sql`${t.status} not in ('completed', 'start_failed')`),
    index('rides_rider_history_idx').on(t.riderId, t.requestedAt),
    index('rides_status_idx').on(t.status),
    currencyIsEtb(t, 'rides_currency'),
    check('rides_fare_nonnegative', sql`${t.fareSantim} is null or ${t.fareSantim} >= 0`),
    check('rides_paused_seconds', sql`${t.pausedSeconds} >= 0`),
    latCheck('rides_end_lat', t.endRequestLat),
    lngCheck('rides_end_lng', t.endRequestLng),
    check(
      'rides_completed_fields',
      sql`${t.status} <> 'completed' or (${t.completedAt} is not null and ${t.fareSantim} is not null)`,
    ),
  ],
);

export const rideEvents = pgTable(
  'ride_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    rideId: uuid('ride_id')
      .notNull()
      .references(() => rides.id),
    fromStatus: rideStatus('from_status'),
    toStatus: rideStatus('to_status').notNull(),
    cause: eventCause('cause').notNull(),
    actorStaffId: uuid('actor_staff_id').references(() => staffUsers.id),
    deviceCommandId: uuid('device_command_id'),
    data: jsonb('data').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('ride_events_ride_idx').on(t.rideId, t.id)],
);

export const commandType = pgEnum('command_type', ['unlock', 'lock', 'locate']);
export const commandStatus = pgEnum('command_status', [
  'queued',
  'sent',
  'acked',
  'nacked',
  'timed_out',
  'failed',
  'cancelled',
]);
export const commandIssuer = pgEnum('command_issuer', ['system', 'staff', 'rider']);

/**
 * Internal command intents. Mapping to real supplier commands exists only
 * once supplier documentation is available (D-IOT); nothing here encodes a
 * supplier protocol.
 */
export const deviceCommands = pgTable(
  'device_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id),
    rideId: uuid('ride_id').references(() => rides.id),
    type: commandType('type').notNull(),
    status: commandStatus('status').notNull().default('queued'),
    issuedBy: commandIssuer('issued_by').notNull(),
    issuedByStaffId: uuid('issued_by_staff_id').references(() => staffUsers.id),
    reason: text('reason'),
    isSimulated: boolean('is_simulated').notNull(),
    attempt: integer('attempt').notNull().default(1),
    deadlineAt: ts('deadline_at').notNull(),
    sentAt: ts('sent_at'),
    resolvedAt: ts('resolved_at'),
    resultCode: text('result_code'),
    resultPayload: jsonb('result_payload'),
    createdAt: createdAt(),
  },
  (t) => [
    index('device_commands_pending_idx')
      .on(t.deadlineAt)
      .where(sql`${t.status} in ('queued','sent')`),
    index('device_commands_device_idx').on(t.deviceId, t.createdAt),
    index('device_commands_ride_idx').on(t.rideId),
  ],
);

export const ackOutcome = pgEnum('ack_outcome', ['ack', 'nack']);

/** Every acknowledgment received, including late and duplicate ones. Append-only. */
export const deviceCommandAcks = pgTable(
  'device_command_acks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    commandId: uuid('command_id')
      .notNull()
      .references(() => deviceCommands.id),
    outcome: ackOutcome('outcome').notNull(),
    late: boolean('late').notNull(),
    duplicate: boolean('duplicate').notNull(),
    payload: jsonb('payload'),
    receivedAt: createdAt(),
  },
  (t) => [index('device_command_acks_command_idx').on(t.commandId)],
);
