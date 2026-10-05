/**
 * Staging rehearsal (no Docker needed). Runs the built bundles with the SAME
 * configuration the staging kit (deploy/staging) gives them and walks the
 * first-day path an owner follows on a fresh server:
 *
 *   migrations as the owner → runtime user created with the kit's own SQL
 *   (least-privilege captain_app member) → API, worker and SIMULATED gateway
 *   in APP_ENV=staging → first admin via the staff CLI → staff email code over
 *   SMTP with STARTTLS (local catcher, self-signed certificate) → TOTP
 *   enrolment → pricing plan → simulated scooter onboarding → rider email
 *   sign-in → audited wallet adjustment → ride start/unlock/end/charge.
 *
 * Needs TEST_DATABASE_ADMIN_URL, openssl and `pnpm build`.
 * Usage: pnpm --filter @captain/api staging-rehearsal
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';
import { createTestDatabase } from '@captain/db/testing';
import { totpAt } from '../src/lib/totp';
import { API, Proc, ROOT, call, sleep, waitFor } from './lib';

const RIDER_ORIGIN = 'http://localhost:3001';
const STAFF_ORIGIN = 'http://localhost:3002';
const SMTP_PORT = 2587;

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The runtime-user SQL block from deploy/staging/lib.sh, so the rehearsal runs exactly what the kit runs. */
function runtimeRoleSql(password: string): string {
  const script = readFileSync(resolve(ROOT, 'deploy/staging/lib.sh'), 'utf8');
  const match = /<<SQL\n([\s\S]*?)\nSQL\n/.exec(script);
  if (!match) throw new Error('runtime role SQL not found in deploy/staging/lib.sh');
  return match[1]!.replaceAll('\\$', '$').replaceAll('$API_DB_PASSWORD', password);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'captain-staging-rehearsal-'));
  const db = await createTestDatabase();
  const procs: Proc[] = [];
  const mail: { to: string; text: string }[] = [];
  let smtp: SMTPServer | null = null;
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    console.log(`ok - ${s}`);
  };
  try {
    // Self-signed certificate for the local SMTP catcher (STARTTLS required).
    const key = join(work, 'smtp.key');
    const cert = join(work, 'smtp.crt');
    const ssl = spawnSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      key,
      '-out',
      cert,
    ]);
    check(ssl.status === 0, `openssl failed: ${ssl.stderr}`);
    const smtpPassword = randomBytes(16).toString('hex');
    smtp = new SMTPServer({
      key: readFileSync(key),
      cert: readFileSync(cert),
      authOptional: false,
      allowInsecureAuth: false,
      onAuth(auth, _session, cb) {
        if (auth.username === 'rehearsal' && auth.password === smtpPassword)
          return cb(null, { user: 'rehearsal' });
        cb(new Error('bad credentials'));
      },
      onData(stream, session, cb) {
        check(session.secure, 'mail was sent without TLS');
        let raw = '';
        stream.on('data', (c: Buffer) => (raw += c.toString()));
        stream.on('end', () => {
          mail.push({ to: session.envelope.rcptTo.map((r) => r.address).join(','), text: raw });
          cb();
        });
      },
    });
    await new Promise<void>((done) => smtp!.listen(SMTP_PORT, '127.0.0.1', done));
    const codeFor = async (to: string) => {
      for (let i = 0; i < 100; i++) {
        const m = mail.filter((x) => x.to === to).at(-1);
        const code = m && /\b(\d{6})\b/.exec(m.text.split('\r\n\r\n').slice(1).join('\n'))?.[1];
        if (code) return code;
        await sleep(100);
      }
      throw new Error(`no email code for ${to}`);
    };

    // 1. Release job: migrations as the database owner, then the runtime user.
    const migrate = spawnSync('node', ['apps/api/dist/cli/migrate.js'], {
      cwd: ROOT,
      env: { ...process.env, APP_ENV: 'staging', DATABASE_URL: db.url },
      encoding: 'utf8',
    });
    check(migrate.status === 0, `migrate failed: ${migrate.stderr}`);
    const apiDbPassword = randomBytes(32).toString('hex');
    const owner = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await owner.query(runtimeRoleSql(apiDbPassword));
    await owner.end();
    const runtimeUrl = new URL(db.url);
    runtimeUrl.username = 'captain_api';
    runtimeUrl.password = apiDbPassword;
    step(
      'migrations as owner; runtime user captain_api (captain_app member) from the staging kit SQL',
    );

    // 2. Services with the staging kit's configuration.
    const internalToken = randomBytes(32).toString('hex');
    const apiEnv = {
      APP_ENV: 'staging',
      LOG_LEVEL: 'warn',
      HOST: '127.0.0.1',
      PORT: '3000',
      DATABASE_URL: runtimeUrl.toString(),
      TRUST_PROXY: '1',
      AUTH_SECRET: randomBytes(32).toString('hex'),
      INTERNAL_API_TOKEN: internalToken,
      CORS_ORIGINS: `${RIDER_ORIGIN},${STAFF_ORIGIN}`,
      COOKIE_SECURE: 'true',
      STAFF_MFA_REQUIRED: 'true',
      REFUNDS_REQUIRE_SECOND_APPROVER: 'true',
      AUTH_RIDER_CHANNELS: 'email',
      OTP_SMS_PROVIDER: 'none',
      OTP_EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_SECURE: 'false',
      SMTP_REQUIRE_TLS: 'true',
      SMTP_USER: 'rehearsal',
      SMTP_PASSWORD: smtpPassword,
      EMAIL_FROM: 'Captain Staging <no-reply@captain.test>',
      PAYMENT_PROVIDER: 'none',
      DEVICE_ADAPTER: 'simulated',
      RIDE_BILLING_CUTOFF: 'end_request',
      RIDE_END_CONFIRMATION: 'device_lock',
      RIDE_PARKING_POLICY: 'flag',
      NODE_EXTRA_CA_CERTS: cert,
    };
    procs.push(new Proc('api', 'apps/api/dist/server.js', apiEnv).start());
    procs.push(new Proc('worker', 'apps/api/dist/worker.js', apiEnv).start());
    await waitFor(`${API}/ready`);
    procs.push(
      new Proc('gateway', 'apps/iot-gateway/dist/main.js', {
        APP_ENV: 'staging',
        LOG_LEVEL: 'warn',
        DEVICE_ADAPTER: 'simulated',
        HOST: '127.0.0.1',
        HEALTH_PORT: '3100',
        API_INTERNAL_URL: API,
        INTERNAL_API_TOKEN: internalToken,
        SIM_TELEMETRY_INTERVAL_SECONDS: '1',
      }).start(),
    );
    await waitFor('http://127.0.0.1:3100/health');
    const noToken = await call('GET', '/internal/v1/commands/pending?adapter=simulated');
    check(noToken.status === 401, `internal API without token returned ${noToken.status}`);
    step(
      'API /ready, worker and SIMULATED gateway up in APP_ENV=staging; internal API needs the token',
    );

    // 3. First admin through the staff CLI (as the runtime user, like create-admin.sh).
    const adminEmail = 'staging-admin@captain.test';
    const cli = spawnSync(
      'node',
      [
        'apps/api/dist/cli/staff.js',
        'create',
        '--email',
        adminEmail,
        '--name',
        'Staging Admin',
        '--role',
        'admin',
        '--reason',
        'staging administrator (rehearsal)',
      ],
      {
        cwd: ROOT,
        env: { ...process.env, APP_ENV: 'staging', DATABASE_URL: runtimeUrl.toString() },
        encoding: 'utf8',
      },
    );
    check(cli.status === 0, `staff CLI failed: ${cli.stderr}`);
    step('first admin created with the staff CLI as captain_api');

    // 4. Staff sign-in: email code over STARTTLS, then TOTP enrolment.
    const otp = await call<{ challengeId: string }>('POST', '/v1/auth/otp/request', {
      body: { audience: 'staff', channel: 'email', destination: adminEmail },
      headers: { origin: STAFF_ORIGIN },
    });
    check(otp.status === 202, `staff otp request: ${otp.status} ${JSON.stringify(otp.body)}`);
    const verify = await fetch(`${API}/v1/auth/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: STAFF_ORIGIN },
      body: JSON.stringify({
        challengeId: otp.body.challengeId,
        code: await codeFor(adminEmail),
        client: 'web',
      }),
    });
    check(verify.status === 200, `staff verify: ${verify.status}`);
    const cookies = verify.headers.getSetCookie().map((c) => c.split(';')[0]);
    check(
      verify.headers.getSetCookie().every((c) => /;\s*Secure/i.test(c)),
      'session cookies are not Secure',
    );
    const csrf = ((await verify.json()) as { csrfToken: string }).csrfToken;
    const staff = <T = Record<string, unknown>>(method: string, path: string, body?: unknown) =>
      call<T>(method, path, {
        body,
        headers: {
          cookie: cookies.join('; '),
          origin: STAFF_ORIGIN,
          'x-csrf-token': csrf,
          'idempotency-key': randomBytes(8).toString('hex'),
        },
      });
    const blocked = await staff('GET', '/v1/admin/pricing-plans');
    check(
      blocked.status === 403 || blocked.status === 401,
      `admin API before TOTP: ${blocked.status}`,
    );
    const setup = await staff<{ secret: string }>('POST', '/v1/staff/me/totp/setup', {});
    check(setup.status === 200, `totp setup: ${setup.status}`);
    const confirm = await staff('POST', '/v1/staff/me/totp/confirm', {
      code: totpAt(base32Decode(setup.body.secret), Date.now()),
    });
    check(
      confirm.status === 200,
      `totp confirm: ${confirm.status} ${JSON.stringify(confirm.body)}`,
    );
    step('staff email code delivered over SMTP+STARTTLS; admin API refused until TOTP enrolled');

    // 5. Pricing plan (STAGING TEST values), simulated scooter onboarding.
    const plan = await staff<{ planId: string }>('POST', '/v1/admin/pricing-plans', {
      name: 'STAGING TEST pricing (not a decision)',
      unlockFeeSantim: 1_000,
      perMinuteSantim: 200,
      billingIncrementSeconds: 60,
      pausePerMinuteSantim: null,
      maxPauseMinutes: null,
      minStartBalanceSantim: 2_000,
      holdAmountSantim: 0,
      reservationMinutes: null,
      reservationFeeSantim: null,
      maxRideMinutes: 120,
      lowBalanceFloorSantim: 0,
      reason: 'staging rehearsal',
    });
    check(plan.status === 201, `pricing plan: ${plan.status} ${JSON.stringify(plan.body)}`);
    const active = await staff('POST', `/v1/admin/pricing-plans/${plan.body.planId}/activate`, {
      reason: 'staging rehearsal',
    });
    check(active.status === 200, `activate plan: ${active.status}`);
    const scooter = await staff<{ id: string }>('POST', '/v1/admin/scooters', {
      code: 'STG-0001',
      model: 'Staging simulated',
      reason: 'staging rehearsal',
    });
    check(scooter.status === 201, `scooter: ${scooter.status} ${JSON.stringify(scooter.body)}`);
    const device = await staff<{ id: string }>('POST', '/v1/admin/devices', {
      supplierDeviceId: 'SIM-STG-0001',
      adapter: 'simulated',
      reason: 'staging rehearsal',
    });
    check(device.status === 201, `device: ${device.status}`);
    const assign = await staff('POST', `/v1/admin/scooters/${scooter.body.id}/device`, {
      deviceId: device.body.id,
      reason: 'staging rehearsal',
    });
    check(assign.status === 200, `assign: ${assign.status}`);
    let available = 0;
    for (let i = 0; i < 60 && available !== 200; i++) {
      await sleep(500);
      available = (
        await staff('PATCH', `/v1/operator/scooters/${scooter.body.id}/status`, {
          status: 'available',
          reason: 'staging rehearsal',
        })
      ).status;
    }
    check(available === 200, `scooter never became available (status ${available})`);
    step(
      'pricing plan activated; simulated scooter onboarded, reporting via the gateway, available',
    );

    // 6. Rider: email sign-in, funded by an audited adjustment, rides.
    const riderEmail = 'rider@captain.test';
    const riderOtp = await call<{ challengeId: string }>('POST', '/v1/auth/otp/request', {
      body: { audience: 'rider', channel: 'email', destination: riderEmail },
    });
    check(
      riderOtp.status === 202,
      `rider otp: ${riderOtp.status} ${JSON.stringify(riderOtp.body)}`,
    );
    const riderSession = await call<{ accessToken: string; subject: { riderId: string } }>(
      'POST',
      '/v1/auth/otp/verify',
      {
        body: {
          challengeId: riderOtp.body.challengeId,
          code: await codeFor(riderEmail),
          client: 'mobile',
        },
      },
    );
    check(riderSession.status === 200, `rider verify: ${riderSession.status}`);
    const token = riderSession.body.accessToken;
    const sms = await call('POST', '/v1/auth/otp/request', {
      body: { audience: 'rider', channel: 'sms', destination: '+251911000000' },
    });
    check(sms.status >= 400, 'SMS sign-in should be unavailable in staging');
    const credit = await staff(
      'POST',
      `/v1/admin/riders/${riderSession.body.subject.riderId}/adjustments`,
      {
        amountSantim: 10_000,
        reason: 'staging tester credit',
      },
    );
    check(credit.status === 201, `adjustment: ${credit.status} ${JSON.stringify(credit.body)}`);
    // The gateway refreshes its device list every 60 s, so a newly onboarded
    // scooter comes online within about a minute.
    let online = false;
    for (let i = 0; i < 90 && !online; i++) {
      const detail = await staff<{ device: { online: boolean } | null }>(
        'GET',
        `/v1/operator/scooters/${scooter.body.id}`,
      );
      online = detail.body.device?.online === true;
      if (!online) await sleep(1_000);
    }
    check(online, 'device never came online');
    const start = await call<{ id: string }>('POST', '/v1/rider/rides', {
      token,
      body: { code: 'STG-0001' },
      headers: { 'idempotency-key': randomBytes(8).toString('hex') },
    });
    check(start.status === 201, `ride start: ${start.status} ${JSON.stringify(start.body)}`);
    const waitStatus = async (want: string) => {
      for (let i = 0; i < 120; i++) {
        const r = await call<{
          status: string;
          chargedSantim: number | null;
          isSimulated: boolean;
        }>('GET', `/v1/rider/rides/${start.body.id}`, { token });
        if (r.body.status === want) return r.body;
        await sleep(250);
      }
      throw new Error(`ride never reached ${want}`);
    };
    const activeRide = await waitStatus('active');
    check(activeRide.isSimulated, 'ride is not labelled simulated');
    await sleep(1_500);
    const end = await call('POST', `/v1/rider/rides/${start.body.id}/end`, { token, body: {} });
    check(end.status === 200, `ride end: ${end.status} ${JSON.stringify(end.body)}`);
    const done = await waitStatus('completed');
    check(
      done.chargedSantim === 1_200,
      `charged ${done.chargedSantim}, expected 1200 (unlock + 1 min)`,
    );
    const wallet = await call<{ balanceSantim: number }>('GET', '/v1/rider/wallet', { token });
    check(
      wallet.body.balanceSantim === 8_800,
      `wallet ${wallet.body.balanceSantim}, expected 8800`,
    );
    step(
      'rider email sign-in (SMS refused); audited credit; simulated ride charged ETB 12.00 once',
    );

    const ledger = new pg.Client({ connectionString: db.url });
    await ledger.connect();
    const sum = await ledger.query<{ s: string }>(
      'select coalesce(sum(amount_santim),0)::bigint s from ledger_lines',
    );
    await ledger.end();
    check(Number(sum.rows[0]!.s) === 0, `ledger sum is ${sum.rows[0]!.s}, expected 0`);
    for (const p of procs) check(p.alive, `${p.name} exited`);
    step('ledger balances; all processes still running');
    console.log(`STAGING REHEARSAL PASS (${steps.length} steps, ${mail.length} emails over TLS)`);
  } finally {
    for (const p of procs.reverse()) await p.stop();
    await new Promise<void>((done) => (smtp ? smtp.close(() => done()) : done()));
    await db.drop();
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error('STAGING REHEARSAL FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
