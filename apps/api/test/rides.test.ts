import { loadApiConfig } from '@captain/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStaffCommand } from '../src/cli/staff';
import { activePricing, sweepReservations, sweepRides } from '../src/rides/engine';
import { sweepCommandTimeouts } from '../src/worker/sweeps';
import {
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  postTestJournal,
  signInRider,
  signInStaff,
  type Harness,
  type StaffSession,
  type TestApp,
} from './helpers';

let h: Harness;
let seq = 0;
let keySeq = 0;
const key = () => `ride-key-${Date.now()}-${keySeq++}`;

const PLAN = {
  name: 'Test pricing (tests only)',
  unlockFeeSantim: 1_500,
  perMinuteSantim: 300,
  billingIncrementSeconds: 60,
  pausePerMinuteSantim: 100,
  maxPauseMinutes: 15,
  minStartBalanceSantim: 5_000,
  holdAmountSantim: 0,
  reservationMinutes: 10,
  reservationFeeSantim: 0,
  maxRideMinutes: 60,
  lowBalanceFloorSantim: -2_000,
  reason: 'test pricing',
};

beforeAll(async () => {
  h = await createHarness();
  const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
  for (const [email, role] of [
    ['ride-admin@captain.et', 'admin'],
    ['ride-op@captain.et', 'operator'],
  ] as const) {
    await runStaffCommand(
      ['create', '--email', email, '--name', role, '--role', role, '--reason', 'tests'],
      env,
    );
  }
});
afterAll(async () => {
  await destroyHarness(h);
});

