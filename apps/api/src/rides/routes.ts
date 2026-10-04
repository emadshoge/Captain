import {
  CreateReservationSchema,
  CurrentReservationSchema,
  CurrentRideSchema,
  EndRideSchema,
  PricingPlanCreateSchema,
  PricingPlanSchema,
  PricingSummarySchema,
  RIDE_ERROR_CODES,
  RideHistoryQuerySchema,
  RideResolveSchema,
  RideReviewSchema,
  RideSchema,
  StaffRideDetailSchema,
  StaffRidesQuerySchema,
  StaffRideSchema,
  STAFF_ERROR_CODES,
  StartRideSchema,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRider } from '../auth/http';
import type { AuthDeps } from '../auth/service';
import { AppError } from '../errors';
import { recordAudit } from '../lib/audit';
import { type Queryable, one, withTransaction } from '../lib/db';
import { withIdempotency } from '../lib/idempotency';
import { enforceRateLimit } from '../lib/rate-limit';
import {
  activePricing,
  cancelReservation,
  createReservation,
  fareAt,
  OPEN_RIDE_STATUSES,
  pauseRide,
  requestEnd,
  resolveReview,
  resumeRide,
  type RideDeps,
  type RideRow,
  sendToReview,
  startRide,
  toPricingPlan,
} from './engine';

const IdParams = z.object({ id: z.uuid() });

type RideView = RideRow & { scooter_code: string; charged_santim: number | null };

const RIDE_VIEW = `
  select r.*, s.code as scooter_code,
    (select (-sum(l.amount_santim))::bigint from journal_entries j
       join ledger_lines l on l.journal_id = j.id
       join ledger_accounts a on a.id = l.account_id and a.type = 'rider_wallet'
     where j.reference_type = 'ride' and j.reference_id = r.id::text and j.kind = 'ride_charge') as charged_santim
  from rides r join scooters s on s.id = r.scooter_id`;

async function loadRide(q: Queryable, id: string) {
  return one<RideView>(q, `${RIDE_VIEW} where r.id = $1`, [id]);
}

export function toRide(row: RideView, now: Date) {
  const completed = row.status === 'completed';
  const fare = completed
    ? (fareAt({ ...row, paused_since: null }, row.billing_cutoff_at ?? row.completed_at!) ?? null)
    : fareAt(row, row.end_requested_at ?? now);
  const finalFare =
    completed && fare && row.fare_santim !== fare.totalSantim
      ? // Operator "no charge" resolution: the recorded fare is authoritative.
        {
          ...fare,
          unlockFeeSantim: 0,
          ridingSantim: 0,
          pausedSantim: 0,
          totalSantim: row.fare_santim ?? 0,
        }
      : fare;
  const charged = completed ? (row.charged_santim ?? 0) : null;
  const p = row.pricing_snapshot;
  return {
    id: row.id,
    status: row.status,
    scooterId: row.scooter_id,
    scooterCode: row.scooter_code,
    isSimulated: row.is_simulated,
    requestedAt: row.requested_at.toISOString(),
    startedAt: row.unlock_confirmed_at?.toISOString() ?? null,
    endRequestedAt: row.end_requested_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    billingCutoffAt: row.billing_cutoff_at?.toISOString() ?? null,
    pausedSince: row.paused_since?.toISOString() ?? null,
    pausedSeconds: row.paused_seconds,
    parkingStatus: row.parking_status,
    fare: finalFare,
    fareIsEstimate: !completed,
    chargedSantim: charged,
    unpaidSantim: completed ? Math.max(0, (row.fare_santim ?? 0) - (charged ?? 0)) : null,
    failureReason: row.failure_reason,
    pricing: { ...p },
  };
}

