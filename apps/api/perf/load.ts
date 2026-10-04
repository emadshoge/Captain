/**
 * Reproducible load test (Phase 12). Drives the built API + worker against a
 * throwaway PostgreSQL database with a documented, SIMULATED workload:
 *
 *   - PERF_SCOOTERS scooters reporting telemetry every 10 s (batched, as the
 *     gateway does), plus a gateway loop acknowledging commands;
 *   - PERF_RIDERS riders browsing: nearby search + wallet every 5 s;
 *   - PERF_RIDING of those riders riding continuously: start → unlock ack →
 *     ride PERF_RIDE_SECONDS → end → lock ack, repeat.
 *
 * Results (latency percentiles per operation, errors, ride lifecycle times)
 * are printed as JSON and written to PERF_OUT when set. Thresholds below are
 * the acceptance limits for THIS test on the machine it runs on; they are not
 * capacity claims for production.
 *
 * Usage: pnpm build && pnpm --filter @captain/api perf
 */
import { writeFileSync } from 'node:fs';
import {
  Proc,
  Stats,
  apiEnv,
  call,
  fundRider,
  internal,
  seedScooters,
  setupDatabase,
  signInRider,
  sleep,
  waitFor,
} from './lib';

const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const SCOOTERS = num('PERF_SCOOTERS', 300);
const RIDERS = num('PERF_RIDERS', 100);
const RIDING = num('PERF_RIDING', 40);
const DURATION_S = num('PERF_DURATION_SECONDS', 60);
const RIDE_SECONDS = num('PERF_RIDE_SECONDS', 5);

/** Acceptance thresholds for this test (p95 ms, and zero unexpected errors). */
const P95_LIMIT_MS: Record<string, number> = {
  'GET nearby': 500,
  'GET wallet': 300,
  'POST telemetry (batch)': 1_500,
  'POST ride start': 800,
  'POST ride end': 800,
  'GET ride': 300,
  'GET pending commands': 500,
  'POST command result': 500,
};

