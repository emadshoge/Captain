import { loadApiConfig } from '@captain/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStaffCommand } from '../src/cli/staff';
import { type ScooterRow, unavailableReason } from '../src/fleet/service';
import {
  runSweepsOnce,
  sweepCommandTimeouts,
  sweepOfflineDevices,
  sweepPurge,
  sweepStaleTelemetry,
} from '../src/worker/sweeps';
import {
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  signInRider,
  signInStaff,
  type Harness,
  type StaffSession,
  type TestApp,
} from './helpers';

let h: Harness;
let seq = 0;
const square = (lat: number, lng: number, d = 0.01) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat + d],
      [lng, lat],
    ],
  ],
});
beforeAll(async () => {
  h = await createHarness();
  const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
  await runStaffCommand(
    [
      'create',
      '--email',
      'fleet-admin@captain.et',
      '--name',
      'FA',
      '--role',
      'admin',
      '--reason',
      'tests',
    ],
    env,
  );
  await runStaffCommand(
    [
      'create',
      '--email',
      'fleet-op@captain.et',
      '--name',
      'FO',
      '--role',
      'operator',
      '--reason',
      'tests',
    ],
    env,
  );
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

const telemetry = (t: TestApp, report: Record<string, unknown>) =>
  internal(t, 'POST', '/internal/v1/telemetry', { reports: [report] });

/** Creates a scooter + simulated device through the admin API and makes it rentable. */
async function onboardScooter(
  t: TestApp,
  admin: StaffSession,
  opts: {
    lat?: number;
    lng?: number;
    battery?: number;
    adapter?: 'simulated' | 'supplier_tcp';
    available?: boolean;
  } = {},
) {
  seq += 1;
  const code = `T-${String(seq).padStart(4, '0')}`;
  const scooter = await admin.call('POST', '/v1/admin/scooters', {
    code,
    model: 'Test model',
    reason: 'onboarding test',
  });
  expect(scooter.statusCode).toBe(201);
  const supplierDeviceId = `DEV-${code}-${Date.now()}`;
  const device = await admin.call('POST', '/v1/admin/devices', {
    supplierDeviceId,
    adapter: opts.adapter ?? 'simulated',
    reason: 'onboarding test',
  });
  expect(device.statusCode).toBe(201);
  const assigned = await admin.call('POST', `/v1/admin/scooters/${scooter.json().id}/device`, {
    deviceId: device.json().id,
    reason: 'onboarding test',
  });
  expect(assigned.statusCode).toBe(200);
  const report = await telemetry(t, {
    supplierDeviceId,
    recordedAt: new Date(t.now()).toISOString(),
    lat: opts.lat ?? 9.01,
    lng: opts.lng ?? 38.76,
    batteryPercent: opts.battery ?? 80,
    speedKmh: 0,
    locked: true,
  });
  expect(report.json().results).toEqual(['stored']);
  if (opts.available !== false) {
    const status = await admin.call('PATCH', `/v1/operator/scooters/${scooter.json().id}/status`, {
      status: 'available',
      reason: 'ready for riders',
    });
    expect(status.statusCode).toBe(200);
  }
  return {
    id: scooter.json().id as string,
    code,
    deviceId: device.json().id as string,
    supplierDeviceId,
    qrToken: '',
  };
}

describe('rider discovery', () => {
  it('lists only rentable scooters, nearest first, and hides stale/low/offline ones', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const rider = await signInRider(t);
    const near = await onboardScooter(t, admin, { lat: 9.0101, lng: 38.7601 });
    const far = await onboardScooter(t, admin, { lat: 9.0145, lng: 38.7601 }); // ~490 m
    const low = await onboardScooter(t, admin, { lat: 9.0102, lng: 38.7602, battery: 10 });
    const notReady = await onboardScooter(t, admin, {
      lat: 9.0103,
      lng: 38.7603,
      available: false,
    });

    const list = async (radiusM = 1000) =>
      (
        await t.request({
          method: 'GET',
          url: `/v1/rider/scooters/nearby?lat=9.01&lng=38.76&radiusM=${radiusM}`,
          headers: bearer(rider.accessToken),
        })
      ).json() as { code: string; distanceM: number; ageSeconds: number }[];

    const codes = (await list()).map((s) => s.code);
    expect(codes.indexOf(near.code)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(near.code)).toBeLessThan(codes.indexOf(far.code));
    expect(codes).not.toContain(low.code);
    expect(codes).not.toContain(notReady.code);
    expect((await list(300)).map((s) => s.code)).not.toContain(far.code);

    // Stale: no telemetry for longer than FLEET_TELEMETRY_STALE_SECONDS.
    t.advance(301_000);
    expect((await list()).map((s) => s.code)).not.toContain(near.code);
    await telemetry(t, {
      supplierDeviceId: near.supplierDeviceId,
      lat: 9.0101,
      lng: 38.7601,
      batteryPercent: 79,
    });
    expect((await list()).map((s) => s.code)).toContain(near.code);

    // Offline: worker marks the device offline after DEVICE_OFFLINE_SECONDS.
    t.advance(121_000);
    await sweepOfflineDevices({ config: t.config, pool: h.pool, now: () => new Date(t.now()) });
    expect((await list()).map((s) => s.code)).not.toContain(near.code);
  });

  it('looks scooters up by printed code or QR token with a plain-language reason', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const rider = await signInRider(t);
    const s = await onboardScooter(t, admin);
    const detail = await admin.call('GET', `/v1/operator/scooters/${s.id}`);
    const qr = detail.json().qrToken;
    const lookup = (query: string) =>
      t.request({
        method: 'GET',
        url: `/v1/rider/scooters/lookup?${query}`,
        headers: bearer(rider.accessToken),
      });

    expect((await lookup(`code=${s.code.toLowerCase()}`)).json()).toMatchObject({
      code: s.code,
      available: true,
      unavailableReason: null,
    });
    expect((await lookup(`qr=${encodeURIComponent(qr)}`)).json().code).toBe(s.code);
    const missing = await lookup('code=NOPE-1');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SCOOTER_NOT_FOUND');
    expect((await lookup('code=A&qr=B')).statusCode).toBe(400);

    await admin.call('PATCH', `/v1/operator/scooters/${s.id}/status`, {
      status: 'maintenance',
      reason: 'brake check',
    });
    expect((await lookup(`code=${s.code}`)).json()).toMatchObject({
      available: false,
      unavailableReason: 'maintenance',
    });
  });

  it('never offers simulated scooters to riders in production', () => {
    const prod = loadApiConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://db.internal/c',
      AUTH_SECRET: 'p'.repeat(40),
      INTERNAL_API_TOKEN: 'i'.repeat(40),
      RIDE_BILLING_CUTOFF: 'end_request',
      RIDE_END_CONFIRMATION: 'device_lock',
      RIDE_PARKING_POLICY: 'flag',
      CORS_ORIGINS: 'https://app.captain.et',
      AUTH_RIDER_CHANNELS: 'email',
      OTP_EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.et',
      SMTP_USER: 'u',
      SMTP_PASSWORD: 'p',
      EMAIL_FROM: 'Captain <a@captain.et>',
    });
    const now = new Date();
    const row = {
      status: 'available',
      device_id: 'd',
      online: true,
      is_simulated: true,
      last_lat: 9,
      last_lng: 38,
      last_telemetry_at: now,
      battery_percent: 90,
    } as ScooterRow;
    expect(unavailableReason(row, prod, now)).toBe('not_in_service');
    expect(unavailableReason({ ...row, is_simulated: false }, prod, now)).toBeNull();
  });
});

