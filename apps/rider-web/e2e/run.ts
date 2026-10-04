/**
 * End-to-end harness: a throwaway PostgreSQL database (migrated, with
 * labelled dev fixtures), the real API, worker and SIMULATED device gateway
 * (built bundles), and the built rider web app; then Playwright.
 *
 * Needs TEST_DATABASE_ADMIN_URL and a prior `pnpm build`. Ports 3000
 * (API), 3001 (web) and 3100 (gateway health) must be free.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, loadDevFixtures } from '@captain/db';
import { createMigratedTestDatabase } from '@captain/db/testing';

const root = resolve(import.meta.dirname, '../../..');
const children: ChildProcess[] = [];

function start(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd = root,
) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = (chunk: Buffer) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk}`);
  };
  child.stdout?.on('data', log);
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code && !stopping) console.error(`${name} exited with ${code}`);
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

let stopping = false;

async function main() {
  for (const bundle of [
    'apps/api/dist/server.js',
    'apps/api/dist/worker.js',
    'apps/iot-gateway/dist/main.js',
    'apps/rider-web/.next/BUILD_ID',
  ]) {
    if (!existsSync(resolve(root, bundle)))
      throw new Error(`missing ${bundle}; run pnpm build first`);
  }
  const db = await createMigratedTestDatabase();
  const pool = createPool({ connectionString: db.url, max: 2 });
  const fixtures = await loadDevFixtures(pool, { APP_ENV: 'development' });
  await pool.end();
  console.log(`e2e database ready (${fixtures.scooters} simulated scooters, DEV FIXTURE pricing)`);

  const common = {
    APP_ENV: 'development',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    DATABASE_URL: db.url,
  };
  let exitCode: number;
  try {
    start('api', 'node', ['apps/api/dist/server.js'], {
      ...common,
      PORT: '3000',
      PAYMENT_PROVIDER: 'fake',
      OTP_SMS_PROVIDER: 'log_only',
      OTP_EMAIL_PROVIDER: 'log_only',
      CORS_ORIGINS: 'http://localhost:3001',
      COOKIE_SECURE: 'false',
      STAFF_MFA_REQUIRED: 'false',
      PUBLIC_API_URL: 'http://localhost:3000',
      RIDER_RETURN_URL: 'http://localhost:3001/wallet/return',
    });
    start('worker', 'node', ['apps/api/dist/worker.js'], common);
    start('gateway', 'node', ['apps/iot-gateway/dist/main.js'], {
      ...common,
      DEVICE_ADAPTER: 'simulated',
      API_INTERNAL_URL: 'http://127.0.0.1:3000',
      SIM_TELEMETRY_INTERVAL_SECONDS: '2',
      COMMAND_POLL_INTERVAL_MS: '300',
    });
    start(
      'web',
      'pnpm',
      ['exec', 'next', 'start', '--port', '3001'],
      { NEXT_TELEMETRY_DISABLED: '1' },
      resolve(root, 'apps/rider-web'),
    );
    await waitFor('http://127.0.0.1:3000/health');
    await waitFor('http://localhost:3001/sign-in');

    const playwright = spawn('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], {
      cwd: resolve(root, 'apps/rider-web'),
      stdio: 'inherit',
      env: {
        ...process.env,
        E2E_API_URL: 'http://localhost:3000',
        E2E_WEB_URL: 'http://localhost:3001',
      },
    });
    exitCode = await new Promise<number>((done) =>
      playwright.on('exit', (code) => done(code ?? 1)),
    );
  } finally {
    stopping = true;
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((done) => {
            if (child.exitCode !== null) return done();
            const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
            child.once('exit', () => {
              clearTimeout(force);
              done();
            });
            child.kill('SIGTERM');
          }),
      ),
    );
    await db.drop().catch((error: unknown) => console.error('could not drop e2e database', error));
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  console.error(error);
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(1);
});
