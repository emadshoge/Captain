import { randomBytes, randomInt } from 'node:crypto';
import pg from 'pg';
import { loadApiConfig } from '@captain/config';
import type { InjectOptions } from 'fastify';
import { createPool, type Pool } from '@captain/db';
import { createMigratedTestDatabase, type TestDatabase } from '@captain/db/testing';
import { buildApp } from '../src/app';
import { LogOnlySender, type OtpSenders } from '../src/auth/senders';
import type { PaymentProvider } from '../src/wallet/providers';

export const WEB_ORIGIN = 'http://localhost:3001';

export interface Harness {
  db: TestDatabase;
  /** Database owner: test setup and inspection. */
  pool: Pool;
  /**
   * The app's pool connects as a runtime login role that is only a member of
   * the least-privilege `captain_app` role, exactly like staging/production
   * (deploy/staging). Missing grants fail here instead of after a deploy.
   */
  appPool: Pool;
  appUser: string;
}

export async function createHarness(): Promise<Harness> {
  const db = await createMigratedTestDatabase();
  const pool = createPool({ connectionString: db.url, max: 5 });
  const appUser = `captain_rt_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  await pool.query(`create role ${appUser} login password '${password}' in role captain_app`);
  const url = new URL(db.url);
  url.username = appUser;
  url.password = password;
  return { db, pool, appPool: createPool({ connectionString: url.toString(), max: 5 }), appUser };
}

export async function destroyHarness(h: Harness | undefined) {
  if (!h) return;
  await h.appPool.end();
  await h.pool.end();
  await h.db.drop();
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`drop role if exists ${h.appUser}`);
  } finally {
    await admin.end();
  }
}

/** A fresh random client IP so per-IP rate limits never couple tests. */
export const randomIp = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

let appSequence = 0;

export async function buildTestApp(
  h: Harness,
  env: Record<string, string> = {},
  senders?: OtpSenders,
  paymentProvider?: PaymentProvider | null,
) {
  // Each test app gets its own 2-hour time window so OTP cooldowns and hourly
  // limits (which are real and shared via the database) never couple tests.
  let nowMs = Date.parse('2026-10-04T12:00:00Z') + appSequence++ * 2 * 3_600_000;
  const lines: string[] = [];
  const config = loadApiConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: h.db.url,
    OTP_SMS_PROVIDER: 'log_only',
    OTP_EMAIL_PROVIDER: 'log_only',
    COOKIE_SECURE: 'false',
    STAFF_MFA_REQUIRED: 'false',
    ...env,
  });
  const otpSenders = senders ?? {
    sms: new LogOnlySender('sms'),
    email: new LogOnlySender('email'),
  };
  const app = await buildApp({
    config,
    pool: h.appPool,
    senders: otpSenders,
    now: () => new Date(nowMs),
    ...(paymentProvider === undefined ? {} : { paymentProvider }),
    logDestination: { write: (line: string) => void lines.push(line) },
  });
  const ip = randomIp();
  return {
    app,
    config,
    senders: otpSenders,
    lines,
    ip,
    advance: (ms: number) => {
      nowMs += ms;
    },
    now: () => nowMs,
    lastCode(destination: string) {
      const all = [otpSenders.sms, otpSenders.email]
        .filter((s): s is LogOnlySender => s instanceof LogOnlySender)
        .flatMap((s) => s.outbox)
        .filter((e) => e.destination === destination);
      return all.at(-1)?.code;
    },
    request(opts: InjectOptions) {
      return app.inject({ remoteAddress: ip, ...opts });
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

/** Full rider sign-in over SMS; returns mobile tokens. */
export async function signInRider(
  t: TestApp,
  phone = `+2519${String(randomInt(10_000_000, 99_999_999))}`,
) {
  const req = await t.request({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { audience: 'rider', channel: 'sms', destination: phone },
  });
  if (req.statusCode !== 202) throw new Error(`otp request failed: ${req.statusCode} ${req.body}`);
  const { challengeId } = req.json();
  const verify = await t.request({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { challengeId, code: t.lastCode(phone), client: 'mobile' },
  });
  if (verify.statusCode !== 200)
    throw new Error(`otp verify failed: ${verify.statusCode} ${verify.body}`);
  return { ...verify.json(), phone } as {
    phone: string;
    sessionId: string;
    accessToken: string;
    refreshToken: string;
    subject: { type: 'rider'; riderId: string; needsOnboarding: boolean };
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface StaffSession {
  staffId: string;
  cookie: string;
  csrfToken: string;
  /** Request as this staff member (adds cookie, Origin and CSRF header). */
  call: (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => ReturnType<TestApp['request']>;
}

/** Signs a staff member in on the web (email OTP, optional TOTP). */
export async function signInStaff(
  t: TestApp,
  email: string,
  totpCode?: string,
): Promise<StaffSession> {
  const req = await t.request({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { audience: 'staff', channel: 'email', destination: email },
  });
  if (req.statusCode !== 202) {
    const errors = t.lines.filter((line) => line.includes('"level":"error"')).slice(-1);
    throw new Error(`staff otp request failed: ${req.body} ${errors.join('')}`);
  }
  const verify = await t.request({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    headers: { origin: WEB_ORIGIN },
    payload: {
      challengeId: req.json().challengeId,
      code: t.lastCode(email),
      client: 'web',
      ...(totpCode ? { totpCode } : {}),
    },
  });
  if (verify.statusCode !== 200) {
    const error = new Error(`staff otp verify failed: ${verify.statusCode} ${verify.body}`);
    Object.assign(error, { response: verify });
    throw error;
  }
  const cookie = (verify.cookies as { name: string; value: string }[])
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const csrfToken = verify.json().csrfToken as string;
  return {
    staffId: verify.json().subject.staffId,
    cookie,
    csrfToken,
    call: (method, url, payload) =>
      t.request({
        method,
        url,
        headers: { cookie, origin: WEB_ORIGIN, 'x-csrf-token': csrfToken },
        ...(payload === undefined ? {} : { payload: payload as object }),
      }),
  };
}

/**
 * Posts a balanced test journal between a system account and a rider wallet
 * (positive = credit the rider). Rolls back on any error.
 */
export async function postTestJournal(
  pool: Pool,
  riderId: string,
  amountSantim: number,
  systemAccount: 'adjustments' | 'refunds' | 'provider_clearing' = 'adjustments',
  kind: 'adjustment' | 'refund' | 'topup' = 'adjustment',
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const journal = await client.query<{ id: string }>(
      `insert into journal_entries (kind, reference_type, reference_id, description, created_by_type)
       values ($1, 'test', gen_random_uuid()::text, 'test journal', 'system') returning id`,
      [kind],
    );
    const journalId = journal.rows[0]!.id;
    await client.query(
      `insert into ledger_lines (journal_id, account_id, amount_santim)
       select $1::uuid, id, -$2::bigint from ledger_accounts where type = $3::ledger_account_type and rider_id is null`,
      [journalId, amountSantim, systemAccount],
    );
    await client.query(
      `insert into ledger_lines (journal_id, account_id, amount_santim)
       select $1::uuid, id, $2::bigint from ledger_accounts where type = 'rider_wallet' and rider_id = $3::uuid`,
      [journalId, amountSantim, riderId],
    );
    await client.query('commit');
    return journalId;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
