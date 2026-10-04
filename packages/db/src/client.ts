import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

/**
 * int8 (bigint) columns — money in santim, bigserial ids, counts — arrive as
 * strings from node-postgres. Parse them to numbers, refusing anything outside
 * the safe-integer range rather than silently losing precision.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`int8 value ${value} exceeds the safe integer range`);
  return parsed;
});

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
