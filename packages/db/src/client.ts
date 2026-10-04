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
  /** Called when an idle pooled connection fails (it is discarded and replaced). */
  onIdleClientError?: (error: Error) => void;
  connectionString: string;
  /** Fail fast when the server is unreachable (readiness checks rely on it). */
  connectionTimeoutMillis?: number;
  max?: number;
}

export function createPool({
  connectionString,
  connectionTimeoutMillis = 3_000,
  max = 10,
  onIdleClientError,
}: PoolOptions) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis, max });
  // An idle connection dropped by the server (restart, failover, admin
  // termination) is emitted as a pool 'error'. Without a listener Node treats
  // it as an unhandled error and the process exits. pg already discards the
  // broken client; the pool reconnects on the next query.
  pool.on('error', (error) => onIdleClientError?.(error));
  return pool;
}

export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;
export type Pool = pg.Pool;
