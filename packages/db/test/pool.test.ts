import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src';
import { createTestDatabase, type TestDatabase } from '../src/testing';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe('createPool', () => {
  it('survives the server terminating idle connections and reconnects', async () => {
    const errors: Error[] = [];
    const pool = createPool({
      connectionString: testDb.url,
      max: 2,
      onIdleClientError: (e) => errors.push(e),
    });
    try {
      await Promise.all([pool.query('select 1'), pool.query('select 1')]);
      const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL });
      await admin.connect();
      await admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [testDb.name],
      );
      await admin.end();
      await new Promise((r) => setTimeout(r, 200));
      // Without a pool 'error' listener the process would have crashed here.
      expect(errors.length).toBeGreaterThan(0);
      expect((await pool.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
