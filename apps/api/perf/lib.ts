/**
 * Shared helpers for the load test and failure drills: throwaway database,
 * process control for the built API/worker bundles, HTTP helpers, stats.
 * PERF data is labelled and lives only in the throwaway database.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEV_INTERNAL_API_TOKEN } from '@captain/config';
import { createPool, loadDevFixtures, type Pool } from '@captain/db';
import { createMigratedTestDatabase, type TestDatabase } from '@captain/db/testing';

export const ROOT = resolve(import.meta.dirname, '../../..');
export const API = 'http://127.0.0.1:3000';
export const INTERNAL_TOKEN = DEV_INTERNAL_API_TOKEN;

export interface Env {
  db: TestDatabase;
  pool: Pool;
}

export async function setupDatabase(): Promise<Env> {
  for (const bundle of ['apps/api/dist/server.js', 'apps/api/dist/worker.js']) {
    if (!existsSync(resolve(ROOT, bundle)))
      throw new Error(`missing ${bundle}; run pnpm build first`);
  }
  const db = await createMigratedTestDatabase();
  const pool = createPool({ connectionString: db.url, max: 4 });
  await loadDevFixtures(pool, { APP_ENV: 'development' });
  return { db, pool };
}

export function apiEnv(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: 'development',
    LOG_LEVEL: 'warn',
    DATABASE_URL: env.db.url,
    PORT: '3000',
    PAYMENT_PROVIDER: 'fake',
    OTP_SMS_PROVIDER: 'log_only',
    OTP_EMAIL_PROVIDER: 'log_only',
    COOKIE_SECURE: 'false',
    STAFF_MFA_REQUIRED: 'false',
    // Load clients come from one machine; per-IP limits use X-Forwarded-For here.
    TRUST_PROXY: '1',
    ...extra,
  };
}

export class Proc {
  private child: ChildProcess | null = null;
  constructor(
    readonly name: string,
    private readonly script: string,
    private readonly env: Record<string, string>,
  ) {}

  start() {
    this.child = spawn('node', [this.script], {
      cwd: ROOT,
      env: { ...process.env, ...this.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (process.env.PERF_VERBOSE) process.stderr.write(`[${this.name}] ${chunk}`);
    });
    return this;
  }

  get alive() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(signal: NodeJS.Signals = 'SIGTERM') {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 8_000);
      child.once('exit', () => {
        clearTimeout(force);
        done();
      });
      child.kill(signal);
    });
  }
}

export async function waitFor(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return Date.now();
    } catch {
      // not ready
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CallResult<T = unknown> {
  status: number;
  body: T;
  ms: number;
}

export async function call<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
): Promise<CallResult<T>> {
  const started = performance.now();
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await response.text();
  const ms = performance.now() - started;
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // keep text
  }
  return { status: response.status, body: body as T, ms };
}

export const internal = (method: string, path: string, body?: unknown) =>
  call(method, path, { body, headers: { authorization: `Bearer ${INTERNAL_TOKEN}` } });

/** Signs a rider in through the real OTP flow (log-only sender, dev outbox). */
export async function signInRider(
  phone: string,
  ip: string,
): Promise<{ token: string; riderId: string }> {
  const request = await call<{ challengeId: string }>('POST', '/v1/auth/otp/request', {
    body: { audience: 'rider', channel: 'sms', destination: phone },
    ip,
  });
  if (request.status !== 202)
    throw new Error(`otp request ${request.status} ${JSON.stringify(request.body)}`);
  const outbox = await call<{ messages: { code: string }[] }>(
    'GET',
    `/v1/dev/outbox?destination=${encodeURIComponent(phone)}`,
  );
  const verify = await call<{ accessToken: string; subject: { riderId: string } }>(
    'POST',
    '/v1/auth/otp/verify',
    {
      body: {
        challengeId: request.body.challengeId,
        code: outbox.body.messages.at(-1)!.code,
        client: 'mobile',
      },
      ip,
    },
  );
  if (verify.status !== 200) throw new Error(`otp verify ${verify.status}`);
  return { token: verify.body.accessToken, riderId: verify.body.subject.riderId };
}

/** Credits a PERF rider through a balanced ledger journal (throwaway database only). */
export async function fundRider(pool: Pool, riderId: string, santim: number) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const wallet = await client.query<{ id: string }>(
      `insert into ledger_accounts (type, rider_id) values ('rider_wallet', $1)
       on conflict (rider_id) where type = 'rider_wallet' do update set rider_id = excluded.rider_id returning id`,
      [riderId],
    );
    const system = await client.query<{ id: string }>(
      `select id from ledger_accounts where type = 'adjustments' and rider_id is null`,
    );
    const journal = await client.query<{ id: string }>(
      `insert into journal_entries (kind, reference_type, reference_id, description, created_by_type)
       values ('adjustment', 'perf', $1, 'PERF test funding (throwaway database)', 'system') returning id`,
      [randomBytes(8).toString('hex')],
    );
    await client.query(
      `insert into ledger_lines (journal_id, account_id, amount_santim) values ($1, $2, $3), ($1, $4, $5)`,
      [journal.rows[0]!.id, wallet.rows[0]!.id, santim, system.rows[0]!.id, -santim],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Adds PERF scooters with simulated devices around central Addis Ababa. */
export async function seedScooters(pool: Pool, count: number) {
  const codes: { code: string; device: string; lat: number; lng: number }[] = [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (let i = 1; i <= count; i++) {
      const code = `PERF-${String(i).padStart(4, '0')}`;
      const lat = 9.0 + ((i * 37) % 200) / 10_000;
      const lng = 38.74 + ((i * 53) % 200) / 10_000;
      const scooter = await client.query<{ id: string }>(
        `insert into scooters (code, qr_token, model, status, battery_percent, last_lat, last_lng, last_location_at, last_telemetry_at)
         values ($1, $2, 'PERF simulated scooter', 'available', 90, $3, $4, now(), now()) returning id`,
        [code, `perf-qr-${i}-${randomBytes(6).toString('hex')}`, lat, lng],
      );
      const device = await client.query<{ id: string }>(
        `insert into devices (supplier_device_id, adapter, is_simulated, metadata, online, last_seen_at)
         values ($1, 'simulated', true, '{"perf": true}', true, now()) returning id`,
        [`SIM-${code}`],
      );
      await client.query(`insert into device_assignments (device_id, scooter_id) values ($1, $2)`, [
        device.rows[0]!.id,
        scooter.rows[0]!.id,
      ]);
      codes.push({ code, device: `SIM-${code}`, lat, lng });
    }
    await client.query('commit');
  } finally {
    client.release();
  }
  return codes;
}

export class Stats {
  private readonly samples = new Map<string, number[]>();
  private readonly errors = new Map<string, Map<number, number>>();

  record(name: string, ms: number, status: number, ok: boolean) {
    if (!this.samples.has(name)) this.samples.set(name, []);
    this.samples.get(name)!.push(ms);
    if (!ok) {
      const byStatus = this.errors.get(name) ?? new Map<number, number>();
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
      this.errors.set(name, byStatus);
    }
  }

  summary() {
    const pct = (sorted: number[], p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
    return [...this.samples.entries()].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const errors = [...(this.errors.get(name)?.entries() ?? [])];
      return {
        name,
        count: values.length,
        errors: errors.reduce((n, [, c]) => n + c, 0),
        errorStatuses: Object.fromEntries(errors),
        p50: Math.round(pct(sorted, 50)),
        p95: Math.round(pct(sorted, 95)),
        p99: Math.round(pct(sorted, 99)),
        max: Math.round(sorted.at(-1) ?? 0),
      };
    });
  }
}
