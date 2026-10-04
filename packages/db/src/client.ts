import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export interface PoolOptions {
  connectionString: string;
  /** Fail fast when the server is unreachable (readiness checks rely on it). */
  connectionTimeoutMillis?: number;
  max?: number;
}

export function createPool({
  connectionString,
  connectionTimeoutMillis = 3_000,
  max = 10,
}: PoolOptions) {
  return new pg.Pool({ connectionString, connectionTimeoutMillis, max });
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export type Pool = pg.Pool;
