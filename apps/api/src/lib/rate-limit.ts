import { COMMON_ERROR_CODES } from '@captain/contracts';
import { AppError } from '../errors';
import { sha256Hex } from './crypto';
import type { Queryable } from './db';

export interface RateLimitRule {
  scope: string;
  limit: number;
  windowSeconds: number;
}

/** Limits are deliberately code constants: they are security controls, not business policy. */
export const RATE_LIMITS = {
  otpRequestPerDestination: { scope: 'otp-req-dest', limit: 5, windowSeconds: 3_600 },
  otpRequestPerIp: { scope: 'otp-req-ip', limit: 30, windowSeconds: 3_600 },
  otpVerifyPerIp: { scope: 'otp-verify-ip', limit: 30, windowSeconds: 600 },
  refreshPerIp: { scope: 'refresh-ip', limit: 120, windowSeconds: 600 },
} satisfies Record<string, RateLimitRule>;

/**
 * Fixed-window counter in PostgreSQL. Identifiers are hashed so phone
 * numbers and emails are not stored in the clear. Throws 429 when exceeded.
 */
export async function enforceRateLimit(
  q: Queryable,
  rule: RateLimitRule,
  identifier: string,
  now: Date,
): Promise<void> {
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const key = `${rule.scope}:${sha256Hex(identifier).slice(0, 32)}`;
  const result = await q.query<{ count: number }>(
    `insert into rate_limit_buckets (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
     returning count`,
    [key, windowStart],
  );
  if ((result.rows[0]?.count ?? 0) > rule.limit) {
    const retryAfterSeconds = Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000);
    throw new AppError(
      429,
      COMMON_ERROR_CODES.RATE_LIMITED,
      'Too many requests. Try again later.',
      undefined,
      {
        retryAfterSeconds,
      },
    );
  }
}