describe('telemetry ingestion', () => {
  it('stores invalid data without moving the scooter and raises an alert', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin, { lat: 9.02, lng: 38.77 });
    const cases = [
      { lat: 0, lng: 0 },
      { lat: 95, lng: 38 },
      { lat: 9.02 },
      { batteryPercent: 140 },
      { recordedAt: new Date(t.now() + 5 * 60_000).toISOString() },
    ];
    for (const extra of cases) {
      const res = await telemetry(t, { supplierDeviceId: s.supplierDeviceId, ...extra });
      expect(res.json().results).toEqual(['invalid']);
    }
    const scooter = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json();
    expect([scooter.lat, scooter.lng]).toEqual([9.02, 38.77]);
    expect(scooter.recentTelemetry.filter((p: { valid: boolean }) => !p.valid)).toHaveLength(
      cases.length,
    );
    expect(scooter.alerts.map((a: { kind: string }) => a.kind)).toContain('invalid_telemetry');
    expect((await telemetry(t, { supplierDeviceId: 'unknown-device' })).json().results).toEqual([
      'unknown_device',
    ]);
  });

  it('ignores out-of-order reports for position and tracks low battery', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin, { lat: 9.03, lng: 38.78 });
    const older = new Date(t.now() - 60_000).toISOString();
    expect(
      (
        await telemetry(t, {
          supplierDeviceId: s.supplierDeviceId,
          recordedAt: older,
          lat: 9.05,
          lng: 38.79,
        })
      ).json().results,
    ).toEqual(['stored_out_of_order']);
    let detail = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json();
    expect([detail.lat, detail.lng]).toEqual([9.03, 38.78]);

    t.advance(1_000);
    await telemetry(t, { supplierDeviceId: s.supplierDeviceId, batteryPercent: 12 });
    detail = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json();
    const low = detail.alerts.find((a: { kind: string }) => a.kind === 'low_battery');
    expect(low).toMatchObject({ severity: 'critical', status: 'open' });
    t.advance(1_000);
    await telemetry(t, { supplierDeviceId: s.supplierDeviceId, batteryPercent: 90 });
    detail = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json();
    expect(detail.alerts.find((a: { kind: string }) => a.kind === 'low_battery').status).toBe(
      'resolved',
    );
  });

  it('requires the internal token and refuses simulated adapters in production', async () => {
    const t = await buildTestApp(h);
    const noToken = await t.request({
      method: 'GET',
      url: '/internal/v1/devices?adapter=simulated',
    });
    expect(noToken.statusCode).toBe(401);
    const wrong = await t.request({
      method: 'POST',
      url: '/internal/v1/telemetry',
      headers: { authorization: 'Bearer ' + 'x'.repeat(60) },
      payload: { reports: [{ supplierDeviceId: 'x' }] },
    });
    expect(wrong.statusCode).toBe(401);
    // A rider or staff token is not an internal token.
    const rider = await signInRider(t);
    expect(
      (
        await t.request({
          method: 'GET',
          url: '/internal/v1/devices?adapter=simulated',
          headers: bearer(rider.accessToken),
        })
      ).statusCode,
    ).toBe(401);
    expect((await internal(t, 'GET', '/internal/v1/devices?adapter=simulated')).statusCode).toBe(
      200,
    );
  });
});

