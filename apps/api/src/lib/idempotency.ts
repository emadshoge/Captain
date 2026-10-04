import { WALLET_ERROR_CODES } from '@captain/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { AppError } from '../errors';
import { sha256Hex } from './crypto';
import { one } from './db';

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const TTL_MS = 24 * 3_600_000;

/**
 * Idempotency for POSTs that move money or start rides. The client sends an
 * `Idempotency-Key`; a retry with the same key and body replays the stored
 * response instead of repeating the operation. A different body with the
 * same key is rejected.
 */
export async function withIdempotency<T>(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  subjectKey: string,
  now: Date,
  operation: () => Promise<{ status: number; body: T }>,
) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw new AppError(
      400,
      WALLET_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      'An Idempotency-Key header (8–100 characters) is required.',
    );
  }
  const endpoint = request.routeOptions.url ?? request.url;
  const requestHash = sha256Hex(
    `${request.method} ${request.url}\n${JSON.stringify(request.body ?? null)}`,
  );

  const claimed = await one(
    pool,
    `insert into idempotency_keys (subject_key, endpoint, key, request_hash, expires_at, created_at)
     values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning key`,
    [subjectKey, endpoint, key, requestHash, new Date(now.getTime() + TTL_MS), now],
  );
  if (!claimed) {
    const existing = await one<{
      request_hash: string;
      status: string;
      response_status: number;
      response_body: T;
    }>(
      pool,
      `select request_hash, status, response_status, response_body from idempotency_keys
       where subject_key = $1 and endpoint = $2 and key = $3`,
      [subjectKey, endpoint, key],
    );
    if (!existing)
      throw new AppError(409, WALLET_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS, 'Please retry.');
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        422,
        WALLET_ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was used for a different request.',
      );
    }
    if (existing.status !== 'completed') {
      throw new AppError(
        409,
        WALLET_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
        'The original request is still being processed.',
      );
    }
    reply.header('idempotent-replayed', 'true');
    return reply.code(existing.response_status).send(existing.response_body);
  }

  try {
    const result = await operation();
    await pool.query(
      `update idempotency_keys set status = 'completed', response_status = $4, response_body = $5
       where subject_key = $1 and endpoint = $2 and key = $3`,
      [subjectKey, endpoint, key, result.status, JSON.stringify(result.body)],
    );
    return reply.code(result.status).send(result.body);
  } catch (error) {
    // Failed operations release the key so the client can retry.
    await pool.query(
      `delete from idempotency_keys where subject_key = $1 and endpoint = $2 and key = $3`,
      [subjectKey, endpoint, key],
    );
    throw error;
  }
}
