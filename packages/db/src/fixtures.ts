import type pg from 'pg';

/**
 * Development/test fixtures. Every row is labelled DEV FIXTURE and every
 * device is SIMULATED. Prices and zones here are NOT business decisions
 * (D-PRICE, D-ZONES are unresolved); they exist so the platform can be
 * exercised end to end without real hardware.
 */
export const DEV_FIXTURE_PREFIX = 'DEV FIXTURE';
export const DEV_SCOOTER_COUNT = 12;

const ALLOWED_ENVS = new Set(['development', 'test']);

/** Rectangle as a closed GeoJSON polygon ring ([lng, lat]). */
function box(minLat: number, minLng: number, maxLat: number, maxLng: number) {
  return {
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ],
      ],
    },
    minLat,
    minLng,
    maxLat,
    maxLng,
  };
}

// Central Addis Ababa (approximate). Illustrative only.
const FIXTURE_ZONES = [
  {
    name: `${DEV_FIXTURE_PREFIX} service area (central Addis)`,
    kind: 'service_area',
    ...box(8.98, 38.72, 9.05, 38.8),
  },
  {
    name: `${DEV_FIXTURE_PREFIX} parking (Meskel Square)`,
    kind: 'parking',
    ...box(9.008, 38.759, 9.013, 38.765),
  },
  {
    name: `${DEV_FIXTURE_PREFIX} parking (Bole Road)`,
    kind: 'parking',
    ...box(8.995, 38.778, 9.0, 38.785),
  },
  {
    name: `${DEV_FIXTURE_PREFIX} restricted (example)`,
    kind: 'restricted',
    ...box(9.02, 38.74, 9.025, 38.748),
  },
] as const;

export interface FixtureSummary {
  pricingPlanId: string;
  scooters: number;
  zones: number;
}

/**
 * Loads fixtures idempotently. Refuses unless APP_ENV is development or
 * test, so a misconfigured staging/production run cannot seed fake data.
 */
export async function loadDevFixtures(
  pool: pg.Pool,
  env: Record<string, string | undefined> = process.env,
): Promise<FixtureSummary> {
  const appEnv = env.APP_ENV;
  if (!appEnv || !ALLOWED_ENVS.has(appEnv)) {
    throw new Error(
      `loadDevFixtures: refusing to load fixtures with APP_ENV=${appEnv ?? '(unset)'}`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query('begin');

    let plan = (
      await client.query<{ id: string }>(
        `select id from pricing_plans where is_dev_fixture and status = 'active'`,
      )
    ).rows[0];
    if (!plan) {
      const active = await client.query(`select 1 from pricing_plans where status = 'active'`);
      if (active.rowCount)
        throw new Error(
          'loadDevFixtures: a non-fixture pricing plan is active; refusing to replace it',
        );
      plan = (
        await client.query<{ id: string }>(
          `insert into pricing_plans (name, status, is_dev_fixture, unlock_fee_santim, per_minute_santim,
             billing_increment_seconds, pause_per_minute_santim, max_pause_minutes, min_start_balance_santim,
             hold_amount_santim, reservation_minutes, reservation_fee_santim, max_ride_minutes,
             low_balance_floor_santim, activated_at)
           values ($1, 'active', true, 1500, 300, 60, 100, 15, 5000, 0, 10, 0, 180, -2000, now())
           returning id`,
          [`${DEV_FIXTURE_PREFIX} pricing (not production pricing)`],
        )
      ).rows[0]!;
    }

    for (const zone of FIXTURE_ZONES) {
      await client.query(
        `insert into zones (name, kind, geometry, min_lat, min_lng, max_lat, max_lng, is_dev_fixture)
         select $1, $2, $3, $4, $5, $6, $7, true
         where not exists (select 1 from zones where name = $1)`,
        [
          zone.name,
          zone.kind,
          JSON.stringify(zone.geometry),
          zone.minLat,
          zone.minLng,
          zone.maxLat,
          zone.maxLng,
        ],
      );
    }

    for (let i = 1; i <= DEV_SCOOTER_COUNT; i++) {
      const code = `DEV-${String(i).padStart(4, '0')}`;
      const lat = 9.0 + (i % 4) * 0.004;
      const lng = 38.75 + Math.floor(i / 4) * 0.006;
      const scooter = (
        await client.query<{ id: string }>(
          `insert into scooters (code, qr_token, model, status, battery_percent, last_lat, last_lng,
             last_location_at, last_telemetry_at)
           values ($1, $2, $3, 'available', $4, $5, $6, now(), now())
           on conflict (code) do update set code = excluded.code
           returning id`,
          [
            code,
            `dev-qr-${code.toLowerCase()}`,
            `${DEV_FIXTURE_PREFIX} simulated scooter`,
            40 + i * 5,
            lat,
            lng,
          ],
        )
      ).rows[0]!;
      const device = (
        await client.query<{ id: string }>(
          `insert into devices (supplier_device_id, adapter, is_simulated, metadata, online, last_seen_at)
           values ($1, 'simulated', true, '{"fixture": true}', true, now())
           on conflict (supplier_device_id) do update set supplier_device_id = excluded.supplier_device_id
           returning id`,
          [`SIM-${code}`],
        )
      ).rows[0]!;
      await client.query(
        `insert into device_assignments (device_id, scooter_id)
         select $1, $2 where not exists (
           select 1 from device_assignments where unassigned_at is null and (device_id = $1 or scooter_id = $2))`,
        [device.id, scooter.id],
      );
    }

    await client.query('commit');
    return { pricingPlanId: plan.id, scooters: DEV_SCOOTER_COUNT, zones: FIXTURE_ZONES.length };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