describe('device commands', () => {
  it('runs queued → sent → acked, records duplicates, and audits the issuer', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin);
    const cmd = await op.call('POST', `/v1/operator/scooters/${s.id}/commands`, {
      type: 'locate',
      reason: 'find it',
    });
    expect(cmd.statusCode).toBe(202);
    expect(cmd.json()).toMatchObject({ status: 'queued', isSimulated: true, issuedBy: 'staff' });

    const pending = await internal(t, 'GET', '/internal/v1/commands/pending?adapter=simulated');
    expect(pending.json().map((c: { id: string }) => c.id)).toContain(cmd.json().id);
    expect(
      (await internal(t, 'GET', '/internal/v1/commands/pending?adapter=simulated')).json(),
    ).toEqual([]); // already sent

    const ack = await internal(t, 'POST', `/internal/v1/commands/${cmd.json().id}/result`, {
      outcome: 'ack',
    });
    expect(ack.json()).toEqual({ accepted: true, late: false, duplicate: false });
    const dup = await internal(t, 'POST', `/internal/v1/commands/${cmd.json().id}/result`, {
      outcome: 'nack',
    });
    expect(dup.json()).toEqual({ accepted: true, late: false, duplicate: true });
    const detail = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json();
    expect(detail.commands.find((c: { id: string }) => c.id === cmd.json().id).status).toBe(
      'acked',
    );
    const acks = await h.pool.query(
      `select duplicate from device_command_acks where command_id = $1 order by id`,
      [cmd.json().id],
    );
    expect(acks.rows.map((r) => r.duplicate)).toEqual([false, true]);
  });

  it('times out silent commands and turns a late unlock ack into an incident, with no automatic command', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin);
    await op.call('PATCH', `/v1/operator/scooters/${s.id}/status`, {
      status: 'maintenance',
      reason: 'service',
    });
    const cmd = await op.call('POST', `/v1/operator/scooters/${s.id}/commands`, {
      type: 'unlock',
      reason: 'service unlock',
    });
    expect(cmd.statusCode).toBe(202);
    await internal(t, 'GET', '/internal/v1/commands/pending?adapter=simulated');

    t.advance(21_000);
    const swept = await sweepCommandTimeouts({
      config: t.config,
      pool: h.pool,
      now: () => new Date(t.now()),
    });
    expect(swept).toBeGreaterThanOrEqual(1);
    const before = await h.pool.query(
      `select count(*)::int n from device_commands where device_id = $1`,
      [s.deviceId],
    );

    const late = await internal(t, 'POST', `/internal/v1/commands/${cmd.json().id}/result`, {
      outcome: 'ack',
    });
    expect(late.json()).toEqual({ accepted: true, late: true, duplicate: false });
    const incident = await h.pool.query(
      `select kind, status, is_simulated from incidents where device_id = $1`,
      [s.deviceId],
    );
    expect(incident.rows).toEqual([
      { kind: 'late_unlock_ack', status: 'open', is_simulated: true },
    ]);
    const after = await h.pool.query(
      `select count(*)::int n from device_commands where device_id = $1`,
      [s.deviceId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n); // nothing was sent automatically
    const alert = await h.pool.query(`select 1 from operational_alerts where dedupe_key = $1`, [
      `command_timeout:${cmd.json().id}`,
    ]);
    expect(alert.rowCount).toBe(1);
  });

  it('enforces motion safety for lock/unlock', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin);
    const send = (type: string) =>
      op.call('POST', `/v1/operator/scooters/${s.id}/commands`, { type, reason: 'safety test' });

    // Unlock needs a service status first.
    expect((await send('unlock')).json().error.code).toBe('COMMAND_UNSAFE');
    // Moving scooter: lock refused.
    await telemetry(t, {
      supplierDeviceId: s.supplierDeviceId,
      speedKmh: 14,
      lat: 9.01,
      lng: 38.76,
    });
    const moving = await send('lock');
    expect(moving.statusCode).toBe(409);
    expect(moving.json().error.code).toBe('COMMAND_UNSAFE');
    // Unknown speed: refused too.
    t.advance(1_000);
    await telemetry(t, { supplierDeviceId: s.supplierDeviceId, lat: 9.01, lng: 38.76 });
    expect((await send('lock')).json().error.code).toBe('COMMAND_UNSAFE');
    // Confirmed stationary: allowed.
    t.advance(1_000);
    await telemetry(t, {
      supplierDeviceId: s.supplierDeviceId,
      speedKmh: 0,
      lat: 9.01,
      lng: 38.76,
    });
    expect((await send('lock')).statusCode).toBe(202);
    // Locate is always allowed when online.
    expect((await send('locate')).statusCode).toBe(202);

    // Real supplier devices: no documented stationary check yet.
    const real = await onboardScooter(t, admin, { adapter: 'supplier_tcp' });
    const res = await op.call('POST', `/v1/operator/scooters/${real.id}/commands`, {
      type: 'lock',
      reason: 'test',
    });
    expect(res.json().error.code).toBe('COMMAND_UNSUPPORTED');
  });
});

