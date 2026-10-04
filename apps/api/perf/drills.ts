/**
 * Failure drills (Phase 12). Each drill runs the built API/worker against a
 * throwaway database, injects a failure and checks that money and ride state
 * stay correct. SIMULATED devices only; the "gateway" is this script.
 *
 * Usage: pnpm build && pnpm --filter @captain/api drills
 */
import pg from 'pg';
import {
  Proc,
  apiEnv,
  call,
  fundRider,
  internal,
  setupDatabase,
  signInRider,
  sleep,
  waitFor,
  type Env,
} from './lib';

interface Rider {
  token: string;
  riderId: string;
}

let riderSeq = 0;
async function newRider(env: Env): Promise<Rider> {
  riderSeq++;
  const rider = await signInRider(`+2519${String(80_000_000 + riderSeq)}`, `10.8.0.${riderSeq}`);
  await fundRider(env.pool, rider.riderId, 100_000);
  return rider;
}

async function stationary(code: string) {
  const r = await internal('POST', '/internal/v1/telemetry', {
    reports: [
      {
        supplierDeviceId: `SIM-${code}`,
        recordedAt: new Date().toISOString(),
        lat: 9.004,
        lng: 38.756,
        batteryPercent: 80,
        speedKmh: 0,
        locked: true,
      },
    ],
  });
  if (r.status !== 200) throw new Error(`telemetry ${r.status}`);
}

async function ackPending(outcome: 'ack' | 'nack' = 'ack') {
  const pending = await internal('GET', '/internal/v1/commands/pending?adapter=simulated');
  for (const command of pending.body as { id: string }[]) {
    await internal('POST', `/internal/v1/commands/${command.id}/result`, { outcome });
  }
  return (pending.body as unknown[]).length;
}

async function rideStatus(rider: Rider, id: string) {
  return (
    await call<{ status: string; chargedSantim: number | null }>('GET', `/v1/rider/rides/${id}`, {
      token: rider.token,
    })
  ).body;
}

async function waitRide(rider: Rider, id: string, want: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ride = await rideStatus(rider, id);
    if (ride.status === want) return ride;
    await sleep(200);
  }
  throw new Error(
    `ride ${id} did not reach ${want} in ${timeoutMs} ms (now ${(await rideStatus(rider, id)).status})`,
  );
}

async function balance(rider: Rider) {
  return (await call<{ balanceSantim: number }>('GET', '/v1/rider/wallet', { token: rider.token }))
    .body.balanceSantim;
}

const results: { drill: string; ok: boolean; detail: string }[] = [];
async function drill(name: string, fn: () => Promise<string>) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ drill: name, ok: true, detail: `${detail} (${Date.now() - started} ms)` });
  } catch (error) {
    results.push({ drill: name, ok: false, detail: (error as Error).message });
  }
}