export const riderRideRoutes: FastifyPluginAsyncZod<{
  deps: RideDeps;
  authDeps: AuthDeps;
}> = async (app, { deps, authDeps }) => {
  app.addHook('onRequest', requireRider(authDeps));
  const riderOf = (request: { auth?: unknown }) => (request.auth as { riderId: string }).riderId;
  const view = async (id: string) => toRide((await loadRide(deps.pool, id))!, deps.now());

  app.get('/v1/rider/pricing', { schema: { response: { 200: PricingSummarySchema } } }, async () =>
    activePricing(deps.pool, deps.config),
  );

  app.post(
    '/v1/rider/rides',
    { schema: { body: StartRideSchema, response: { 201: RideSchema } } },
    async (request, reply) => {
      const riderId = riderOf(request);
      await enforceRateLimit(
        deps.pool,
        { scope: 'ride-start', limit: 20, windowSeconds: 3_600 },
        riderId,
        deps.now(),
      );
      return withIdempotency(
        deps.pool,
        request,
        reply,
        `rider:${riderId}`,
        deps.now(),
        async () => {
          const ride = await startRide(deps, riderId, request.body);
          return { status: 201, body: await view(ride.id) };
        },
      );
    },
  );

  app.get(
    '/v1/rider/rides/current',
    { schema: { response: { 200: CurrentRideSchema } } },
    async (request) => {
      const row = await one<RideView>(
        deps.pool,
        `${RIDE_VIEW} where r.rider_id = $1 and r.status::text = any($2::text[])`,
        [riderOf(request), OPEN_RIDE_STATUSES],
      );
      return { ride: row ? toRide(row, deps.now()) : null };
    },
  );

  app.get(
    '/v1/rider/rides',
    { schema: { querystring: RideHistoryQuerySchema, response: { 200: z.array(RideSchema) } } },
    async (request) => {
      const { rows } = await deps.pool.query<RideView>(
        `${RIDE_VIEW} where r.rider_id = $1 and ($2::timestamptz is null or r.requested_at < $2)
         order by r.requested_at desc limit $3`,
        [riderOf(request), request.query.before ?? null, request.query.limit],
      );
      return rows.map((row) => toRide(row, deps.now()));
    },
  );

  app.get(
    '/v1/rider/rides/:id',
    { schema: { params: IdParams, response: { 200: RideSchema } } },
    async (request) => {
      const row = await loadRide(deps.pool, request.params.id);
      if (!row || row.rider_id !== riderOf(request)) {
        throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
      }
      return toRide(row, deps.now());
    },
  );

  app.post(
    '/v1/rider/rides/:id/pause',
    { schema: { params: IdParams, response: { 200: RideSchema } } },
    async (request) => {
      await pauseRide(deps, riderOf(request), request.params.id);
      return view(request.params.id);
    },
  );

  app.post(
    '/v1/rider/rides/:id/resume',
    { schema: { params: IdParams, response: { 200: RideSchema } } },
    async (request) => {
      await resumeRide(deps, riderOf(request), request.params.id);
      return view(request.params.id);
    },
  );

  app.post(
    '/v1/rider/rides/:id/end',
    { schema: { params: IdParams, body: EndRideSchema, response: { 200: RideSchema } } },
    async (request) => {
      await requestEnd(deps, riderOf(request), request.params.id, request.body);
      return view(request.params.id);
    },
  );

  // Reservations
  const toReservation = (
    row: { id: string; scooter_id: string; status: string; expires_at: Date },
    code: string,
    fee: number,
  ) => ({
    id: row.id,
    scooterId: row.scooter_id,
    scooterCode: code,
    status: row.status as 'active',
    expiresAt: row.expires_at.toISOString(),
    feeSantim: fee,
  });
  const reservationView = async (id: string) => {
    const row = (await one<{
      id: string;
      scooter_id: string;
      status: string;
      expires_at: Date;
      code: string;
      fee: number | null;
    }>(
      deps.pool,
      `select r.*, s.code, (select (-sum(l.amount_santim))::bigint from journal_entries j join ledger_lines l on l.journal_id = j.id
          join ledger_accounts a on a.id = l.account_id and a.type = 'rider_wallet'
        where j.reference_type = 'reservation' and j.reference_id = r.id::text) as fee
       from reservations r join scooters s on s.id = r.scooter_id where r.id = $1`,
      [id],
    ))!;
    return toReservation(row, row.code, row.fee ?? 0);
  };

  app.post(
    '/v1/rider/reservations',
    {
      schema: {
        body: CreateReservationSchema,
        response: { 201: CurrentReservationSchema.shape.reservation.unwrap() },
      },
    },
    async (request, reply) => {
      const riderId = riderOf(request);
      return withIdempotency(
        deps.pool,
        request,
        reply,
        `rider:${riderId}`,
        deps.now(),
        async () => {
          const { reservation } = await createReservation(deps, riderId, request.body.scooterId);
          return { status: 201, body: await reservationView(reservation.id) };
        },
      );
    },
  );

  app.get(
    '/v1/rider/reservations/current',
    { schema: { response: { 200: CurrentReservationSchema } } },
    async (request) => {
      const row = await one<{ id: string }>(
        deps.pool,
        `select id from reservations where rider_id = $1 and status = 'active' and expires_at > $2`,
        [riderOf(request), deps.now()],
      );
      return { reservation: row ? await reservationView(row.id) : null };
    },
  );

  app.delete(
    '/v1/rider/reservations/:id',
    {
      schema: {
        params: IdParams,
        response: { 200: CurrentReservationSchema.shape.reservation.unwrap() },
      },
    },
    async (request) => {
      await cancelReservation(deps, riderOf(request), request.params.id);
      return reservationView(request.params.id);
    },
  );
};