const internal = (t: TestApp, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  t.request({
    method,
    url,
    headers: { authorization: `Bearer ${t.config.INTERNAL_API_TOKEN}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function telemetry(
  t: TestApp,
  supplierDeviceId: string,
  extra: Record<string, unknown> = {},
) {
  const res = await internal(t, 'POST', '/internal/v1/telemetry', {
    reports: [
      {
        supplierDeviceId,
        recordedAt: new Date(t.now()).toISOString(),
        lat: 9.01,
        lng: 38.76,
        batteryPercent: 80,
        speedKmh: 0,
        locked: true,
        ...extra,
      },
    ],
  });
  expect(res.json().results[0]).toMatch(/stored/);
}

async function onboardScooter(
  t: TestApp,
  admin: StaffSession,
  adapter: 'simulated' | 'supplier_tcp' = 'simulated',
  at = { lat: 9.01, lng: 38.76 },
) {
  seq += 1;
  const code = `R-${String(seq).padStart(4, '0')}`;
  const scooter = (
    await admin.call('POST', '/v1/admin/scooters', { code, model: 'Test', reason: 'ride tests' })
  ).json();
  const supplierDeviceId = `RDEV-${code}-${Date.now()}`;
  const device = (
    await admin.call('POST', '/v1/admin/devices', {
      supplierDeviceId,
      adapter,
      reason: 'ride tests',
    })
  ).json();
  await admin.call('POST', `/v1/admin/scooters/${scooter.id}/device`, {
    deviceId: device.id,
    reason: 'ride tests',
  });
  await telemetry(t, supplierDeviceId, at);
  const ok = await admin.call('PATCH', `/v1/operator/scooters/${scooter.id}/status`, {
    status: 'available',
    reason: 'ready',
  });
  expect(ok.statusCode).toBe(200);
  return { id: scooter.id as string, code, deviceId: device.id as string, supplierDeviceId };
}

async function fundedRider(t: TestApp, santim = 20_000) {
  const rider = await signInRider(t);
  if (santim > 0) await postTestJournal(h.pool, rider.subject.riderId, santim);
  return rider;
}

const start = (t: TestApp, token: string, body: Record<string, unknown>, k = key()) =>
  t.request({
    method: 'POST',
    url: '/v1/rider/rides',
    headers: { ...bearer(token), 'idempotency-key': k },
    payload: body,
  });

const riderPost = (t: TestApp, token: string, url: string, payload: Record<string, unknown> = {}) =>
  t.request({ method: 'POST', url, headers: bearer(token), payload });

const getRide = async (t: TestApp, token: string, id: string) => {
  const res = await t.request({
    method: 'GET',
    url: `/v1/rider/rides/${id}`,
    headers: bearer(token),
  });
  return res.json();
};

async function commandFor(rideId: string, type: 'unlock' | 'lock') {
  const { rows } = await h.pool.query<{ id: string; status: string }>(
    `select id, status::text as status from device_commands where ride_id = $1 and type = $2 order by created_at desc`,
    [rideId, type],
  );
  return rows;
}

async function deviceResult(
  t: TestApp,
  rideId: string,
  type: 'unlock' | 'lock',
  outcome: 'ack' | 'nack',
) {
  const [command] = await commandFor(rideId, type);
  expect(command).toBeDefined();
  return internal(t, 'POST', `/internal/v1/commands/${command!.id}/result`, { outcome });
}

const balance = async (t: TestApp, token: string) =>
  (await t.request({ method: 'GET', url: '/v1/rider/wallet', headers: bearer(token) })).json()
    .balanceSantim as number;

const scooterStatus = async (id: string) =>
  (await h.pool.query(`select status::text as s from scooters where id = $1`, [id])).rows[0]
    .s as string;

async function activeRide(
  t: TestApp,
  admin: StaffSession,
  rider?: Awaited<ReturnType<typeof fundedRider>>,
) {
  const r = rider ?? (await fundedRider(t));
  const s = await onboardScooter(t, admin);
  const started = await start(t, r.accessToken, { scooterId: s.id });
  expect(started.statusCode).toBe(201);
  const rideId = started.json().id as string;
  expect((await deviceResult(t, rideId, 'unlock', 'ack')).statusCode).toBe(200);
  return { rider: r, scooter: s, rideId };
}

let t0: TestApp;
let admin0: StaffSession;

describe('pricing plans', () => {
  it('has no rides without pricing, then versions plans through admin only', async () => {
    t0 = await buildTestApp(h);
    admin0 = await signInStaff(t0, 'ride-admin@captain.et');
    const rider = await fundedRider(t0);
    const none = await t0.request({
      method: 'GET',
      url: '/v1/rider/pricing',
      headers: bearer(rider.accessToken),
    });
    expect(none.statusCode).toBe(503);
    expect(none.json().error.code).toBe('PRICING_NOT_CONFIGURED');

    const op = await signInStaff(t0, 'ride-op@captain.et');
    expect((await op.call('POST', '/v1/admin/pricing-plans', PLAN)).statusCode).toBe(403);

    const created = await admin0.call('POST', '/v1/admin/pricing-plans', PLAN);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      status: 'draft',
      isDevFixture: false,
      unlockFeeSantim: 1_500,
    });
    const active = await admin0.call(
      'POST',
      `/v1/admin/pricing-plans/${created.json().planId}/activate`,
      { reason: 'go live in test' },
    );
    expect(active.json().status).toBe('active');
    expect(
      (
        await admin0.call('POST', `/v1/admin/pricing-plans/${created.json().planId}/activate`, {
          reason: 'again',
        })
      ).statusCode,
    ).toBe(409);
    const shown = await t0.request({
      method: 'GET',
      url: '/v1/rider/pricing',
      headers: bearer(rider.accessToken),
    });
    expect(shown.json()).toMatchObject({ planId: created.json().planId, perMinuteSantim: 300 });
    const audit = await h.pool.query(
      `select count(*)::int n from audit_log where action like 'pricing.%'`,
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it('refuses development fixture pricing in production', async () => {
    const prodEnv: Record<string, string> = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://db.internal/c',
      AUTH_SECRET: 'p'.repeat(40),
      INTERNAL_API_TOKEN: 'i'.repeat(40),
      CORS_ORIGINS: 'https://app.captain.et',
      OTP_SMS_PROVIDER: 'none',
      AUTH_RIDER_CHANNELS: 'email',
      OTP_EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      EMAIL_FROM: 'Captain <a@b.et>',
      RIDE_BILLING_CUTOFF: 'end_request',
      RIDE_END_CONFIRMATION: 'device_lock',
      RIDE_PARKING_POLICY: 'flag',
    };
    const prod = loadApiConfig(prodEnv);
    const fixtureRow = {
      id: '00000000-0000-4000-8000-000000000000',
      name: 'DEV',
      is_dev_fixture: true,
    };
    const q = { query: async () => ({ rows: [fixtureRow] }) } as never;
    await expect(activePricing(q, prod)).rejects.toMatchObject({ statusCode: 503 });
    expect(() => loadApiConfig({ ...prodEnv, RIDE_BILLING_CUTOFF: '' })).toThrow(
      /RIDE_BILLING_CUTOFF/,
    );
  });
});

describe('ride lifecycle', () => {
  it('starts only after the unlock ack, ends on request, and charges exactly once', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t, 20_000);
    const s = await onboardScooter(t, admin);
    const k = key();
    const started = await start(t, rider.accessToken, { code: s.code.toLowerCase() }, k);
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({
      status: 'unlock_pending',
      isSimulated: true,
      startedAt: null,
      fare: null,
    });
    expect(started.json().pricing.isDevFixture).toBe(false);
    expect(await scooterStatus(s.id)).toBe('in_ride');
    // Retried request with the same key: same ride, not a second one.
    const replay = await start(t, rider.accessToken, { code: s.code.toLowerCase() }, k);
    expect(replay.json().id).toBe(started.json().id);
    const id = started.json().id;

    await deviceResult(t, id, 'unlock', 'ack');
    expect((await getRide(t, rider.accessToken, id)).status).toBe('active');

    t.advance(10 * 60_000 + 5_000);
    await telemetry(t, s.supplierDeviceId); // fresh, stationary
    const running = await getRide(t, rider.accessToken, id);
    expect(running).toMatchObject({
      fareIsEstimate: true,
      fare: { totalSantim: 1_500 + 11 * 300 },
    });

    const end = await riderPost(t, rider.accessToken, `/v1/rider/rides/${id}/end`, {
      lat: 9.01,
      lng: 38.76,
    });
    expect(end.json()).toMatchObject({ status: 'completion_pending', parkingStatus: 'ok' });
    const again = await riderPost(t, rider.accessToken, `/v1/rider/rides/${id}/end`, {});
    expect(again.json().status).toBe('completion_pending');
    expect(await commandFor(id, 'lock')).toHaveLength(1);

    t.advance(3_000);
    await deviceResult(t, id, 'lock', 'ack');
    const receipt = await getRide(t, rider.accessToken, id);
    expect(receipt).toMatchObject({
      status: 'completed',
      fareIsEstimate: false,
      chargedSantim: 4_800,
      unpaidSantim: 0,
      fare: { unlockFeeSantim: 1_500, ridingSantim: 3_300, totalSantim: 4_800 },
    });
    // Billing stopped at the end request (DEV FIXTURE policy), not the ack.
    expect(receipt.billingCutoffAt).toBe(receipt.endRequestedAt);
    expect(await balance(t, rider.accessToken)).toBe(20_000 - 4_800);
    expect(await scooterStatus(s.id)).toBe('available');

    // A duplicate lock ack changes nothing.
    await deviceResult(t, id, 'lock', 'ack');
    expect(await balance(t, rider.accessToken)).toBe(15_200);
    const journals = await h.pool.query(
      `select count(*)::int n from journal_entries where reference_type = 'ride' and reference_id = $1`,
      [id],
    );
    expect(journals.rows[0].n).toBe(1);

    const history = await t.request({
      method: 'GET',
      url: '/v1/rider/rides',
      headers: bearer(rider.accessToken),
    });
    expect(history.json()[0].id).toBe(id);
    expect(
      (
        await t.request({
          method: 'GET',
          url: '/v1/rider/rides/current',
          headers: bearer(rider.accessToken),
        })
      ).json(),
    ).toEqual({ ride: null });
    const events = await h.pool.query(
      `select from_status, to_status, cause from ride_events where ride_id = $1 order by id`,
      [id],
    );
    expect(events.rows.map((e) => `${e.from_status ?? '-'}>${e.to_status}:${e.cause}`)).toEqual([
      '->unlock_pending:rider',
      'unlock_pending>active:device',
      'active>end_requested:rider',
      'end_requested>completion_pending:system',
      'completion_pending>completed:device',
    ]);
  });

  it('bills until completion when configured', async () => {
    const t = await buildTestApp(h, { RIDE_BILLING_CUTOFF: 'completion_confirmed' });
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const { rider, scooter, rideId } = await activeRide(t, admin);
    t.advance(50_000);
    await telemetry(t, scooter.supplierDeviceId);
    await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    t.advance(15_000); // completes in the second minute
    await deviceResult(t, rideId, 'lock', 'ack');
    expect((await getRide(t, rider.accessToken, rideId)).chargedSantim).toBe(1_500 + 2 * 300);
  });

  it('completes immediately without device confirmation when configured', async () => {
    const t = await buildTestApp(h, { RIDE_END_CONFIRMATION: 'none' });
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const { rider, rideId } = await activeRide(t, admin);
    t.advance(30_000);
    const end = await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    expect(end.json()).toMatchObject({ status: 'completed', chargedSantim: 1_800 });
    expect(await commandFor(rideId, 'lock')).toHaveLength(0);
  });

  it('bills pauses at the pause rate and never sends a command for pause', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const { rider, scooter, rideId } = await activeRide(t, admin);
    t.advance(60_000);
    expect(
      (await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/pause`)).json().status,
    ).toBe('paused');
    t.advance(5 * 60_000);
    expect(
      (await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/resume`)).json(),
    ).toMatchObject({ status: 'active', pausedSeconds: 300 });
    t.advance(60_000);
    await telemetry(t, scooter.supplierDeviceId);
    await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    await deviceResult(t, rideId, 'lock', 'ack');
    const receipt = await getRide(t, rider.accessToken, rideId);
    expect(receipt.fare).toMatchObject({
      ridingSeconds: 120,
      ridingSantim: 600,
      pausedSeconds: 300,
      pausedSantim: 500,
      totalSantim: 2_600,
    });
    const commands = await h.pool.query(
      `select type::text from device_commands where ride_id = $1 order by created_at`,
      [rideId],
    );
    expect(commands.rows.map((r) => r.type)).toEqual(['unlock', 'lock']);
  });

  it('refuses to end (no lock command) while the scooter may be moving', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const { rider, scooter, rideId } = await activeRide(t, admin);
    await telemetry(t, scooter.supplierDeviceId, { speedKmh: 12, locked: false });
    const moving = await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    expect(moving.statusCode).toBe(409);
    expect(moving.json().error.code).toBe('SCOOTER_NOT_STATIONARY');
    // Stale telemetry is not proof of standing still either.
    t.advance(10 * 60_000);
    expect(
      (await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`)).json().error.code,
    ).toBe('SCOOTER_NOT_STATIONARY');
    expect((await getRide(t, rider.accessToken, rideId)).status).toBe('active');
    expect(await commandFor(rideId, 'lock')).toHaveLength(0);
  });

  it('hides rides from other riders', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const { rideId } = await activeRide(t, admin);
    const other = await fundedRider(t);
    expect(
      (
        await t.request({
          method: 'GET',
          url: `/v1/rider/rides/${rideId}`,
          headers: bearer(other.accessToken),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await riderPost(t, other.accessToken, `/v1/rider/rides/${rideId}/end`)).statusCode,
    ).toBe(404);
  });
});

