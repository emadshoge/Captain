import type { ApiConfig } from '@captain/config';
import { FLEET_ERROR_CODES, RIDE_ERROR_CODES } from '@captain/contracts';
import {
  chargeableAmount,
  computeFare,
  type FareBreakdown,
  type PricingSnapshot,
} from '@captain/domain';
import type pg from 'pg';
import { AppError } from '../errors';
import {
  type CommandListener,
  type CommandRow,
  createCommand,
  type FleetDeps,
  isStale,
  onCommandResolved,
  openAlert,
  SCOOTER_SELECT,
  type ScooterRow,
  unavailableReason,
  zoneStatus,
} from '../fleet/service';
import { type Queryable, isUniqueViolation, one, withTransaction } from '../lib/db';
import { lockWallet, postJournal, systemAccountId, walletFigures } from '../wallet/ledger';

export type RideDeps = FleetDeps;

export type RideStatus =
  | 'start_requested'
  | 'unlock_pending'
  | 'active'
  | 'paused'
  | 'end_requested'
  | 'completion_pending'
  | 'completed'
  | 'start_failed'
  | 'operator_review';

export interface RideRow {
  id: string;
  rider_id: string;
  scooter_id: string;
  device_id: string;
  reservation_id: string | null;
  pricing_plan_id: string;
  pricing_snapshot: PricingSnapshot;
  status: RideStatus;
  is_simulated: boolean;
  requested_at: Date;
  unlock_confirmed_at: Date | null;
  end_requested_at: Date | null;
  end_request_lat: number | null;
  end_request_lng: number | null;
  completion_confirmed_at: Date | null;
  completion_source: 'device' | 'operator' | null;
  billing_cutoff_at: Date | null;
  completed_at: Date | null;
  paused_seconds: number;
  paused_since: Date | null;
  parking_status: 'ok' | 'outside' | 'unknown' | 'not_checked';
  fare_santim: number | null;
  failure_reason: string | null;
  version: number;
}

/** Statuses in which a ride still occupies its rider and scooter. */
export const OPEN_RIDE_STATUSES: RideStatus[] = [
  'start_requested',
  'unlock_pending',
  'active',
  'paused',
  'end_requested',
  'completion_pending',
  'operator_review',
];

// ---------------------------------------------------------------------------
// Policy (unresolved business rules → configuration)
// ---------------------------------------------------------------------------

export interface RidePolicy {
  billingCutoff: 'end_request' | 'completion_confirmed';
  endConfirmation: 'none' | 'device_lock';
  parking: 'off' | 'flag' | 'reject';
  /** True when any value came from the development fallback. */
  devFixture: boolean;
}

/**
 * Staging/production must configure these explicitly (config validation);
 * development and test fall back to labelled DEV FIXTURE values.
 */
