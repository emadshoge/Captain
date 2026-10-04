import type pg from 'pg';

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

/** Runs `fn` in a transaction on one connection; rolls back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return (
    pgError?.code === '23505' && (constraint === undefined || pgError.constraint === constraint)
  );
}

export async function one<T>(
  q: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const result = await q.query(text, params);
  return result.rows[0] as T | undefined;
}