describe('start failures and races', () => {
  it('blocks a start below the minimum balance', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t, 4_999);
    const s = await onboardScooter(t, admin);
    const res = await start(t, rider.accessToken, { scooterId: s.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'BALANCE_TOO_LOW',
      details: { requiredSantim: 5_000 },
    });
    expect(await scooterStatus(s.id)).toBe('available');
  });

  it('never charges a rejected unlock and frees the scooter', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t);
    const s = await onboardScooter(t, admin);
    const id = (await start(t, rider.accessToken, { scooterId: s.id })).json().id;
    await deviceResult(t, id, 'unlock', 'nack');
    expect(await getRide(t, rider.accessToken, id)).toMatchObject({
      status: 'start_failed',
      failureReason: 'unlock_rejected',
      chargedSantim: null,
    });
    expect(await balance(t, rider.accessToken)).toBe(20_000);
    expect(await scooterStatus(s.id)).toBe('available');
  });

  it('times out a silent unlock: no charge, scooter held for inspection, late ack → incident only', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t);
    const s = await onboardScooter(t, admin);
    const id = (await start(t, rider.accessToken, { scooterId: s.id })).json().id;
    t.advance(21_000);
    await sweepCommandTimeouts({ config: t.config, pool: h.pool, now: () => new Date(t.now()) });
    expect(await getRide(t, rider.accessToken, id)).toMatchObject({
      status: 'start_failed',
      failureReason: 'unlock_timeout',
    });
    expect(await scooterStatus(s.id)).toBe('maintenance');
    const late = await deviceResult(t, id, 'unlock', 'ack');
    expect(late.json()).toMatchObject({ late: true });
    expect((await getRide(t, rider.accessToken, id)).status).toBe('start_failed');
    const incidents = await h.pool.query(
      `select kind::text from incidents where ride_id = $1 order by created_at`,
      [id],
    );
    expect(incidents.rows.map((r) => r.kind).sort()).toEqual(['late_unlock_ack', 'unlock_failed']);
    expect(await balance(t, rider.accessToken)).toBe(20_000);
    const commands = await h.pool.query(
      `select count(*)::int n from device_commands where ride_id = $1`,
      [id],
    );
    expect(commands.rows[0].n).toBe(1); // nothing sent automatically
    // The rider can start again once the failed ride is closed.
    const s2 = await onboardScooter(t, admin);
    expect((await start(t, rider.accessToken, { scooterId: s2.id })).statusCode).toBe(201);
  });

  it('lets only one of two riders take the same scooter', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const [a, b] = [await fundedRider(t), await fundedRider(t)];
    const s = await onboardScooter(t, admin);
    const results = await Promise.all([
      start(t, a.accessToken, { scooterId: s.id }),
      start(t, b.accessToken, { scooterId: s.id }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const rides = await h.pool.query(`select count(*)::int n from rides where scooter_id = $1`, [
      s.id,
    ]);
    expect(rides.rows[0].n).toBe(1);
  });

  it('lets a rider hold only one open ride under concurrent starts', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t);
    const scooters = [
      await onboardScooter(t, admin),
      await onboardScooter(t, admin),
      await onboardScooter(t, admin),
    ];
    const results = await Promise.all(
      scooters.map((s) => start(t, rider.accessToken, { scooterId: s.id })),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 201))
      expect(r.json().error.code).toBe('RIDE_ALREADY_ACTIVE');
    const inRide = await h.pool.query(
      `select count(*)::int n from scooters where id = any($1::uuid[]) and status = 'in_ride'`,
      [scooters.map((s) => s.id)],
    );
    expect(inRide.rows[0].n).toBe(1);
  });
});

