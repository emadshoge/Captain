import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Pool } from '../src';
import { createDb, createPool, getMigrationStatus, runMigrations, schema } from '../src';
import type { TestDatabase } from '../src/testing';
import { createTestDatabase } from '../src/testing';

// Runs against a real PostgreSQL server (local cluster or CI service).
describe('migrations (PostgreSQL integration)', () => {
  let testDb: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    pool = createPool({ connectionString: testDb.url });
  });

  afterAll(async () => {
    await pool?.end();
    await testDb?.drop();
  });

  it('runs against PostgreSQL 16 or newer', async () => {
    const { rows } = await pool.query<{ server_version_num: string }>('show server_version_num');
    expect(Number(rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160000);
  });

  it('reports every migration as pending on an empty database', async () => {
    const status = await getMigrationStatus(pool);
    expect(status.applied).toBe(0);
    expect(status.pending.length).toBeGreaterThan(0);
  });

  it('applies all migrations and records them', async () => {
    await runMigrations(pool);
    const status = await getMigrationStatus(pool);
    expect(status.pending).toEqual([]);
    expect(status.applied).toBeGreaterThan(0);
  });

  it('is a no-op when run again', async () => {
    const before = await getMigrationStatus(pool);
    await runMigrations(pool);
    const after = await getMigrationStatus(pool);
    expect(after).toEqual(before);
  });

  it('creates app_settings with working jsonb storage and constraints', async () => {
    const db = createDb(pool);
    await db
      .insert(schema.appSettings)
      .values({ key: 'example.setting', value: { enabled: true } });

    const [row] = await db
      .select()
      .from(schema.appSettings)
      .where(eq(schema.appSettings.key, 'example.setting'));
    expect(row?.value).toEqual({ enabled: true });
    expect(row?.updatedAt).toBeInstanceOf(Date);

    // Primary key and key-format CHECK are enforced by PostgreSQL itself.
    await expect(
      pool.query(`insert into app_settings (key, value) values ('example.setting', '1')`),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`insert into app_settings (key, value) values ('Bad Key', '1')`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('createTestDatabase safety', () => {
  it('refuses production and staging', async () => {
    await expect(createTestDatabase({ APP_ENV: 'production' })).rejects.toThrow(/refusing/);
    await expect(createTestDatabase({ APP_ENV: 'staging' })).rejects.toThrow(/refusing/);
  });

  it('refuses non-local servers', async () => {
    await expect(
      createTestDatabase({
        APP_ENV: 'test',
        TEST_DATABASE_ADMIN_URL: 'postgres://u@db.example.com/x',
      }),
    ).rejects.toThrow(/local server/);
  });
});
