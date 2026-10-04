import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../src';
import { createMigratedTestDatabase, type TestDatabase } from '../src/testing';

// Every rule here is enforced by PostgreSQL (constraints, triggers, grants),
// not by application code.
let testDb: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  testDb = await createMigratedTestDatabase();
  pool = createPool({ connectionString: testDb.url, max: 4 });
});
afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
});

const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await pool.query(text, params)).rows[0] as T;

async function inTx(fn: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await fn(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rider() {
  return (await one<{ id: string }>(`insert into riders default values returning id`)).id;
}
async function walletAccount(riderId: string) {
  return (
    await one<{ id: string }>(
      `insert into ledger_accounts (type, rider_id) values ('rider_wallet', $1) returning id`,
      [riderId],
    )
  ).id;
}
async function systemAccount(type: string) {
  return (
    await one<{ id: string }>(
      `select id from ledger_accounts where type = $1 and rider_id is null`,
      [type],
    )
  ).id;
}
async function plan(status = 'draft') {
  const { id } = await one<{ id: string }>(
    `insert into pricing_plans (name, unlock_fee_santim, per_minute_santim, billing_increment_seconds,
       min_start_balance_santim, is_dev_fixture) values ('DEV FIXTURE test', 1000, 300, 60, 5000, true) returning id`,
  );
  if (status !== 'draft')
    await pool.query(`update pricing_plans set status = $2 where id = $1`, [id, status]);
  return id;
}
async function scooterWithDevice(simulated = true) {
  const code = `T-${randomUUID().slice(0, 8).toUpperCase()}`;
  const s = await one<{ id: string }>(
    `insert into scooters (code, qr_token) values ($1, $2) returning id`,
    [code, randomUUID()],
  );
  const d = await one<{ id: string }>(
    `insert into devices (supplier_device_id, adapter, is_simulated) values ($1, $2, $3) returning id`,
    [randomUUID(), simulated ? 'simulated' : 'supplier_tcp', simulated],
  );
  return { scooterId: s.id, deviceId: d.id };
}
async function ride(riderId: string, scooterId: string, deviceId: string, planId: string) {
  return (
    await one<{ id: string }>(
      `insert into rides (rider_id, scooter_id, device_id, pricing_plan_id, pricing_snapshot, is_simulated)
       values ($1, $2, $3, $4, '{}', true) returning id`,
      [riderId, scooterId, deviceId, planId],
    )
  ).id;
}
async function journal(
  client: pg.PoolClient,
  lines: [string, number, string?][],
  kind = 'adjustment',
) {
  const { rows } = await client.query<{ id: string }>(
    `insert into journal_entries (kind, reference_type, reference_id, description, created_by_type)
     values ($1, 'test', $2, 'test', 'system') returning id`,
    [kind, randomUUID()],
  );
  const id = rows[0]!.id;
  for (const [account, amount, currency] of lines) {
    await client.query(
      `insert into ledger_lines (journal_id, account_id, amount_santim, currency) values ($1,$2,$3,$4)`,
      [id, account, amount, currency ?? 'ETB'],
    );
  }
  return id;
}

describe('reference data', () => {
  it('seeds roles, permissions and system ledger accounts (no business values)', async () => {
    const roles = (await pool.query(`select key from roles order by key`)).rows.map((r) => r.key);
    expect(roles).toEqual(['admin', 'operator']);
    const adminPerms = await one<{ n: string }>(
      `select count(*) n from role_permissions where role_key='admin'`,
    );
    const allPerms = await one<{ n: string }>(`select count(*) n from permissions`);
    expect(adminPerms.n).toBe(allPerms.n);
    const operatorHas = async (p: string) =>
      Boolean(
        await one(
          `select 1 from role_permissions where role_key='operator' and permission_key=$1`,
          [p],
        ),
      );
    expect(await operatorHas('fleet.read')).toBe(true);
    for (const p of [
      'staff.manage',
      'wallet.adjust',
      'pricing.manage',
      'refunds.approve',
      'audit.read',
    ]) {
      expect(await operatorHas(p)).toBe(false);
    }
    const accounts = (
      await pool.query(
        `select type from ledger_accounts where rider_id is null order by type::text`,
      )
    ).rows;
    expect(accounts.map((a) => a.type)).toEqual([
      'adjustments',
      'provider_clearing',
      'refunds',
      'reservation_revenue',
      'ride_revenue',
    ]);
    expect(await one<{ n: number }>(`select count(*) n from pricing_plans`)).toEqual({ n: 0 });
    expect(await one<{ n: number }>(`select count(*) n from zones`)).toEqual({ n: 0 });
  });
});

describe('ledger', () => {
  it('accepts a balanced journal and rejects unbalanced or single-line journals at commit', async () => {
    const wallet = await walletAccount(await rider());
    const clearing = await systemAccount('provider_clearing');
    await inTx(
      async (c) =>
        void (await journal(
          c,
          [
            [clearing, -50_000],
            [wallet, 50_000],
          ],
          'topup',
        )),
    );
    const balance = await one<{ sum: string }>(
      `select sum(amount_santim) sum from ledger_lines where account_id=$1`,
      [wallet],
    );
    expect(Number(balance.sum)).toBe(50_000);

    await expect(
      inTx(
        async (c) =>
          void (await journal(c, [
            [clearing, -100],
            [wallet, 99],
          ])),
      ),
    ).rejects.toThrow(/unbalanced/);
    await expect(inTx(async (c) => void (await journal(c, [[wallet, 0 + 100]])))).rejects.toThrow(
      /at least two/,
    );
    await expect(inTx(async (c) => void (await journal(c, [])))).rejects.toThrow(/at least two/);
  });

  it('rejects zero amounts and non-ETB currency', async () => {
    const wallet = await walletAccount(await rider());
    const adj = await systemAccount('adjustments');
    await expect(
      inTx(
        async (c) =>
          void (await journal(c, [
            [adj, 0],
            [wallet, 0],
          ])),
      ),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      inTx(
        async (c) =>
          void (await journal(c, [
            [adj, -100, 'USD'],
            [wallet, 100, 'USD'],
          ])),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is append-only: UPDATE, DELETE and TRUNCATE are refused even for the owner', async () => {
    const wallet = await walletAccount(await rider());
    const adj = await systemAccount('adjustments');
    await inTx(
      async (c) =>
        void (await journal(c, [
          [adj, -100],
          [wallet, 100],
        ])),
    );
    await expect(
      pool.query(`update ledger_lines set amount_santim = 1 where account_id=$1`, [wallet]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query(`delete from ledger_lines where account_id=$1`, [wallet]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`update journal_entries set description='x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query(`truncate ledger_lines cascade`)).rejects.toThrow(/append-only/);
  });

  it('allows only one wallet per rider', async () => {
    const r = await rider();
    await walletAccount(r);
    await expect(walletAccount(r)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('rides', () => {
  it('allows one open ride per rider and per scooter; completed rides free both', async () => {
    const planId = await plan('active');
    const r1 = await rider();
    const r2 = await rider();
    const a = await scooterWithDevice();
    const b = await scooterWithDevice();
    const first = await ride(r1, a.scooterId, a.deviceId, planId);
    await expect(ride(r1, b.scooterId, b.deviceId, planId)).rejects.toMatchObject({
      code: '23505',
    });
    await expect(ride(r2, a.scooterId, a.deviceId, planId)).rejects.toMatchObject({
      code: '23505',
    });
    // operator_review still occupies rider and scooter
    await pool.query(`update rides set status='operator_review' where id=$1`, [first]);
    await expect(ride(r2, a.scooterId, a.deviceId, planId)).rejects.toMatchObject({
      code: '23505',
    });
    await pool.query(
      `update rides set status='completed', completed_at=now(), fare_santim=1300 where id=$1`,
      [first],
    );
    await expect(ride(r2, a.scooterId, a.deviceId, planId)).resolves.toBeTruthy();
  });

  it('protects terminal states, identity and the pricing snapshot', async () => {
    const planId = await plan('active').catch(
      async () =>
        (await one<{ id: string }>(`select id from pricing_plans where status='active'`)).id,
    );
    const s = await scooterWithDevice();
    const id = await ride(await rider(), s.scooterId, s.deviceId, planId);
    await expect(
      pool.query(`update rides set pricing_snapshot='{"x":1}' where id=$1`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`update rides set status='completed' where id=$1`, [id]),
    ).rejects.toMatchObject({
      code: '23514',
    }); // completed requires completed_at + fare
    await pool.query(
      `update rides set status='start_failed', failure_reason='unlock timeout' where id=$1`,
      [id],
    );
    await expect(pool.query(`update rides set status='active' where id=$1`, [id])).rejects.toThrow(
      /terminal/,
    );
    await expect(pool.query(`delete from rides where id=$1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
  });
});

describe('pricing plans', () => {
  it('freezes numbers after draft, allows a single active plan, enforces transitions', async () => {
    await pool.query(`update pricing_plans set status='retired' where status='active'`);
    const a = await plan('draft');
    await pool.query(`update pricing_plans set per_minute_santim = 350 where id=$1`, [a]); // draft: editable
    await pool.query(`update pricing_plans set status='active' where id=$1`, [a]);
    await expect(
      pool.query(`update pricing_plans set per_minute_santim = 1 where id=$1`, [a]),
    ).rejects.toThrow(/immutable/);
    const b = await plan('draft');
    await expect(
      pool.query(`update pricing_plans set status='active' where id=$1`, [b]),
    ).rejects.toMatchObject({
      code: '23505',
    });
    await pool.query(`update pricing_plans set status='retired' where id=$1`, [a]);
    await expect(
      pool.query(`update pricing_plans set status='active' where id=$1`, [a]),
    ).rejects.toThrow(/invalid pricing plan transition/);
    await expect(pool.query(`delete from pricing_plans where id=$1`, [a])).rejects.toThrow(
      /only draft/,
    );
  });

  it('rejects negative amounts and a positive low-balance floor', async () => {
    await expect(
      pool.query(
        `insert into pricing_plans (name, unlock_fee_santim, per_minute_santim, billing_increment_seconds, min_start_balance_santim)
         values ('x', -1, 0, 60, 0)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into pricing_plans (name, unlock_fee_santim, per_minute_santim, billing_increment_seconds, min_start_balance_santim, low_balance_floor_santim)
         values ('x', 0, 0, 60, 0, 100)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('payments', () => {
  it('enforces the 500 ETB minimum, ETB currency and credit-before-success', async () => {
    const r = await rider();
    const insert = (amount: number, currency = 'ETB') =>
      pool.query(
        `insert into payment_attempts (rider_id, provider, tx_ref, amount_santim, currency, expires_at)
         values ($1, 'fake', $2, $3, $4, now() + interval '1 hour') returning id`,
        [r, randomUUID(), amount, currency],
      );
    await expect(insert(49_999)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(50_000, 'USD')).rejects.toMatchObject({ code: '23514' });
    const { rows } = await insert(50_000);
    await expect(
      pool.query(`update payment_attempts set status='succeeded' where id=$1`, [rows[0].id]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('fleet', () => {
  it('ties is_simulated to the adapter and makes it immutable', async () => {
    await expect(
      pool.query(
        `insert into devices (supplier_device_id, adapter, is_simulated) values ('x1', 'supplier_tcp', true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const { deviceId } = await scooterWithDevice(true);
    await expect(
      pool.query(`update devices set adapter='supplier_tcp', is_simulated=false where id=$1`, [
        deviceId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('validates scooter codes, battery and coordinates', async () => {
    await expect(
      pool.query(`insert into scooters (code, qr_token) values ('bad code', 'q1')`),
    ).rejects.toMatchObject({
      code: '23514',
    });
    const { scooterId } = await scooterWithDevice();
    for (const sql of [
      `update scooters set battery_percent = 101 where id=$1`,
      `update scooters set last_lat = 91, last_lng = 38 where id=$1`,
      `update scooters set last_lat = 9 where id=$1`, // lat without lng
    ]) {
      await expect(pool.query(sql, [scooterId])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('allows one active device assignment per device and per scooter', async () => {
    const a = await scooterWithDevice();
    const b = await scooterWithDevice();
    await pool.query(`insert into device_assignments (device_id, scooter_id) values ($1,$2)`, [
      a.deviceId,
      a.scooterId,
    ]);
    await expect(
      pool.query(`insert into device_assignments (device_id, scooter_id) values ($1,$2)`, [
        a.deviceId,
        b.scooterId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`insert into device_assignments (device_id, scooter_id) values ($1,$2)`, [
        b.deviceId,
        a.scooterId,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('identity', () => {
  it('normalizes contacts and keeps them unique', async () => {
    const r = await rider();
    await expect(
      pool.query(
        `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,'phone','0911',now())`,
        [r],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,'email','A@B.ET',now())`,
        [r],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,'phone','+251911223344',now())`,
      [r],
    );
    await expect(
      pool.query(
        `insert into rider_contacts (rider_id, kind, value, verified_at) values ($1,'phone','+251911223344',now())`,
        [await rider()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('requires sessions to belong to exactly one subject', async () => {
    await expect(
      pool.query(
        `insert into auth_sessions (subject_type, client, expires_at) values ('rider','web', now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the audit log append-only', async () => {
    await pool.query(
      `insert into audit_log (actor_type, action, target_type) values ('system','test','x')`,
    );
    await expect(pool.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('runtime role (captain_app)', () => {
  it('lets a runtime login insert history but not rewrite it or change reference data', async () => {
    const user = `captain_rt_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const password = randomUUID();
    await pool.query(`create role ${user} login password '${password}' in role captain_app`);
    const url = new URL(testDb.url);
    url.username = user;
    url.password = password;
    const app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
    try {
      const r = (await app.query(`insert into riders default values returning id`)).rows[0].id;
      const wallet = (
        await app.query(
          `insert into ledger_accounts (type, rider_id) values ('rider_wallet',$1) returning id`,
          [r],
        )
      ).rows[0].id;
      const adj = (
        await app.query(
          `select id from ledger_accounts where type='adjustments' and rider_id is null`,
        )
      ).rows[0].id;
      await app.query('begin');
      const j = (
        await app.query(
          `insert into journal_entries (kind, reference_type, reference_id, description, created_by_type)
           values ('adjustment','test',$1,'rt','system') returning id`,
          [randomUUID()],
        )
      ).rows[0].id;
      await app.query(
        `insert into ledger_lines (journal_id, account_id, amount_santim) values ($1,$2,-5),($1,$3,5)`,
        [j, adj, wallet],
      );
      await app.query('commit');

      // Permission denied (42501) comes from grants, before any trigger.
      await expect(
        app.query(`update ledger_lines set amount_santim = 6 where journal_id=$1`, [j]),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`delete from audit_log`)).rejects.toMatchObject({ code: '42501' });
      await expect(
        app.query(`insert into roles (key, description) values ('root','x')`),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(app.query(`delete from rides`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.query(`create table hack (id int)`)).rejects.toMatchObject({
        code: '42501',
      });
      // Readiness check can read migration status.
      const migrations = await app.query(`select count(*) from drizzle.__drizzle_migrations`);
      expect(Number(migrations.rows[0].count)).toBeGreaterThan(0);
    } finally {
      await app.end();
      await pool.query(`drop owned by ${user}`).catch(() => undefined);
      await pool.query(`drop role ${user}`);
    }
  });
});