describe('operator review and recovery', () => {
  it('sends a rejected lock to review and lets an operator settle it', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const op = await signInStaff(t, 'ride-op@captain.et');
    const { rider, scooter, rideId } = await activeRide(t, admin);
    t.advance(4 * 60_000);
    await telemetry(t, scooter.supplierDeviceId);
    const endAt = new Date(t.now()).toISOString();
    await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    await deviceResult(t, rideId, 'lock', 'nack');
    expect((await getRide(t, rider.accessToken, rideId)).status).toBe('operator_review');
    expect(await scooterStatus(scooter.id)).toBe('in_ride');

    const list = await op.call('GET', '/v1/operator/rides?status=operator_review');
    expect(list.json().map((r: { id: string }) => r.id)).toContain(rideId);
    t.advance(30 * 60_000);
    const op2 = await signInStaff(t, 'ride-op@captain.et');
    const future = await op2.call('POST', `/v1/operator/rides/${rideId}/resolve`, {
      action: 'complete',
      endedAt: new Date(t.now() + 60_000).toISOString(),
      reason: 'checked on site',
    });
    expect(future.statusCode).toBe(400);
    const resolved = await op2.call('POST', `/v1/operator/rides/${rideId}/resolve`, {
      action: 'complete',
      endedAt: endAt,
      reason: 'checked on site',
    });
    expect(resolved.json()).toMatchObject({ status: 'completed', chargedSantim: 1_500 + 4 * 300 });
    expect(await scooterStatus(scooter.id)).toBe('available');
    const detail = (await op2.call('GET', `/v1/operator/rides/${rideId}`)).json();
    expect(detail.events.at(-1)).toMatchObject({
      toStatus: 'completed',
      cause: 'operator',
      actorStaffId: op2.staffId,
    });
    void op;
    const audit = await h.pool.query(`select count(*)::int n from audit_log where target_id = $1`, [
      rideId,
    ]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('lets an operator close a ride the rider cannot end, without charge', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const op = await signInStaff(t, 'ride-op@captain.et');
    const { rider, rideId } = await activeRide(t, admin);
    t.advance(10 * 60_000);
    expect(
      (
        await op.call('POST', `/v1/operator/rides/${rideId}/review`, { reason: 'rider phone died' })
      ).json().status,
    ).toBe('operator_review');
    const done = await op.call('POST', `/v1/operator/rides/${rideId}/resolve`, {
      action: 'complete_no_charge',
      reason: 'goodwill',
    });
    expect(done.json()).toMatchObject({
      status: 'completed',
      chargedSantim: 0,
      unpaidSantim: 0,
      fare: { totalSantim: 0 },
    });
    expect(await balance(t, rider.accessToken)).toBe(20_000);
  });

  it('sends supplier-device rides to review instead of commanding the device', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t);
    const s = await onboardScooter(t, admin, 'supplier_tcp');
    const id = (await start(t, rider.accessToken, { scooterId: s.id })).json().id;
    await deviceResult(t, id, 'unlock', 'ack');
    await telemetry(t, s.supplierDeviceId, { speedKmh: 25, locked: false });
    const end = await riderPost(t, rider.accessToken, `/v1/rider/rides/${id}/end`);
    expect(end.json()).toMatchObject({
      status: 'operator_review',
      failureReason: 'device_confirmation_unsupported',
    });
    expect(await commandFor(id, 'lock')).toHaveLength(0);
  });

  it('recovers stuck rides and re-applies resolved commands', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const rider = await fundedRider(t);
    const s = await onboardScooter(t, admin);
    const id = (await start(t, rider.accessToken, { scooterId: s.id })).json().id;
    // Simulate a crash after the command was acked but before the ride moved.
    await h.pool.query(
      `update device_commands set status = 'acked', resolved_at = now() where ride_id = $1`,
      [id],
    );
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()) };
    await sweepRides(deps);
    expect((await getRide(t, rider.accessToken, id)).status).toBe('active');

    // Simulate a crash between the end request and completion.
    await h.pool.query(
      `update rides set status = 'end_requested', end_requested_at = $2 where id = $1`,
      [id, new Date(t.now())],
    );
    t.advance(181_000);
    await sweepRides(deps);
    expect((await getRide(t, rider.accessToken, id)).status).toBe('operator_review');
  });

  it('alerts on long rides and low balance without touching the scooter', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    let rider = await fundedRider(t, 6_000);
    const { scooter, rideId } = await activeRide(t, admin, rider);
    t.advance(61 * 60_000);
    rider = { ...rider, ...(await signInRider(t, rider.phone)) }; // access tokens are short-lived
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()) };
    await sweepRides(deps);
    const alerts = await h.pool.query(
      `select kind::text from operational_alerts where ride_id = $1 order by kind`,
      [rideId],
    );
    expect(alerts.rows.map((r) => r.kind)).toEqual(['low_balance', 'max_ride_duration']);
    expect(await commandFor(rideId, 'lock')).toHaveLength(0);
    expect((await getRide(t, rider.accessToken, rideId)).status).toBe('active');

    // Settling takes the wallet to the floor and records the rest as unpaid.
    await telemetry(t, scooter.supplierDeviceId);
    await riderPost(t, rider.accessToken, `/v1/rider/rides/${rideId}/end`);
    await deviceResult(t, rideId, 'lock', 'ack');
    const receipt = await getRide(t, rider.accessToken, rideId);
    expect(receipt.chargedSantim).toBe(8_000);
    expect(receipt.unpaidSantim).toBe(receipt.fare.totalSantim - 8_000);
    expect(await balance(t, rider.accessToken)).toBe(-2_000);
  });
});

