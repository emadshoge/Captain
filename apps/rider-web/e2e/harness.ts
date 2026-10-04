/**
 * End-to-end harness shared by the rider and staff web apps: a throwaway
 * PostgreSQL database (migrated, with labelled dev fixtures), the real API,
 * worker and SIMULATED device gateway (built bundles), both built web apps,
 * optional staff accounts; then Playwright in the requesting app.
 *
 * Needs TEST_DATABASE_ADMIN_URL and a prior `pnpm build`. Ports 3000 (API),
 * 3001 (rider web), 3002 (staff web) and 3100 (gateway health) must be free.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool, loadDevFixtures } from '@captain/db';
import { createMigratedTestDatabase } from '@captain/db/testing';

export interface HarnessOptions {
  /** App whose Playwright suite runs. */
  app: 'rider-web' | 'staff-web';
  staff?: { email: string; name: string; role: 'admin' | 'operator' }[];
  playwrightArgs?: string[];
}

const root = resolve(import.meta.dirname, '../../..');
const children: ChildProcess[] = [];
let stopping = false;

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
  child.stdout?.on('data', (chunk: Buffer) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk}`);
  });
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
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stopAll() {
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
}

export async function runE2E(options: HarnessOptions): Promise<never> {
  for (const bundle of [
    'apps/api/dist/server.js',
    'apps/api/dist/worker.js',
    'apps/iot-gateway/dist/main.js',
    'apps/rider-web/.next/BUILD_ID',
    'apps/staff-web/.next/BUILD_ID',
  ]) {
    if (!existsSync(resolve(root, bundle))) {
      console.error(`missing ${bundle}; run pnpm build first`);
      process.exit(1);
    }
  }
  const db = await createMigratedTestDatabase();
  let exitCode = 1;
  try {
    const pool = createPool({ connectionString: db.url, max: 2 });
    const fixtures = await loadDevFixtures(pool, { APP_ENV: 'development' });
    await pool.end();
    console.log(
      `e2e database ready (${fixtures.scooters} simulated scooters, DEV FIXTURE pricing)`,
    );

    for (const member of options.staff ?? []) {
      const result = spawnSync(
        'pnpm',
        [
          '--filter',
          '@captain/api',
          'exec',
          'tsx',
          'src/cli/staff.ts',
          'create',
          '--email',
          member.email,
          '--name',
          member.name,
          '--role',
          member.role,
          '--reason',
          'e2e test account',
        ],
        {
          cwd: root,
          env: { ...process.env, APP_ENV: 'development', DATABASE_URL: db.url },
          encoding: 'utf8',
        },
      );
      if (result.status !== 0) {
        throw new Error(`could not create staff ${member.email}: ${result.stderr}`);
      }
    }

    const common = {
      APP_ENV: 'development',
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      DATABASE_URL: db.url,
    };
    start('api', 'node', ['apps/api/dist/server.js'], {
      ...common,
      PORT: '3000',
      PAYMENT_PROVIDER: 'fake',
      OTP_SMS_PROVIDER: 'log_only',
      OTP_EMAIL_PROVIDER: 'log_only',
      CORS_ORIGINS: 'http://localhost:3001,http://localhost:3002',
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
    for (const [app, port] of [
      ['rider-web', '3001'],
      ['staff-web', '3002'],
    ] as const) {
      start(
        app,
        'pnpm',
        ['exec', 'next', 'start', '--port', port],
        { NEXT_TELEMETRY_DISABLED: '1' },
        resolve(root, 'apps', app),
      );
    }
    await waitFor('http://127.0.0.1:3000/health');
    await waitFor('http://localhost:3001/sign-in');
    await waitFor('http://localhost:3002/sign-in');

    const playwright = spawn(
      'pnpm',
      ['exec', 'playwright', 'test', ...(options.playwrightArgs ?? [])],
      {
        cwd: resolve(root, 'apps', options.app),
        stdio: 'inherit',
        env: {
          ...process.env,
          E2E_API_URL: 'http://localhost:3000',
          E2E_WEB_URL:
            options.app === 'rider-web' ? 'http://localhost:3001' : 'http://localhost:3002',
        },
      },
    );
    exitCode = await new Promise<number>((done) =>
      playwright.on('exit', (code) => done(code ?? 1)),
    );
  } catch (error) {
    console.error(error);
  } finally {
    await stopAll();
    await db.drop().catch((error: unknown) => console.error('could not drop e2e database', error));
  }
  process.exit(exitCode);
}