async function main() {
  const env = await setupDatabase();
  const base = apiEnv(env, { COMMAND_TIMEOUT_SECONDS: '5' });
  let api = new Proc('api', 'apps/api/dist/server.js', base).start();
  const workers = [
    new Proc('worker-1', 'apps/api/dist/worker.js', base).start(),
    new Proc('worker-2', 'apps/api/dist/worker.js', base).start(),
  ];
  try {
    await waitFor('http://127.0.0.1:3000/ready');

    await drill('API killed (SIGKILL) during an active ride', async () => {
      const rider = await newRider(env);
      const before = await balance(rider);
      await stationary('DEV-0001');
      const start = await call<{ id: string }>('POST', '/v1/rider/rides', {
        token: rider.token,
        body: { code: 'DEV-0001' },
        headers: { 'idempotency-key': 'drill-restart-0001' },
      });
      if (start.status !== 201) throw new Error(`start ${start.status}`);
      await ackPending();
      await waitRide(rider, start.body.id, 'active', 5_000);
      await api.stop('SIGKILL');
      const down = Date.now();
      api = new Proc('api', 'apps/api/dist/server.js', base).start();
      const up = await waitFor('http://127.0.0.1:3000/ready');
      // A retried start with the same key after the crash returns the same ride.
      const retry = await call<{ id: string }>('POST', '/v1/rider/rides', {
        token: rider.token,
        body: { code: 'DEV-0001' },
        headers: { 'idempotency-key': 'drill-restart-0001' },
      });
      if (retry.body.id !== start.body.id)
        throw new Error('idempotent retry returned a different ride');
      if ((await rideStatus(rider, start.body.id)).status !== 'active')
        throw new Error('ride lost its state');
      await stationary('DEV-0001');
      await call('POST', `/v1/rider/rides/${start.body.id}/end`, { token: rider.token, body: {} });
      await ackPending();
      const done = await waitRide(rider, start.body.id, 'completed', 5_000);
      const charged = before - (await balance(rider));
      if (charged !== done.chargedSantim || charged <= 0)
        throw new Error(`charged ${charged} vs receipt ${done.chargedSantim}`);
      return `restart took ${up - down} ms; ride completed and charged once (${charged} santim)`;
    });

    await drill('Gateway silent (no unlock acknowledgment) and one worker killed', async () => {
      const rider = await newRider(env);
      const before = await balance(rider);
      await stationary('DEV-0002');
      const start = await call<{ id: string }>('POST', '/v1/rider/rides', {
        token: rider.token,
        body: { code: 'DEV-0002' },
        headers: { 'idempotency-key': 'drill-silent-0002' },
      });
      if (start.status !== 201) throw new Error(`start ${start.status}`);
      await workers[0]!.stop('SIGKILL'); // the other worker must take over the sweeps
      const failed = await waitRide(rider, start.body.id, 'start_failed', 20_000);
      const scooter = await env.pool.query<{ status: string }>(
        `select status::text as status from scooters where code = 'DEV-0002'`,
      );
      const incidents = await env.pool.query<{ n: number }>(
        `select count(*)::int n from incidents where ride_id = $1`,
        [start.body.id],
      );
      if ((await balance(rider)) !== before)
        throw new Error('rider was charged for a failed unlock');
      if (scooter.rows[0]!.status !== 'maintenance')
        throw new Error(`scooter is ${scooter.rows[0]!.status}`);
      if (incidents.rows[0]!.n < 1) throw new Error('no incident opened');
      // A late acknowledgment opens an incident but changes nothing else.
      await ackPending();
      const commands = await env.pool.query<{ n: number }>(
        `select count(*)::int n from device_commands where ride_id = $1`,
        [start.body.id],
      );
      if (commands.rows[0]!.n !== 1) throw new Error('an automatic command was sent');
      return `ride ${failed.status}, no charge, scooter held for inspection, incident opened, no automatic command`;
    });

    await drill('Database connections terminated under the API', async () => {
      const rider = await newRider(env);
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
      await admin.connect();
      const killed = await admin.query<{ n: number }>(
        `select count(*)::int n from (select pg_terminate_backend(pid) from pg_stat_activity
         where datname = $1 and pid <> pg_backend_pid()) t`,
        [env.db.name],
      );
      await admin.end();
      const started = Date.now();
      let recovered = 0;
      let failures = 0;
      while (Date.now() - started < 10_000) {
        const r = await call('GET', '/v1/rider/wallet', { token: rider.token });
        if (r.status === 200) {
          recovered = Date.now() - started;
          break;
        }
        failures++;
        await sleep(100);
      }
      if (!recovered && failures) throw new Error('API did not recover within 10 s');
      const ready = await call('GET', '/ready');
      if (ready.status !== 200) throw new Error(`readiness ${ready.status}`);
      if (!api.alive) throw new Error('API process died');
      return `terminated ${killed.rows[0]!.n} connections; first successful request after ${recovered} ms (${failures} failed attempts); process stayed up`;
    });

    await drill('Ledger and ride invariants after the drills', async () => {
      const ledger = await env.pool.query<{ total: string }>(
        `select coalesce(sum(amount_santim), 0)::bigint total from ledger_lines`,
      );
      const charges = await env.pool.query<{ n: number }>(
        `select count(*)::int n from (select reference_id from journal_entries where kind = 'ride_charge' group by reference_id having count(*) > 1) d`,
      );
      if (Number(ledger.rows[0]!.total) !== 0) throw new Error('ledger does not balance');
      if (charges.rows[0]!.n !== 0) throw new Error('a ride was charged twice');
      return 'ledger balanced; no ride charged twice';
    });
  } finally {
    await api.stop();
    for (const w of workers) await w.stop();
    await env.pool.end().catch(() => undefined);
    await env.db.drop();
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.drill}: ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
