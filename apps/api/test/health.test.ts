import { HealthResponseSchema, ReadinessResponseSchema } from '@captain/contracts';
import type { ApiConfig } from '@captain/config';
import { loadApiConfig } from '@captain/config';
import { createPool, runMigrations } from '@captain/db';
import type { TestDatabase } from '@captain/db/testing';
import { createTestDatabase } from '@captain/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const configFor = (databaseUrl: string): ApiConfig =>
  loadApiConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: databaseUrl });

describe('GET /health', () => {
  it('returns ok without touching the database', async () => {
    // Port 1 is never a PostgreSQL server: proves liveness has no DB dependency.
    const app = await buildApp({ config: configFor('postgres://nobody@127.0.0.1:1/none') });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(HealthResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      service: 'captain-api',
    });
    await app.close();
  });
});

describe('GET /ready', () => {
  it('returns 503 when the database is unreachable', async () => {
    const app = await buildApp({ config: configFor('postgres://nobody@127.0.0.1:1/none') });
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(ReadinessResponseSchema.parse(response.json())).toEqual({
      status: 'not_ready',
      checks: { database: 'error', migrations: 'error' },
    });
    await app.close();
  });

  describe('with a real PostgreSQL database', () => {
    let testDb: TestDatabase;

    beforeAll(async () => {
      testDb = await createTestDatabase();
    });
    afterAll(async () => {
      await testDb?.drop();
    });

    it('reports pending migrations, then ready after migrating', async () => {
      const app = await buildApp({ config: configFor(testDb.url) });

      const before = await app.inject({ method: 'GET', url: '/ready' });
      expect(before.statusCode).toBe(503);
      expect(before.json()).toEqual({
        status: 'not_ready',
        checks: { database: 'ok', migrations: 'pending' },
      });

      const pool = createPool({ connectionString: testDb.url });
      await runMigrations(pool);
      await pool.end();

      const after = await app.inject({ method: 'GET', url: '/ready' });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({
        status: 'ready',
        checks: { database: 'ok', migrations: 'ok' },
      });
      await app.close();
    });
  });
});
