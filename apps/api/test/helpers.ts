import { randomInt } from 'node:crypto';
import { loadApiConfig } from '@captain/config';
import type { InjectOptions } from 'fastify';
import { createPool, type Pool } from '@captain/db';
import { createMigratedTestDatabase, type TestDatabase } from '@captain/db/testing';
import { buildApp } from '../src/app';
import { LogOnlySender, type OtpSenders } from '../src/auth/senders';

export const WEB_ORIGIN = 'http://localhost:3001';

export interface Harness {
  db: TestDatabase;
  pool: Pool;
}

export async function createHarness(): Promise<Harness> {
  const db = await createMigratedTestDatabase();
  return { db, pool: createPool({ connectionString: db.url, max: 5 }) };
}

export async function destroyHarness(h: Harness | undefined) {
  await h?.pool.end();
  await h?.db.drop();
}

/** A fresh random client IP so per-IP rate limits never couple tests. */
export const randomIp = () => `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

export async function buildTestApp(
  h: Harness,
  env: Record<string, string> = {},
  senders?: OtpSenders,
) {
  let nowMs = Date.parse('2026-10-04T12:00:00Z');
  const lines: string[] = [];
  const config = loadApiConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: h.db.url,
    OTP_SMS_PROVIDER: 'log_only',
    OTP_EMAIL_PROVIDER: 'log_only',
    COOKIE_SECURE: 'false',
    ...env,
  });
  const otpSenders = senders ?? {
    sms: new LogOnlySender('sms'),
    email: new LogOnlySender('email'),
  };
  const app = await buildApp({
    config,
    pool: h.pool,
    senders: otpSenders,
    now: () => new Date(nowMs),
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