describe('reservations and parking', () => {
  it('reserves a scooter for its rider only, converts on start and expires', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const [owner, other] = [await fundedRider(t), await fundedRider(t)];
    const s = await onboardScooter(t, admin);
    const reserve = (token: string, scooterId: string) =>
      t.request({
        method: 'POST',
        url: '/v1/rider/reservations',
        headers: { ...bearer(token), 'idempotency-key': key() },
        payload: { scooterId },
      });
    const res = await reserve(owner.accessToken, s.id);
    expect(res.statusCode).toBe(201);
    expect(await scooterStatus(s.id)).toBe('reserved');
    expect(
      (await start(t, other.accessToken, { scooterId: s.id })).json().error.details.reason,
    ).toBe('reserved');
    const ride = await start(t, owner.accessToken, { scooterId: s.id });
    expect(ride.statusCode).toBe(201);
    const row = await h.pool.query(`select status::text from reservations where id = $1`, [
      res.json().id,
    ]);
    expect(row.rows[0].status).toBe('converted');

    const s2 = await onboardScooter(t, admin);
    expect((await reserve(other.accessToken, s2.id)).statusCode).toBe(201);
    t.advance(11 * 60_000);
    expect(
      await sweepReservations({ config: t.config, pool: h.pool, now: () => new Date(t.now()) }),
    ).toBeGreaterThanOrEqual(1);
    expect(await scooterStatus(s2.id)).toBe('available');

    const s3 = await onboardScooter(t, admin);
    const third = await reserve(other.accessToken, s3.id);
    const cancel = await t.request({
      method: 'DELETE',
      url: `/v1/rider/reservations/${third.json().id}`,
      headers: bearer(other.accessToken),
    });
    expect(cancel.json().status).toBe('cancelled');
    expect(await scooterStatus(s3.id)).toBe('available');
  });

  it('flags or rejects parking in a no-parking zone according to policy', async () => {
    const t = await buildTestApp(h, { RIDE_PARKING_POLICY: 'reject' });
    const admin = await signInStaff(t, 'ride-admin@captain.et');
    const zone = await admin.call('POST', '/v1/admin/zones', {
      name: 'No parking (test)',
      kind: 'no_parking',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [39.5, 7.0],
            [39.51, 7.0],
            [39.51, 7.01],
            [39.5, 7.01],
            [39.5, 7.0],
          ],
        ],
      },
      reason: 'parking test',
    });
    expect(zone.statusCode).toBe(201);
    const rider = await fundedRider(t);
    const s = await onboardScooter(t, admin, 'simulated', { lat: 7.005, lng: 39.505 });
    const id = (await start(t, rider.accessToken, { scooterId: s.id })).json().id;
    await deviceResult(t, id, 'unlock', 'ack');
    const rejected = await riderPost(t, rider.accessToken, `/v1/rider/rides/${id}/end`);
    expect(rejected.json().error.code).toBe('PARKING_NOT_ALLOWED');
    expect((await getRide(t, rider.accessToken, id)).status).toBe('active');

    const flagApp = await buildTestApp(h, { RIDE_PARKING_POLICY: 'flag' });
    const r2 = await signInRider(flagApp);
    await postTestJournal(h.pool, r2.subject.riderId, 20_000);
    const flagAdmin = await signInStaff(flagApp, 'ride-admin@captain.et');
    const s2 = await onboardScooter(flagApp, flagAdmin, 'simulated', { lat: 7.005, lng: 39.505 });
    const id2 = (await start(flagApp, r2.accessToken, { scooterId: s2.id })).json().id;
    await deviceResult(flagApp, id2, 'unlock', 'ack');
    const flagged = await riderPost(flagApp, r2.accessToken, `/v1/rider/rides/${id2}/end`);
    expect(flagged.json()).toMatchObject({
      status: 'completion_pending',
      parkingStatus: 'outside',
    });
  });
});

describe('authorization', () => {
  it('gives operators ride review but not pricing', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'ride-op@captain.et');
    expect((await op.call('GET', '/v1/operator/rides')).statusCode).toBe(200);
    expect((await op.call('GET', '/v1/admin/pricing-plans')).statusCode).toBe(403);
    const rider = await fundedRider(t);
    expect(
      (
        await t.request({
          method: 'GET',
          url: '/v1/operator/rides',
          headers: bearer(rider.accessToken),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps the ledger balanced', async () => {
    const total = await h.pool.query(
      `select coalesce(sum(amount_santim), 0)::bigint as total from ledger_lines`,
    );
    expect(Number(total.rows[0].total)).toBe(0);
  });
});