export const staffRideRoutes: FastifyPluginAsyncZod<{ deps: RideDeps }> = async (app, { deps }) => {
  const staffView = (row: RideView) => ({
    ...toRide(row, deps.now()),
    riderId: row.rider_id,
    deviceId: row.device_id,
  });
  const staffOf = (request: { auth?: unknown }) => (request.auth as { staffId: string }).staffId;

  app.get(
    '/v1/operator/rides',
    {
      config: { permission: 'rides.read' },
      schema: { querystring: StaffRidesQuerySchema, response: { 200: z.array(StaffRideSchema) } },
    },
    async (request) => {
      const q = request.query;
      const { rows } = await deps.pool.query<RideView>(
        `${RIDE_VIEW} where ($1::ride_status is null or r.status = $1) and ($2::uuid is null or r.rider_id = $2)
           and ($3::uuid is null or r.scooter_id = $3)
         order by r.requested_at desc limit $4`,
        [q.status ?? null, q.riderId ?? null, q.scooterId ?? null, q.limit],
      );
      return rows.map(staffView);
    },
  );

  app.get(
    '/v1/operator/rides/:id',
    {
      config: { permission: 'rides.read' },
      schema: { params: IdParams, response: { 200: StaffRideDetailSchema } },
    },
    async (request) => {
      const row = await loadRide(deps.pool, request.params.id);
      if (!row) throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Ride not found.');
      const { rows } = await deps.pool.query<{
        id: number;
        from_status: RideRow['status'] | null;
        to_status: RideRow['status'];
        cause: 'rider' | 'device' | 'timeout' | 'operator' | 'system';
        actor_staff_id: string | null;
        data: Record<string, unknown>;
        created_at: Date;
      }>(`select * from ride_events where ride_id = $1 order by id`, [row.id]);
      return {
        ride: staffView(row),
        events: rows.map((e) => ({
          id: e.id,
          fromStatus: e.from_status,
          toStatus: e.to_status,
          cause: e.cause,
          actorStaffId: e.actor_staff_id,
          data: e.data,
          createdAt: e.created_at.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/v1/operator/rides/:id/review',
    {
      config: { permission: 'rides.review' },
      schema: { params: IdParams, body: RideReviewSchema, response: { 200: StaffRideSchema } },
    },
    async (request) => {
      const before = await loadRide(deps.pool, request.params.id);
      await sendToReview(deps, request.params.id, staffOf(request), request.body.reason);
      await recordAudit(deps.pool, request, {
        action: 'ride.sent_to_review',
        targetType: 'ride',
        targetId: request.params.id,
        reason: request.body.reason,
        before: { status: before?.status },
        after: { status: 'operator_review' },
      });
      return staffView((await loadRide(deps.pool, request.params.id))!);
    },
  );

  app.post(
    '/v1/operator/rides/:id/resolve',
    {
      config: { permission: 'rides.review' },
      schema: { params: IdParams, body: RideResolveSchema, response: { 200: StaffRideSchema } },
    },
    async (request) => {
      const ride = await resolveReview(deps, request.params.id, staffOf(request), request.body);
      await recordAudit(deps.pool, request, {
        action: 'ride.review_resolved',
        targetType: 'ride',
        targetId: ride.id,
        reason: request.body.reason,
        after: {
          action: request.body.action,
          fareSantim: ride.fare_santim,
          billingCutoffAt: ride.billing_cutoff_at,
        },
      });
      return staffView((await loadRide(deps.pool, ride.id))!);
    },
  );

  // Pricing plans (versioned; immutable once active — database trigger)
  app.get(
    '/v1/admin/pricing-plans',
    {
      config: { permission: 'pricing.manage' },
      schema: { response: { 200: z.array(PricingPlanSchema) } },
    },
    async () => {
      const { rows } = await deps.pool.query(
        `select * from pricing_plans order by created_at desc limit 200`,
      );
      return rows.map(toPricingPlan);
    },
  );

  app.post(
    '/v1/admin/pricing-plans',
    {
      config: { permission: 'pricing.manage' },
      schema: { body: PricingPlanCreateSchema, response: { 201: PricingPlanSchema } },
    },
    async (request, reply) => {
      const b = request.body;
      if (
        (b.pausePerMinuteSantim === null) !== (b.maxPauseMinutes === null) &&
        b.pausePerMinuteSantim === null
      ) {
        throw new AppError(
          400,
          STAFF_ERROR_CODES.INVALID_STATE,
          'maxPauseMinutes needs a pause price.',
        );
      }
      if ((b.reservationMinutes === null) !== (b.reservationFeeSantim === null)) {
        throw new AppError(
          400,
          STAFF_ERROR_CODES.INVALID_STATE,
          'Reservation minutes and fee go together (both or neither).',
        );
      }
      const plan = await withTransaction(deps.pool, async (client) => {
        const row = await one(
          client,
          `insert into pricing_plans (name, status, is_dev_fixture, unlock_fee_santim, per_minute_santim, billing_increment_seconds,
             pause_per_minute_santim, max_pause_minutes, min_start_balance_santim, hold_amount_santim, reservation_minutes,
             reservation_fee_santim, max_ride_minutes, low_balance_floor_santim, created_by_staff_id, created_at)
           values ($1,'draft',false,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
          [
            b.name,
            b.unlockFeeSantim,
            b.perMinuteSantim,
            b.billingIncrementSeconds,
            b.pausePerMinuteSantim,
            b.maxPauseMinutes,
            b.minStartBalanceSantim,
            b.holdAmountSantim,
            b.reservationMinutes,
            b.reservationFeeSantim,
            b.maxRideMinutes,
            b.lowBalanceFloorSantim,
            staffOf(request),
            deps.now(),
          ],
        );
        const { reason, ...after } = b;
        await recordAudit(client, request, {
          action: 'pricing.plan_created',
          targetType: 'pricing_plan',
          targetId: (row as { id: string }).id,
          reason,
          after,
        });
        return row;
      });
      reply.code(201);
      return toPricingPlan(plan as Parameters<typeof toPricingPlan>[0]);
    },
  );

  app.post(
    '/v1/admin/pricing-plans/:id/activate',
    {
      config: { permission: 'pricing.manage' },
      schema: {
        params: IdParams,
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
        response: { 200: PricingPlanSchema },
      },
    },
    async (request) => {
      const plan = await withTransaction(deps.pool, async (client) => {
        const now = deps.now();
        const target = await one<{ id: string; status: string }>(
          client,
          `select id, status::text as status from pricing_plans where id = $1 for update`,
          [request.params.id],
        );
        if (!target)
          throw new AppError(404, RIDE_ERROR_CODES.RIDE_NOT_FOUND, 'Pricing plan not found.');
        if (target.status !== 'draft') {
          throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, `The plan is ${target.status}.`);
        }
        // Rides keep their own snapshot; retiring the old plan never re-prices them.
        const previous = await one<{ id: string }>(
          client,
          `update pricing_plans set status = 'retired', retired_at = $1 where status = 'active' returning id`,
          [now],
        );
        const row = await one(
          client,
          `update pricing_plans set status = 'active', activated_at = $2 where id = $1 returning *`,
          [request.params.id, now],
        );
        await recordAudit(client, request, {
          action: 'pricing.plan_activated',
          targetType: 'pricing_plan',
          targetId: request.params.id,
          reason: request.body.reason,
          before: { activePlanId: previous?.id ?? null },
          after: { activePlanId: request.params.id },
        });
        return row;
      });
      return toPricingPlan(plan as Parameters<typeof toPricingPlan>[0]);
    },
  );
};
