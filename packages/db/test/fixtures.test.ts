import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, loadDevFixtures, type Pool } from '../src';
import { createMigratedTestDatabase, type TestDatabase } from '../src/testing';

let testDb: TestDatabase;
let pool: Pool;
beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  pool = createPool({ connectionString: testDb.url, max: 2 });
});
afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
});

describe('loadDevFixtures', () => {
  it.each([undefined, 'staging', 'production'])('refuses APP_ENV=%s', async (APP_ENV) => {
    await expect(loadDevFixtures(pool, { APP_ENV })).rejects.toThrow(/refusing/);
    expect((await pool.query(`select count(*) from scooters`)).rows[0].count).toBe(0);
  });

  it('loads labelled, simulated fixtures idempotently', async () => {
    const first = await loadDevFixtures(pool, { APP_ENV: 'development' });
    const second = await loadDevFixtures(pool, { APP_ENV: 'test' });
    expect(second.pricingPlanId).toBe(first.pricingPlanId);

    const counts = (
      await pool.query(`select
        (select count(*) from scooters) scooters,
        (select count(*) from devices where is_simulated) simulated_devices,
        (select count(*) from devices where not is_simulated) real_devices,
        (select count(*) from device_assignments where unassigned_at is null) assignments,
        (select count(*) from zones where is_dev_fixture and name like 'DEV FIXTURE%') zones,
        (select count(*) from pricing_plans where is_dev_fixture and name like 'DEV FIXTURE%') plans`)
    ).rows[0];
    expect(counts).toEqual({
      scooters: 12,
      simulated_devices: 12,
      real_devices: 0,
      assignments: 12,
      zones: 4,
      plans: 1,
    });
  });

  it('refuses to replace a non-fixture active pricing plan', async () => {
    await pool.query(`update pricing_plans set status = 'retired' where is_dev_fixture`);
    await pool.query(
      `insert into pricing_plans (name, status, unlock_fee_santim, per_minute_santim, billing_increment_seconds, min_start_balance_santim)
       values ('Approved plan', 'active', 1, 1, 60, 0)`,
    );
    await expect(loadDevFixtures(pool, { APP_ENV: 'development' })).rejects.toThrow(/non-fixture/);
  });
});