async function main() {
  const env = await setupDatabase();
  const scooters = await seedScooters(env.pool, SCOOTERS);
  const api = new Proc('api', 'apps/api/dist/server.js', apiEnv(env)).start();
  const worker = new Proc('worker', 'apps/api/dist/worker.js', apiEnv(env)).start();
  const stats = new Stats();
  const lifecycle = {
    unlockMs: [] as number[],
    completeMs: [] as number[],
    rides: 0,
    startRefusals: 0,
  };
  let stopping = false;
  try {
    await waitFor('http://127.0.0.1:3000/ready');

    // Riders sign in through the real OTP flow and get PERF funding.
    const riders: { token: string; riderId: string }[] = [];
    for (let i = 0; i < RIDERS; i++) {
      const rider = await signInRider(
        `+2519${String(70_000_000 + i)}`,
        `10.9.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      );
      await fundRider(env.pool, rider.riderId, 1_000_000);
      riders.push(rider);
    }
    console.log(`seeded ${SCOOTERS} PERF scooters and ${RIDERS} riders; running ${DURATION_S}s`);

    const deadline = Date.now() + DURATION_S * 1000;
    // Riders stop at the deadline; device-side loops keep running until the
    // last rides have finished so no command is left unanswered.
    const until = async (fn: () => Promise<void>) => {
      while (!stopping && Date.now() < deadline) await fn();
    };
    const whileRunning = async (fn: () => Promise<void>) => {
      while (!stopping) await fn();
    };
    const timed = async <T>(
      name: string,
      fn: () => ReturnType<typeof call<T>>,
      ok: (status: number) => boolean,
    ) => {
      const result = await fn();
      stats.record(name, result.ms, result.status, ok(result.status));
      return result;
    };

    // Telemetry: every scooter every 10 s, in batches of 100 (stationary unless riding).
    const telemetry = whileRunning(async () => {
      const started = Date.now();
      for (let i = 0; i < scooters.length; i += 100) {
        const reports = scooters.slice(i, i + 100).map((s) => ({
          supplierDeviceId: s.device,
          recordedAt: new Date().toISOString(),
          lat: s.lat,
          lng: s.lng,
          batteryPercent: 90,
          speedKmh: 0,
          locked: true,
        }));
        await timed(
          'POST telemetry (batch)',
          () => internal('POST', '/internal/v1/telemetry', { reports }),
          (s) => s === 200,
        );
      }
      const wait = Math.max(0, 10_000 - (Date.now() - started));
      for (let waited = 0; waited < wait && !stopping; waited += 250) await sleep(250);
    });

    // Gateway: fetch pending commands and acknowledge them after ~150 ms.
    const gateway = whileRunning(async () => {
      const pending = await timed<{ id: string }[]>(
        'GET pending commands',
        () => internal('GET', '/internal/v1/commands/pending?adapter=simulated') as never,
        (s) => s === 200,
      );
      for (const command of pending.body ?? []) {
        void sleep(150).then(() =>
          timed(
            'POST command result',
            () =>
              internal('POST', `/internal/v1/commands/${command.id}/result`, {
                outcome: 'ack',
                resultCode: 'PERF_OK',
              }),
            (s) => s === 200,
          ),
        );
      }
      await sleep(200);
    });

    // Browsing riders.
    const browsing = riders.map((rider, i) =>
      until(async () => {
        const s = scooters[(i * 7) % scooters.length]!;
        await timed(
          'GET nearby',
          () =>
            call('GET', `/v1/rider/scooters/nearby?lat=${s.lat}&lng=${s.lng}`, {
              token: rider.token,
            }),
          (st) => st === 200,
        );
        await timed(
          'GET wallet',
          () => call('GET', '/v1/rider/wallet', { token: rider.token }),
          (st) => st === 200,
        );
        await sleep(5_000);
      }),
    );

    // Riding riders: each uses its own slice of scooters so collisions are not the bottleneck.
    const perRider = Math.max(1, Math.floor(scooters.length / Math.max(1, RIDING)));
    const riding = riders.slice(0, RIDING).map((rider, i) => {
      let next = 0;
      return until(async () => {
        const scooter = scooters[i * perRider + (next++ % perRider)]!;
        const startedAt = performance.now();
        const start = await timed<{ id: string }>(
          'POST ride start',
          () =>
            call('POST', '/v1/rider/rides', {
              token: rider.token,
              body: { code: scooter.code },
              headers: { 'idempotency-key': `perf-${rider.riderId}-${Date.now()}-${next}` },
            }),
          (st) => st === 201 || st === 409,
        );
        if (start.status !== 201) {
          lifecycle.startRefusals++;
          await sleep(1_000);
          return;
        }
        const rideId = start.body.id;
        const waitStatus = async (want: string[], timeoutMs: number) => {
          const limit = Date.now() + timeoutMs;
          while (Date.now() < limit) {
            const r = await timed<{ status: string }>(
              'GET ride',
              () => call('GET', `/v1/rider/rides/${rideId}`, { token: rider.token }),
              (st) => st === 200,
            );
            if (want.includes(r.body.status)) return r.body.status;
            await sleep(100);
          }
          return 'timeout';
        };
        const afterStart = await waitStatus(['active', 'start_failed'], 30_000);
        lifecycle.unlockMs.push(performance.now() - startedAt);
        if (afterStart !== 'active') return;
        await sleep(RIDE_SECONDS * 1000);
        const endAt = performance.now();
        await timed(
          'POST ride end',
          () => call('POST', `/v1/rider/rides/${rideId}/end`, { token: rider.token, body: {} }),
          (st) => st === 200,
        );
        const final = await waitStatus(['completed', 'operator_review'], 30_000);
        lifecycle.completeMs.push(performance.now() - endAt);
        if (final === 'completed') lifecycle.rides++;
      });
    });

    await Promise.all([...browsing, ...riding]);
    stopping = true;
    await Promise.all([telemetry, gateway]);
    await sleep(500);

    const ledger = await env.pool.query<{ total: string }>(
      `select coalesce(sum(amount_santim), 0)::bigint as total from ledger_lines`,
    );
    const stuck = await env.pool.query<{ n: number }>(
      `select count(*)::int n from rides where status = 'operator_review'`,
    );
    const pct = (values: number[], p: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0,
      );
    };
    const operations = stats.summary();
    const result = {
      when: new Date().toISOString(),
      machine: { cpus: (await import('node:os')).cpus().length, node: process.version },
      workload: {
        scooters: SCOOTERS,
        riders: RIDERS,
        riding: RIDING,
        durationSeconds: DURATION_S,
        rideSeconds: RIDE_SECONDS,
      },
      operations,
      rides: {
        completed: lifecycle.rides,
        startRefusals: lifecycle.startRefusals,
        startToActiveP50: pct(lifecycle.unlockMs, 50),
        startToActiveP95: pct(lifecycle.unlockMs, 95),
        endToCompletedP50: pct(lifecycle.completeMs, 50),
        endToCompletedP95: pct(lifecycle.completeMs, 95),
      },
      invariants: {
        ledgerSum: Number(ledger.rows[0]!.total),
        ridesInOperatorReview: stuck.rows[0]!.n,
      },
      processes: { apiAlive: api.alive, workerAlive: worker.alive },
    };
    console.log(JSON.stringify(result, null, 2));
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(result, null, 2));

    const failures: string[] = [];
    for (const op of operations) {
      if (op.errors > 0)
        failures.push(
          `${op.name}: ${op.errors} unexpected responses ${JSON.stringify(op.errorStatuses)}`,
        );
      const limit = P95_LIMIT_MS[op.name];
      if (limit !== undefined && op.p95 > limit)
        failures.push(`${op.name}: p95 ${op.p95} ms > ${limit} ms`);
    }
    if (result.invariants.ledgerSum !== 0) failures.push('ledger does not sum to zero');
    if (result.invariants.ridesInOperatorReview > 0)
      failures.push('rides ended in operator review under normal load');
    if (lifecycle.rides === 0) failures.push('no ride completed');
    if (!api.alive || !worker.alive) failures.push('a process died during the test');
    if (failures.length) {
      console.error(`LOAD TEST FAILED:\n- ${failures.join('\n- ')}`);
      process.exitCode = 1;
    } else {
      console.log('load test passed');
    }
  } finally {
    stopping = true;
    await api.stop();
    await worker.stop();
    await env.pool.end();
    await env.db.drop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
