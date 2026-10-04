import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Default admin URL of the local cluster started by scripts/db-local.sh.
 * CI overrides it with TEST_DATABASE_ADMIN_URL pointing at its postgres:16 service.
 */
export const LOCAL_TEST_ADMIN_URL = 'postgres://captain@127.0.0.1:54329/postgres';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface TestDatabase {
  url: string;
  name: string;
  drop: () => Promise<void>;
}

/**
 * Creates a fresh, uniquely named PostgreSQL database for a test file.
 * Refuses to run outside development/test or against a non-local server, so a
 * misconfigured environment can never create or drop databases elsewhere.
 */
export async function createTestDatabase(
  env: Record<string, string | undefined> = process.env,
): Promise<TestDatabase> {
  if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
    throw new Error(`createTestDatabase: refusing to run with APP_ENV=${env.APP_ENV}`);
  }
  const adminUrl = env.TEST_DATABASE_ADMIN_URL ?? LOCAL_TEST_ADMIN_URL;
  const parsed = new URL(adminUrl);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('createTestDatabase: TEST_DATABASE_ADMIN_URL must point at a local server');
  }

  const name = `captain_t_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `createTestDatabase: cannot reach PostgreSQL at ${parsed.host}. ` +
        'In a cloud session run `pnpm db:local start` (or `pnpm setup:cloud`); ' +
        'in CI check the postgres service.',
      { cause: error },
    );
  }
  try {
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    name,
    drop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}