describe('fleet operations', () => {
  it('filters the operator list, protects in-use status, and audits status changes', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin, { battery: 18 });
    const low = (
      await op.call('GET', '/v1/operator/scooters?batteryBelow=20&simulated=true')
    ).json();
    expect(low.map((x: { code: string }) => x.code)).toContain(s.code);
    expect(low.find((x: { code: string }) => x.code === s.code).device).toMatchObject({
      isSimulated: true,
      adapter: 'simulated',
    });
    const byCode = (await op.call('GET', `/v1/operator/scooters?q=${s.code}`)).json();
    expect(byCode).toHaveLength(1);

    await h.pool.query(`update scooters set status = 'in_ride' where id = $1`, [s.id]);
    const blocked = await op.call('PATCH', `/v1/operator/scooters/${s.id}/status`, {
      status: 'maintenance',
      reason: 'x test',
    });
    expect(blocked.statusCode).toBe(409);
    await h.pool.query(`update scooters set status = 'available' where id = $1`, [s.id]);
    expect(
      (
        await op.call('PATCH', `/v1/operator/scooters/${s.id}/status`, {
          status: 'retired',
          reason: 'x test',
        })
      ).statusCode,
    ).toBe(400);
    const audit = await h.pool.query(
      `select count(*)::int n from audit_log where target_type = 'scooter' and target_id = $1`,
      [s.id],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('manages maintenance/repositioning tasks and alerts', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const s = await onboardScooter(t, admin);
    const task = await op.call('POST', '/v1/operator/maintenance', {
      scooterId: s.id,
      kind: 'reposition',
      notes: 'Move to Meskel Square parking',
      assignedToStaffId: op.staffId,
    });
    expect(task.statusCode).toBe(201);
    expect(
      (await op.call('GET', '/v1/operator/maintenance?mine=true'))
        .json()
        .map((m: { id: string }) => m.id),
    ).toContain(task.json().id);
    const done = await op.call('PATCH', `/v1/operator/maintenance/${task.json().id}`, {
      status: 'done',
      notes: 'Moved',
    });
    expect(done.json()).toMatchObject({ status: 'done', notes: 'Moved' });
    expect(done.json().completedAt).not.toBeNull();
    expect(
      (await op.call('PATCH', `/v1/operator/maintenance/${task.json().id}`, { status: 'open' }))
        .statusCode,
    ).toBe(409);

    await telemetry(t, { supplierDeviceId: s.supplierDeviceId, batteryPercent: 5 });
    const alerts = (await op.call('GET', '/v1/operator/alerts')).json();
    const alert = alerts.find(
      (a: { scooterId: string; kind: string }) => a.scooterId === s.id && a.kind === 'low_battery',
    );
    expect(
      (await op.call('POST', `/v1/operator/alerts/${alert.id}/acknowledge`)).json().status,
    ).toBe('acknowledged');
    expect((await op.call('POST', `/v1/operator/alerts/${alert.id}/resolve`)).json().status).toBe(
      'resolved',
    );
    expect((await op.call('POST', `/v1/operator/alerts/${alert.id}/resolve`)).statusCode).toBe(409);
  });

  it('retires scooters and refuses to reassign a device that is in use elsewhere', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const a = await onboardScooter(t, admin);
    const b = await onboardScooter(t, admin);
    const steal = await admin.call('POST', `/v1/admin/scooters/${b.id}/device`, {
      deviceId: a.deviceId,
      reason: 'swap test',
    });
    expect(steal.statusCode).toBe(409);
    const retired = await admin.call('POST', `/v1/admin/scooters/${a.id}/retire`, {
      reason: 'frame damage',
    });
    expect(retired.json()).toMatchObject({ status: 'retired', device: null });
    expect(
      (
        await admin.call('POST', `/v1/admin/scooters/${b.id}/device`, {
          deviceId: a.deviceId,
          reason: 'reuse',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('only simulated devices accept simulation scenarios, never in staging', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const sim = await onboardScooter(t, admin);
    const ok = await admin.call('PATCH', `/v1/admin/devices/${sim.deviceId}/simulation`, {
      unlock: 'silence',
      delayMs: 100,
    });
    expect(ok.json()).toMatchObject({ unlock: 'silence', lock: 'ack', delayMs: 100 });
    const devices = (await internal(t, 'GET', '/internal/v1/devices?adapter=simulated')).json();
    expect(devices.find((d: { id: string }) => d.id === sim.deviceId).simulation).toMatchObject({
      unlock: 'silence',
    });
    const real = await onboardScooter(t, admin, { adapter: 'supplier_tcp' });
    expect(
      (await admin.call('PATCH', `/v1/admin/devices/${real.deviceId}/simulation`, {})).statusCode,
    ).toBe(409);
  });
});

describe('zones', () => {
  it('validates geometry, versions updates, serves riders by bbox, and drives service-area alerts', async () => {
    const t = await buildTestApp(h);
    const admin = await signInStaff(t, 'fleet-admin@captain.et');
    const rider = await signInRider(t);
    const bad = await admin.call('POST', '/v1/admin/zones', {
      name: 'Broken',
      kind: 'parking',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [38.7, 9.0],
            [38.8, 9.0],
            [38.8, 9.1],
          ],
        ],
      },
      reason: 'test',
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_GEOMETRY');

    const zone = await admin.call('POST', '/v1/admin/zones', {
      name: 'Test service area',
      kind: 'service_area',
      geometry: square(8.5, 38.5, 0.2),
      reason: 'pilot area',
    });
    expect(zone.statusCode).toBe(201);
    const inView = await t.request({
      method: 'GET',
      url: '/v1/rider/zones?minLat=8.6&minLng=38.6&maxLat=8.65&maxLng=38.65',
      headers: bearer(rider.accessToken),
    });
    expect(inView.json().map((z: { id: string }) => z.id)).toContain(zone.json().id);

    const s = await onboardScooter(t, admin, { lat: 8.6, lng: 38.6 });
    await telemetry(t, { supplierDeviceId: s.supplierDeviceId, lat: 7.0, lng: 38.6 });
    const outside = (await admin.call('GET', `/v1/operator/scooters/${s.id}`)).json().alerts;
    expect(outside.find((a: { kind: string }) => a.kind === 'outside_service_area')?.status).toBe(
      'open',
    );

    const updated = await admin.call('PATCH', `/v1/admin/zones/${zone.json().id}`, {
      active: false,
      reason: 'season ended',
    });
    expect(updated.json()).toMatchObject({ active: false, version: 2 });
  });
});

describe('worker sweeps', () => {
  it('purges expired security data and runs as a single instance', async () => {
    const t = await buildTestApp(h);
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()) };
    await h.pool.query(
      `insert into rate_limit_buckets (key, window_start, count) values ('old', now() - interval '3 days', 1)`,
    );
    expect(await sweepPurge(deps)).toBeGreaterThanOrEqual(1);
    expect(typeof (await sweepStaleTelemetry(deps))).toBe('number');

    const holder = await h.pool.connect();
    try {
      await holder.query(`select pg_advisory_lock(7102026)`);
      expect(await runSweepsOnce(deps)).toBeNull();
      await holder.query(`select pg_advisory_unlock(7102026)`);
    } finally {
      holder.release();
    }
    expect(await runSweepsOnce(deps)).toMatchObject({
      commandTimeouts: expect.any(Number),
      purge: expect.any(Number),
    });
  });
});

describe('fleet authorization', () => {
  it('lets operators run fleet operations but not onboarding, zones or simulation controls', async () => {
    const t = await buildTestApp(h);
    const op = await signInStaff(t, 'fleet-op@captain.et');
    const rider = await signInRider(t);
    const ID = '00000000-0000-4000-8000-000000000000';
    const adminOnly: ['POST' | 'PATCH', string, unknown][] = [
      ['POST', '/v1/admin/scooters', { code: 'OP-TRY', reason: 'escalation' }],
      [
        'POST',
        '/v1/admin/devices',
        { supplierDeviceId: 'OP-TRY', adapter: 'simulated', reason: 'escalation' },
      ],
      ['POST', `/v1/admin/scooters/${ID}/device`, { deviceId: ID, reason: 'escalation' }],
      ['POST', `/v1/admin/scooters/${ID}/device/unassign`, { reason: 'escalation' }],
      ['POST', `/v1/admin/scooters/${ID}/retire`, { reason: 'escalation' }],
      ['PATCH', `/v1/admin/devices/${ID}/simulation`, {}],
      [
        'POST',
        '/v1/admin/zones',
        { name: 'x', kind: 'parking', geometry: square(9, 38), reason: 'escalation' },
      ],
      ['PATCH', `/v1/admin/zones/${ID}`, { reason: 'escalation' }],
    ];
    for (const [method, url, payload] of adminOnly) {
      expect((await op.call(method, url, payload)).statusCode).toBe(403);
    }
    for (const url of [
      '/v1/operator/scooters',
      '/v1/operator/alerts',
      '/v1/operator/maintenance',
      '/v1/operator/zones',
    ]) {
      expect((await op.call('GET', url)).statusCode).toBe(200);
      expect(
        (await t.request({ method: 'GET', url, headers: bearer(rider.accessToken) })).statusCode,
      ).toBe(403);
    }
  });
});