export function ridePolicy(config: ApiConfig): RidePolicy {
  return {
    billingCutoff: config.RIDE_BILLING_CUTOFF ?? 'end_request',
    endConfirmation: config.RIDE_END_CONFIRMATION ?? 'device_lock',
    parking: config.RIDE_PARKING_POLICY ?? 'flag',
    devFixture:
      config.RIDE_BILLING_CUTOFF === undefined ||
      config.RIDE_END_CONFIRMATION === undefined ||
      config.RIDE_PARKING_POLICY === undefined,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

interface PricingPlanRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'retired';
  is_dev_fixture: boolean;
  unlock_fee_santim: number;
  per_minute_santim: number;
  billing_increment_seconds: number;
  pause_per_minute_santim: number | null;
  max_pause_minutes: number | null;
  min_start_balance_santim: number;
  hold_amount_santim: number;
  reservation_minutes: number | null;
  reservation_fee_santim: number | null;
  max_ride_minutes: number | null;
  low_balance_floor_santim: number;
  activated_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
}

export function snapshotOf(plan: PricingPlanRow): PricingSnapshot {
  return {
    planId: plan.id,
    name: plan.name,
    isDevFixture: plan.is_dev_fixture,
    currency: 'ETB',
    unlockFeeSantim: plan.unlock_fee_santim,
    perMinuteSantim: plan.per_minute_santim,
    billingIncrementSeconds: plan.billing_increment_seconds,
    pausePerMinuteSantim: plan.pause_per_minute_santim,
    maxPauseMinutes: plan.max_pause_minutes,
    minStartBalanceSantim: plan.min_start_balance_santim,
    holdAmountSantim: plan.hold_amount_santim,
    reservationMinutes: plan.reservation_minutes,
    reservationFeeSantim: plan.reservation_fee_santim,
    maxRideMinutes: plan.max_ride_minutes,
    lowBalanceFloorSantim: plan.low_balance_floor_santim,
  };
}

export function toPricingPlan(plan: PricingPlanRow) {
  return {
    ...snapshotOf(plan),
    status: plan.status,
    activatedAt: plan.activated_at?.toISOString() ?? null,
    retiredAt: plan.retired_at?.toISOString() ?? null,
    createdAt: plan.created_at.toISOString(),
  };
}

/**
 * The plan new rides use. Development fixture pricing is refused in
 * production: real prices are an owner decision (D-PRICE).
 */
export async function activePricing(q: Queryable, config: ApiConfig): Promise<PricingSnapshot> {
  const plan = await one<PricingPlanRow>(q, `select * from pricing_plans where status = 'active'`);
  if (!plan || (plan.is_dev_fixture && config.APP_ENV === 'production')) {
    throw new AppError(
      503,
      RIDE_ERROR_CODES.PRICING_NOT_CONFIGURED,
      'Rides are not available yet.',
    );
  }
  return snapshotOf(plan);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lockRide(client: pg.PoolClient, rideId: string): Promise<RideRow | undefined> {
  return one<RideRow>(client, `select * from rides where id = $1 for update`, [rideId]);
}

async function transition(
  client: pg.PoolClient,
  ride: RideRow,
  to: RideStatus,
  cause: 'rider' | 'device' | 'timeout' | 'operator' | 'system',
  now: Date,
  set: Record<string, unknown> = {},
  event: {
    staffId?: string | null;
    commandId?: string | null;
    data?: Record<string, unknown>;
  } = {},
): Promise<RideRow> {
  const columns = Object.keys(set);
  const assignments = columns.map((column, i) => `${column} = $${i + 4}`);
  const updated = await one<RideRow>(
    client,
    `update rides set status = $2, version = version + 1, updated_at = $3${assignments.length ? ', ' + assignments.join(', ') : ''}
     where id = $1 returning *`,
    [ride.id, to, now, ...columns.map((c) => set[c])],
  );
  await client.query(
    `insert into ride_events (ride_id, from_status, to_status, cause, actor_staff_id, device_command_id, data, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ride.id,
      ride.status,
      to,
      cause,
      event.staffId ?? null,
      event.commandId ?? null,
      JSON.stringify(event.data ?? {}),
      now,
    ],
  );
  return updated!;
}

async function noteEvent(
  client: pg.PoolClient,
  ride: RideRow,
  cause: 'rider' | 'device' | 'timeout' | 'operator' | 'system',
  now: Date,
  data: Record<string, unknown>,
  commandId: string | null = null,
) {
  await client.query(
    `insert into ride_events (ride_id, from_status, to_status, cause, device_command_id, data, created_at)
     values ($1,$2,$2,$3,$4,$5,$6)`,
    [ride.id, ride.status, cause, commandId, JSON.stringify(data), now],
  );
}

async function releaseHolds(client: pg.PoolClient, rideId: string, now: Date) {
  await client.query(
    `update wallet_holds set status = 'released', released_at = $2 where ride_id = $1 and status = 'active'`,
    [rideId, now],
  );
}

async function setScooterStatus(
  client: pg.PoolClient,
  scooterId: string,
  from: string[],
  to: string,
  now: Date,
) {
  await client.query(
    `update scooters set status = $2, version = version + 1, updated_at = $4 where id = $1 and status::text = any($3::text[])`,
    [scooterId, to, from, now],
  );
}

async function openIncident(
  client: pg.PoolClient,
  ride: RideRow,
  kind: 'unlock_failed' | 'completion_timeout' | 'completion_nack' | 'other',
  description: string,
) {
  await client.query(
    `insert into incidents (kind, ride_id, scooter_id, device_id, reported_by_type, description, is_simulated)
     values ($1, $2, $3, $4, 'system', $5, $6)`,
    [kind, ride.id, ride.scooter_id, ride.device_id, description, ride.is_simulated],
  );
}

/** Seconds paused including a pause still running at `at`. */
function totalPausedSeconds(ride: RideRow, at: Date): number {
  const running = ride.paused_since
    ? Math.max(0, Math.floor((at.getTime() - ride.paused_since.getTime()) / 1000))
    : 0;
  return ride.paused_seconds + running;
}

export function fareAt(ride: RideRow, at: Date): FareBreakdown | null {
  if (!ride.unlock_confirmed_at) return null;
  const seconds = Math.max(
    0,
    Math.floor((at.getTime() - ride.unlock_confirmed_at.getTime()) / 1000),
  );
  return computeFare(ride.pricing_snapshot, seconds, totalPausedSeconds(ride, at));
}

async function loadScooterForUpdate(
  client: pg.PoolClient,
  by: { id?: string; code?: string; qr?: string },
) {
  const locked = await one<{ id: string }>(
    client,
    by.id
      ? `select id from scooters where id = $1 for update`
      : by.code
        ? `select id from scooters where upper(code) = upper($1) for update`
        : `select id from scooters where qr_token = $1 for update`,
    [by.id ?? by.code ?? by.qr],
  );
  if (!locked) throw new AppError(404, FLEET_ERROR_CODES.SCOOTER_NOT_FOUND, 'Scooter not found.');
  return (await one<ScooterRow>(client, `${SCOOTER_SELECT} where s.id = $1`, [locked.id]))!;
}

async function requireActiveRider(q: Queryable, riderId: string) {
  const rider = await one<{ status: string }>(
    q,
    `select status::text as status from riders where id = $1`,
    [riderId],
  );
  if (rider?.status !== 'active') {
    throw new AppError(403, RIDE_ERROR_CODES.RIDER_NOT_ACTIVE, 'This account cannot start rides.');
  }
}

async function requireNoOpenRide(q: Queryable, riderId: string) {
  const open = await one(
    q,
    `select 1 from rides where rider_id = $1 and status::text = any($2::text[])`,
    [riderId, OPEN_RIDE_STATUSES],
  );
  if (open)
    throw new AppError(
      409,
      RIDE_ERROR_CODES.RIDE_ALREADY_ACTIVE,
      'You already have a ride in progress.',
    );
}

/** Latest fresh, valid telemetry says the scooter is not moving. */
async function confirmedStationary(
  deps: RideDeps,
  q: Queryable,
  deviceId: string,
): Promise<boolean> {
  const latest = await one<{ speed_kmh: number | null; received_at: Date }>(
    q,
    `select speed_kmh, received_at from device_telemetry where device_id = $1 and valid
     order by received_at desc, id desc limit 1`,
    [deviceId],
  );
  return (
    !!latest &&
    latest.speed_kmh === 0 &&
    !isStale({ last_telemetry_at: latest.received_at }, deps.config, deps.now())
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

/**
 * Starts a ride: checks the rider, scooter (same availability rule as the
 * map), pricing and balance, records the ride with its price snapshot,
 * places the configured hold and queues an unlock command. The ride becomes
 * `active` only when the device acknowledges the unlock; nothing is charged
 * before that. Concurrency: the scooter row is locked first, then the
 * wallet; partial unique indexes stop a second open ride per rider/scooter.
 */
export async function startRide(
  deps: RideDeps,
  riderId: string,
  by: { scooterId?: string; code?: string; qr?: string },
): Promise<RideRow> {
  try {
    return await withTransaction(deps.pool, async (client) => {
      const now = deps.now();
      await requireActiveRider(client, riderId);
      const scooter = await loadScooterForUpdate(client, {
        id: by.scooterId,
        code: by.code,
        qr: by.qr,
      });
      await requireNoOpenRide(client, riderId);

      // A scooter reserved by this rider is available to them.
      let reservationId: string | null = null;
      if (scooter.status === 'reserved') {
        const reservation = await one<{ id: string }>(
          client,
          `select id from reservations where scooter_id = $1 and rider_id = $2 and status = 'active' and expires_at > $3 for update`,
          [scooter.id, riderId, now],
        );
        if (reservation) reservationId = reservation.id;
      }
      const reason = unavailableReason(
        reservationId ? { ...scooter, status: 'available' } : scooter,
        deps.config,
        now,
      );
      if (reason) {
        throw new AppError(
          409,
          FLEET_ERROR_CODES.SCOOTER_UNAVAILABLE,
          'This scooter cannot be rented right now.',
          {
            reason,
          },
        );
      }

      const pricing = await activePricing(client, deps.config);
      await lockWallet(client, riderId);
      const figures = await walletFigures(client, riderId);
      const required = Math.max(pricing.minStartBalanceSantim, pricing.holdAmountSantim);
      if (figures.availableSantim < required) {
        throw new AppError(
          409,
          RIDE_ERROR_CODES.BALANCE_TOO_LOW,
          'Top up your wallet to start a ride.',
          {
            availableSantim: figures.availableSantim,
            requiredSantim: required,
          },
        );
      }

      const ride = (await one<RideRow>(
        client,
        `insert into rides (rider_id, scooter_id, device_id, reservation_id, pricing_plan_id, pricing_snapshot,
           status, is_simulated, requested_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,'unlock_pending',$7,$8,$8,$8) returning *`,
        [
          riderId,
          scooter.id,
          scooter.device_id,
          reservationId,
          pricing.planId,
          JSON.stringify(pricing),
          scooter.is_simulated,
          now,
        ],
      ))!;
      await client.query(
        `insert into ride_events (ride_id, from_status, to_status, cause, data, created_at)
         values ($1, null, 'unlock_pending', 'rider', $2, $3)`,
        [
          ride.id,
          JSON.stringify({
            reservationId,
            availableSantim: figures.availableSantim,
            simulated: scooter.is_simulated,
          }),
          now,
        ],
      );
      if (reservationId) {
        await client.query(
          `update reservations set status = 'converted', ended_at = $2 where id = $1`,
          [reservationId, now],
        );
      }
      if (pricing.holdAmountSantim > 0) {
        await client.query(
          `insert into wallet_holds (rider_id, ride_id, amount_santim, created_at) values ($1,$2,$3,$4)`,
          [riderId, ride.id, pricing.holdAmountSantim, now],
        );
      }
      await setScooterStatus(client, scooter.id, ['available', 'reserved'], 'in_ride', now);
      await createCommand(
        client,
        {
          deviceId: scooter.device_id!,
          type: 'unlock',
          issuedBy: 'rider',
          rideId: ride.id,
          reason: 'ride start',
        },
        now,
        deps.config.COMMAND_TIMEOUT_SECONDS,
      );
      return ride;
    });
  } catch (error) {
    // The partial unique indexes are the final word on concurrent starts.
    if (isUniqueViolation(error, 'rides_open_rider_uq')) {
      throw new AppError(
        409,
        RIDE_ERROR_CODES.RIDE_ALREADY_ACTIVE,
        'You already have a ride in progress.',
      );
    }
    if (isUniqueViolation(error, 'rides_open_scooter_uq')) {
      throw new AppError(
        409,
        FLEET_ERROR_CODES.SCOOTER_UNAVAILABLE,
        'This scooter cannot be rented right now.',
        {
          reason: 'in_use',
        },
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Pause / resume (billing state only; never a device command)
// ---------------------------------------------------------------------------

export async function pauseRide(deps: RideDeps, riderId: string, rideId: string): Promise<RideRow> {
  return withTransaction(deps.pool, async (client) => {
    const ride = await requireRiderRide(client, riderId, rideId);
    if (ride.status === 'paused') return ride;
    if (ride.status !== 'active') throw invalidState(ride);
    if (ride.pricing_snapshot.pausePerMinuteSantim === null) {
      throw new AppError(409, RIDE_ERROR_CODES.PAUSE_NOT_OFFERED, 'Pausing is not available.');
    }
    const now = deps.now();
    // Pausing changes billing only. The scooter is NOT locked (R-23; D-PAUSE).
    return transition(client, ride, 'paused', 'rider', now, { paused_since: now });
  });
}

export async function resumeRide(
  deps: RideDeps,
  riderId: string,
  rideId: string,
): Promise<RideRow> {
  return withTransaction(deps.pool, async (client) => {
    const ride = await requireRiderRide(client, riderId, rideId);
    if (ride.status === 'active') return ride;
    if (ride.status !== 'paused') throw invalidState(ride);
    const now = deps.now();
    return transition(client, ride, 'active', 'rider', now, {
      paused_seconds: totalPausedSeconds(ride, now),
      paused_since: null,
    });
  });
}

async function requireRiderRide(client: pg.PoolClient, riderId: string, rideId: string) {
  const ride = await lockRide(client, rideId);
  if (!ride || ride.rider_id !== riderId) {
    throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
  }
  return ride;
}

function invalidState(ride: RideRow) {
  return new AppError(409, RIDE_ERROR_CODES.RIDE_INVALID_STATE, `The ride is ${ride.status}.`, {
    status: ride.status,
  });
}

// ---------------------------------------------------------------------------
// End request and completion
// ---------------------------------------------------------------------------

/**
 * "End ride" is a REQUEST (R-27). Depending on configuration it completes
 * immediately, or waits for a device lock acknowledgment — which is only
 * requested once the scooter is confirmed stationary (R-23). Real supplier
 * devices have no documented stationary check, so their rides go to
 * operator review instead of receiving any automatic lock command.
 * Idempotent: repeating it returns the ride in its current state.
 */
export async function requestEnd(
  deps: RideDeps,
  riderId: string,
  rideId: string,
  location: { lat?: number; lng?: number },
): Promise<RideRow> {
  return withTransaction(deps.pool, async (client) => {
    let ride = await requireRiderRide(client, riderId, rideId);
    if (
      ['end_requested', 'completion_pending', 'operator_review', 'completed'].includes(ride.status)
    )
      return ride;
    if (ride.status !== 'active' && ride.status !== 'paused') throw invalidState(ride);
    const now = deps.now();
    const policy = ridePolicy(deps.config);
    const scooter = (await one<ScooterRow>(client, `${SCOOTER_SELECT} where s.id = $1`, [
      ride.scooter_id,
    ]))!;

    // Parking (D-PARK): device location when fresh, else the rider's phone.
    const deviceFresh =
      scooter.last_lat !== null && scooter.last_lng !== null && !isStale(scooter, deps.config, now);
    const point = deviceFresh
      ? { lat: scooter.last_lat!, lng: scooter.last_lng!, source: 'device' }
      : location.lat !== undefined && location.lng !== undefined
        ? { lat: location.lat, lng: location.lng, source: 'rider' }
        : null;
    let parking: RideRow['parking_status'] = 'not_checked';
    if (policy.parking !== 'off') {
      if (!point) parking = 'unknown';
      else {
        const zones = await zoneStatus(client, point);
        parking = zones.inRestricted || zones.inServiceArea === false ? 'outside' : 'ok';
      }
      if (parking === 'outside' && policy.parking === 'reject') {
        throw new AppError(
          409,
          RIDE_ERROR_CODES.PARKING_NOT_ALLOWED,
          'You cannot park here. Move to an allowed area.',
        );
      }
    }

    // Device confirmation needs a stationary scooter before any lock command.
    const needsLock = policy.endConfirmation === 'device_lock';
    const supplierDevice = scooter.adapter !== 'simulated';
    if (
      needsLock &&
      !supplierDevice &&
      !(await confirmedStationary(deps, client, ride.device_id))
    ) {
      throw new AppError(
        409,
        RIDE_ERROR_CODES.SCOOTER_NOT_STATIONARY,
        'Stop the scooter completely, then end the ride.',
      );
    }

    ride = await transition(
      client,
      ride,
      'end_requested',
      'rider',
      now,
      {
        end_requested_at: now,
        end_request_lat: location.lat ?? null,
        end_request_lng: location.lng ?? null,
        parking_status: parking,
        paused_seconds: totalPausedSeconds(ride, now),
        paused_since: null,
      },
      { data: { parking, location: point, policy, simulated: ride.is_simulated } },
    );

    if (!needsLock)
      return settle(deps, client, ride, { cause: 'system', completionAt: now, source: null });
    if (supplierDevice) {
      await openIncident(
        client,
        ride,
        'other',
        'Ride end requested on a supplier device; automatic completion is not available until the supplier protocol is documented. Confirm the scooter is parked and resolve the ride.',
      );
      return transition(client, ride, 'operator_review', 'system', now, {
        failure_reason: 'device_confirmation_unsupported',
      });
    }
    const command = await createCommand(
      client,
      {
        deviceId: ride.device_id,
        type: 'lock',
        issuedBy: 'system',
        rideId: ride.id,
        reason: 'ride end (scooter stationary)',
      },
      now,
      deps.config.COMMAND_TIMEOUT_SECONDS,
    );
    return transition(
      client,
      ride,
      'completion_pending',
      'system',
      now,
      {},
      { commandId: command.id },
    );
  });
}

/**
 * Completes a ride and charges it exactly once (ledger reference
 * ('ride', id)). The charge never takes the wallet below the plan's floor;
 * any remainder is recorded as unpaid with an alert (D-UNPAID). Holds are
 * released. Never sends a device command.
 */
async function settle(
  deps: RideDeps,
  client: pg.PoolClient,
  ride: RideRow,
  opts: {
    cause: 'device' | 'operator' | 'system';
    completionAt: Date;
    source: 'device' | 'operator' | null;
    cutoffAt?: Date;
    noCharge?: boolean;
    staffId?: string | null;
    note?: string;
  },
): Promise<RideRow> {
  const policy = ridePolicy(deps.config);
  const cutoff =
    opts.cutoffAt ??
    (policy.billingCutoff === 'end_request' && ride.end_requested_at
      ? ride.end_requested_at
      : opts.completionAt);
  const fare = opts.noCharge
    ? computeFare(
        {
          ...ride.pricing_snapshot,
          unlockFeeSantim: 0,
          perMinuteSantim: 0,
          pausePerMinuteSantim: 0,
        },
        0,
        0,
      )
    : (fareAt({ ...ride, paused_since: null }, cutoff) ??
      computeFare({ ...ride.pricing_snapshot, unlockFeeSantim: 0 }, 0, 0));

  const walletId = await lockWallet(client, ride.rider_id);
  await releaseHolds(client, ride.id, opts.completionAt);
  const figures = await walletFigures(client, ride.rider_id);
  const { chargedSantim, unpaidSantim } = chargeableAmount(
    fare.totalSantim,
    figures.balanceSantim,
    ride.pricing_snapshot.lowBalanceFloorSantim,
  );
  if (chargedSantim > 0) {
    const revenue = await systemAccountId(client, 'ride_revenue');
    await postJournal(client, {
      kind: 'ride_charge',
      referenceType: 'ride',
      referenceId: ride.id,
      description: `Ride charge${ride.is_simulated ? ' (SIMULATED scooter)' : ''}${ride.pricing_snapshot.isDevFixture ? ' — DEV FIXTURE pricing' : ''}`,
      createdBy: opts.staffId ? { type: 'staff', staffId: opts.staffId } : { type: 'system' },
      lines: [
        { accountId: walletId, amountSantim: -chargedSantim },
        { accountId: revenue, amountSantim: chargedSantim },
      ],
    });
  }
  if (unpaidSantim > 0) {
    await openAlert(client, {
      kind: 'low_balance',
      severity: 'warning',
      dedupeKey: `ride_unpaid:${ride.id}`,
      rideId: ride.id,
      scooterId: ride.scooter_id,
      data: { unpaidSantim, riderId: ride.rider_id },
    });
  }
  const completed = await transition(
    client,
    ride,
    'completed',
    opts.cause,
    opts.completionAt,
    {
      completed_at: opts.completionAt,
      completion_confirmed_at: opts.source ? opts.completionAt : null,
      completion_source: opts.source,
      billing_cutoff_at: cutoff,
      fare_santim: fare.totalSantim,
      paused_since: null,
    },
    {
      staffId: opts.staffId,
      data: {
        fare,
        chargedSantim,
        unpaidSantim,
        noCharge: !!opts.noCharge,
        note: opts.note ?? null,
      },
    },
  );
  await setScooterStatus(client, ride.scooter_id, ['in_ride'], 'available', opts.completionAt);
  return completed;
}

// ---------------------------------------------------------------------------
// Device command outcomes
// ---------------------------------------------------------------------------

/**
 * Reacts to unlock/lock outcomes for ride commands, inside the transaction
 * that resolved the command. Failed or timed-out unlocks never charge.
 * Late acknowledgments never change a ride automatically: they are noted and
 * left to operators (the fleet layer opens the late-unlock incident).
 */
export const rideCommandListener: CommandListener = async (client, command, event, now) => {
  if (!command.ride_id) return;
  const ride = await lockRide(client, command.ride_id);
  if (!ride) return;
  if (event.late) {
    await noteEvent(
      client,
      ride,
      'device',
      now,
      { lateAck: event.outcome, commandType: command.type },
      command.id,
    );
    return;
  }
  if (command.type === 'unlock') await onUnlockOutcome(client, ride, command, event.outcome, now);
  else if (command.type === 'lock') await onLockOutcome(client, ride, command, event.outcome, now);
};

let configForListener: { deps: RideDeps } | null = null;

async function onUnlockOutcome(
  client: pg.PoolClient,
  ride: RideRow,
  command: CommandRow,
  outcome: 'ack' | 'nack' | 'timeout',
  now: Date,
) {
  if (ride.status !== 'unlock_pending') {
    await noteEvent(client, ride, 'device', now, { ignoredUnlockOutcome: outcome }, command.id);
    return;
  }
  if (outcome === 'ack') {
    await transition(
      client,
      ride,
      'active',
      'device',
      now,
      { unlock_confirmed_at: now },
      { commandId: command.id },
    );
    return;
  }
  await releaseHolds(client, ride.id, now);
  await transition(
    client,
    ride,
    'start_failed',
    outcome === 'timeout' ? 'timeout' : 'device',
    now,
    { failure_reason: outcome === 'timeout' ? 'unlock_timeout' : 'unlock_rejected' },
    { commandId: command.id, data: { charged: false } },
  );
  if (outcome === 'nack') {
    // The device refused: it is still locked and can serve another rider.
    await setScooterStatus(client, ride.scooter_id, ['in_ride'], 'available', now);
  } else {
    // Unknown physical state: keep the scooter out of service until checked.
    await setScooterStatus(client, ride.scooter_id, ['in_ride'], 'maintenance', now);
    await openIncident(
      client,
      ride,
      'unlock_failed',
      'Unlock timed out; the scooter state is unknown. It was set to maintenance. Check it physically; no automatic command was sent.',
    );
  }
}

async function onLockOutcome(
  client: pg.PoolClient,
  ride: RideRow,
  command: CommandRow,
  outcome: 'ack' | 'nack' | 'timeout',
  now: Date,
) {
  if (ride.status !== 'completion_pending') {
    await noteEvent(client, ride, 'device', now, { ignoredLockOutcome: outcome }, command.id);
    return;
  }
  if (outcome === 'ack') {
    if (!configForListener) throw new Error('ride engine not initialised');
    await settle(configForListener.deps, client, ride, {
      cause: 'device',
      completionAt: now,
      source: 'device',
    });
    return;
  }
  await openIncident(
    client,
    ride,
    outcome === 'timeout' ? 'completion_timeout' : 'completion_nack',
    'The device did not confirm the ride end. Check the scooter and resolve the ride; no further command was sent automatically.',
  );
  await transition(
    client,
    ride,
    'operator_review',
    outcome === 'timeout' ? 'timeout' : 'device',
    now,
    {
      failure_reason: outcome === 'timeout' ? 'completion_timeout' : 'completion_rejected',
    },
    { commandId: command.id },
  );
}

/** Registers the ride engine with the command lifecycle (once per process). */
export function initRideEngine(deps: RideDeps) {
  const first = configForListener === null;
  configForListener = { deps };
  if (first) {
    onCommandResolved(rideCommandListener);
  }
}

// ---------------------------------------------------------------------------
// Operator actions
// ---------------------------------------------------------------------------

export async function sendToReview(
  deps: RideDeps,
  rideId: string,
  staffId: string,
  reason: string,
) {
  return withTransaction(deps.pool, async (client) => {
    const ride = await lockRide(client, rideId);
    if (!ride) throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
    if (ride.status === 'operator_review') return ride;
    if (!['active', 'paused', 'end_requested', 'completion_pending'].includes(ride.status))
      throw invalidState(ride);
    const now = deps.now();
    return transition(
      client,
      ride,
      'operator_review',
      'operator',
      now,
      {
        paused_seconds: totalPausedSeconds(ride, now),
        paused_since: null,
        end_requested_at: ride.end_requested_at ?? now,
      },
      { staffId, data: { reason } },
    );
  });
}

export async function resolveReview(
  deps: RideDeps,
  rideId: string,
  staffId: string,
  input: { action: 'complete' | 'complete_no_charge'; endedAt?: string; reason: string },
) {
  return withTransaction(deps.pool, async (client) => {
    const ride = await lockRide(client, rideId);
    if (!ride) throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
    if (ride.status !== 'operator_review') throw invalidState(ride);
    const now = deps.now();
    let cutoff = input.endedAt ? new Date(input.endedAt) : (ride.end_requested_at ?? now);
    const earliest = ride.unlock_confirmed_at ?? ride.requested_at;
    if (cutoff < earliest || cutoff > now) {
      throw new AppError(
        400,
        RIDE_ERROR_CODES.RIDE_INVALID_STATE,
        'The end time must be between the ride start and now.',
      );
    }
    if (!ride.unlock_confirmed_at) cutoff = earliest;
    return settle(deps, client, ride, {
      cause: 'operator',
      completionAt: now,
      source: 'operator',
      cutoffAt: cutoff,
      noCharge: input.action === 'complete_no_charge',
      staffId,
      note: input.reason,
    });
  });
}

// ---------------------------------------------------------------------------
// Reservations (D-RESERVE: offered only when the active plan defines them)
// ---------------------------------------------------------------------------

export async function createReservation(deps: RideDeps, riderId: string, scooterId: string) {
  try {
    return await withTransaction(deps.pool, async (client) => {
      const now = deps.now();
      await requireActiveRider(client, riderId);
      const pricing = await activePricing(client, deps.config);
      if (pricing.reservationMinutes === null) {
        throw new AppError(
          409,
          RIDE_ERROR_CODES.RESERVATIONS_NOT_OFFERED,
          'Reservations are not available.',
        );
      }
      const scooter = await loadScooterForUpdate(client, { id: scooterId });
      await requireNoOpenRide(client, riderId);
      const reason = unavailableReason(scooter, deps.config, now);
      if (reason) {
        throw new AppError(
          409,
          FLEET_ERROR_CODES.SCOOTER_UNAVAILABLE,
          'This scooter cannot be reserved right now.',
          {
            reason,
          },
        );
      }
      const fee = pricing.reservationFeeSantim ?? 0;
      const walletId = await lockWallet(client, riderId);
      const figures = await walletFigures(client, riderId);
      if (figures.availableSantim < Math.max(fee, pricing.minStartBalanceSantim)) {
        throw new AppError(
          409,
          RIDE_ERROR_CODES.BALANCE_TOO_LOW,
          'Top up your wallet to reserve a scooter.',
          {
            availableSantim: figures.availableSantim,
            requiredSantim: Math.max(fee, pricing.minStartBalanceSantim),
          },
        );
      }
      const reservation = (await one<ReservationRow>(
        client,
        `insert into reservations (rider_id, scooter_id, pricing_plan_id, expires_at, created_at)
         values ($1,$2,$3,$4,$5) returning *`,
        [
          riderId,
          scooterId,
          pricing.planId,
          new Date(now.getTime() + pricing.reservationMinutes * 60_000),
          now,
        ],
      ))!;
      if (fee > 0) {
        const revenue = await systemAccountId(client, 'reservation_revenue');
        await postJournal(client, {
          kind: 'reservation_fee',
          referenceType: 'reservation',
          referenceId: reservation.id,
          description: `Reservation fee${pricing.isDevFixture ? ' — DEV FIXTURE pricing' : ''}`,
          createdBy: { type: 'rider' },
          lines: [
            { accountId: walletId, amountSantim: -fee },
            { accountId: revenue, amountSantim: fee },
          ],
        });
      }
      await setScooterStatus(client, scooterId, ['available'], 'reserved', now);
      return { reservation, scooterCode: scooter.code, feeSantim: fee };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'reservations_active_rider_uq')) {
      throw new AppError(
        409,
        RIDE_ERROR_CODES.RESERVATION_ACTIVE,
        'You already have a reservation.',
      );
    }
    if (isUniqueViolation(error, 'reservations_active_scooter_uq')) {
      throw new AppError(
        409,
        FLEET_ERROR_CODES.SCOOTER_UNAVAILABLE,
        'This scooter cannot be reserved right now.',
        {
          reason: 'reserved',
        },
      );
    }
    throw error;
  }
}

export interface ReservationRow {
  id: string;
  rider_id: string;
  scooter_id: string;
  status: 'active' | 'expired' | 'cancelled' | 'converted';
  expires_at: Date;
}

export async function cancelReservation(deps: RideDeps, riderId: string, reservationId: string) {
  return withTransaction(deps.pool, async (client) => {
    const reservation = await one<ReservationRow>(
      client,
      `select * from reservations where id = $1 and rider_id = $2 for update`,
      [reservationId, riderId],
    );
    if (!reservation)
      throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Reservation not found.');
    if (reservation.status !== 'active') return reservation;
    const now = deps.now();
    await client.query(
      `update reservations set status = 'cancelled', ended_at = $2 where id = $1`,
      [reservationId, now],
    );
    await setScooterStatus(client, reservation.scooter_id, ['reserved'], 'available', now);
    return { ...reservation, status: 'cancelled' as const };
  });
}

// ---------------------------------------------------------------------------
// Worker sweeps
// ---------------------------------------------------------------------------

/** Expired reservations release their scooter. */
export async function sweepReservations(deps: RideDeps): Promise<number> {
  return withTransaction(deps.pool, async (client) => {
    const now = deps.now();
    const { rows } = await client.query<{ scooter_id: string }>(
      `update reservations set status = 'expired', ended_at = $1 where status = 'active' and expires_at <= $1 returning scooter_id`,
      [now],
    );
    for (const row of rows)
      await setScooterStatus(client, row.scooter_id, ['reserved'], 'available', now);
    return rows.length;
  });
}

/**
 * Recovery after crashes or lost messages:
 * - end_requested rides older than the completion timeout (the process
 *   died between the request and completion) go to operator review;
 * - completion_pending/unlock_pending rides whose command already resolved
 *   are re-applied from the command outcome.
 * Alerts only (never device commands) for rides over the maximum duration
 * and for rides whose running fare exceeds what the wallet can cover.
 */
export async function sweepRides(deps: RideDeps): Promise<number> {
  const now = deps.now();
  let changed = 0;
  const stuck = await deps.pool.query<{ id: string }>(
    `select id from rides where status = 'end_requested' and end_requested_at < $1`,
    [new Date(now.getTime() - deps.config.RIDE_COMPLETION_TIMEOUT_SECONDS * 1000)],
  );
  for (const { id } of stuck.rows) {
    await withTransaction(deps.pool, async (client) => {
      const ride = await lockRide(client, id);
      if (ride?.status !== 'end_requested') return;
      await openIncident(
        client,
        ride,
        'completion_timeout',
        'The ride end request was not completed in time. Resolve the ride.',
      );
      await transition(client, ride, 'operator_review', 'timeout', now, {
        failure_reason: 'completion_stuck',
      });
      changed++;
    });
  }

  const orphaned = await deps.pool.query<{ id: string; command_id: string }>(
    `select r.id, c.id as command_id from rides r
     join lateral (select * from device_commands c where c.ride_id = r.id
                   and c.type = case when r.status = 'unlock_pending' then 'unlock'::command_type else 'lock'::command_type end
                   order by c.created_at desc limit 1) c on true
     where r.status in ('unlock_pending','completion_pending') and c.status in ('acked','nacked','timed_out','failed','cancelled')`,
  );
  for (const { command_id } of orphaned.rows) {
    await withTransaction(deps.pool, async (client) => {
      const command = (await one<CommandRow>(
        client,
        `select * from device_commands where id = $1 for update`,
        [command_id],
      ))!;
      const outcome =
        command.status === 'acked' ? 'ack' : command.status === 'nacked' ? 'nack' : 'timeout';
      await rideCommandListener(client, command, { outcome, late: false }, now);
      changed++;
    });
  }

  const open = await deps.pool.query<RideRow>(
    `select * from rides where status in ('active','paused')`,
  );
  for (const ride of open.rows) {
    const fare = fareAt(ride, now);
    if (!fare || !ride.unlock_confirmed_at) continue;
    const minutes = (now.getTime() - ride.unlock_confirmed_at.getTime()) / 60_000;
    if (
      ride.pricing_snapshot.maxRideMinutes !== null &&
      minutes > ride.pricing_snapshot.maxRideMinutes
    ) {
      await openAlert(deps.pool, {
        kind: 'max_ride_duration',
        severity: 'warning',
        dedupeKey: `max_ride_duration:${ride.id}`,
        rideId: ride.id,
        scooterId: ride.scooter_id,
        data: { minutes: Math.floor(minutes) },
      });
    }
    const figures = await walletFigures(deps.pool, ride.rider_id);
    if (figures.balanceSantim - ride.pricing_snapshot.lowBalanceFloorSantim < fare.totalSantim) {
      // D-LOWBAL: notify only. Never lock or slow a scooter that may be moving (R-23).
      await openAlert(deps.pool, {
        kind: 'low_balance',
        severity: 'info',
        dedupeKey: `ride_low_balance:${ride.id}`,
        rideId: ride.id,
        scooterId: ride.scooter_id,
        data: { runningFareSantim: fare.totalSantim, balanceSantim: figures.balanceSantim },
      });
    }
  }
  return changed;
}
