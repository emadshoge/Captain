import { randomBytes } from 'node:crypto';
import type { ApiConfig } from '@captain/config';
import { WALLET_ERROR_CODES } from '@captain/contracts';
import { MIN_TOPUP_SANTIM } from '@captain/domain';
import type pg from 'pg';
import { AppError } from '../errors';
import { openAlert } from '../fleet/service';
import { one, withTransaction } from '../lib/db';
import { lockWallet, postJournal, systemAccountId } from './ledger';
import { type PaymentProvider, ProviderUnavailableError, type VerifyResult } from './providers';

export interface PaymentDeps {
  config: ApiConfig;
  pool: pg.Pool;
  now: () => Date;
  provider: PaymentProvider | null;
}

export type PaymentStatus = 'initiated' | 'pending' | 'succeeded' | 'failed' | 'expired' | 'review';

export interface PaymentRow {
  id: string;
  rider_id: string;
  provider: 'chapa' | 'fake';
  tx_ref: string;
  amount_santim: number;
  currency: 'ETB';
  status: PaymentStatus;
  provider_reference: string | null;
  checkout_url: string | null;
  verified_at: Date | null;
  verified_amount_santim: number | null;
  verified_currency: string | null;
  journal_id: string | null;
  failure_reason: string | null;
  expires_at: Date;
  last_checked_at: Date | null;
  reconciled_at: Date | null;
  created_at: Date;
}

function requireProvider(deps: PaymentDeps): PaymentProvider {
  if (!deps.provider) {
    throw new AppError(
      503,
      WALLET_ERROR_CODES.PAYMENTS_UNAVAILABLE,
      'Top-ups are not available right now.',
    );
  }
  return deps.provider;
}

/** Captain-generated reference: unguessable, unique, provider-safe characters. */
export function newTxRef(): string {
  return `cap-${Date.now().toString(36)}-${randomBytes(9).toString('base64url')}`;
}

export async function createTopUp(
  deps: PaymentDeps,
  riderId: string,
  amountSantim: number,
): Promise<PaymentRow> {
  const provider = requireProvider(deps);
  if (amountSantim < MIN_TOPUP_SANTIM) {
    throw new AppError(
      400,
      WALLET_ERROR_CODES.TOPUP_BELOW_MINIMUM,
      'The minimum top-up is 500 ETB.',
      {
        minimumSantim: MIN_TOPUP_SANTIM,
      },
    );
  }
  if (deps.config.TOPUP_MAX_SANTIM !== undefined && amountSantim > deps.config.TOPUP_MAX_SANTIM) {
    throw new AppError(
      400,
      WALLET_ERROR_CODES.TOPUP_ABOVE_LIMIT,
      'This amount is above the allowed top-up limit.',
      {
        maximumSantim: deps.config.TOPUP_MAX_SANTIM,
      },
    );
  }
  const now = deps.now();
  const contact = await one<{ email: string | null; phone: string | null }>(
    deps.pool,
    `select max(value) filter (where kind = 'email') as email, max(value) filter (where kind = 'phone') as phone
     from rider_contacts where rider_id = $1`,
    [riderId],
  );
  const payment = (await one<PaymentRow>(
    deps.pool,
    `insert into payment_attempts (rider_id, provider, tx_ref, amount_santim, status, expires_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'initiated', $5, $6, $6) returning *`,
    [
      riderId,
      provider.name,
      newTxRef(),
      amountSantim,
      new Date(now.getTime() + deps.config.PAYMENT_EXPIRY_MINUTES * 60_000),
      now,
    ],
  ))!;

  try {
    const result = await provider.initialize({
      txRef: payment.tx_ref,
      amountSantim,
      currency: 'ETB',
      callbackUrl: deps.config.PUBLIC_API_URL
        ? `${deps.config.PUBLIC_API_URL}/v1/webhooks/${provider.name}`
        : null,
      returnUrl: deps.config.RIDER_RETURN_URL ?? null,
      customer: { email: contact?.email ?? null, phone: contact?.phone ?? null },
    });
    return (await one<PaymentRow>(
      deps.pool,
      `update payment_attempts set status = 'pending', checkout_url = $2, provider_reference = $3, updated_at = $4
       where id = $1 returning *`,
      [payment.id, result.checkoutUrl, result.providerReference ?? null, deps.now()],
    ))!;
  } catch (error) {
    // No checkout was shown, so no money can have moved: mark failed (not ambiguous).
    await deps.pool.query(
      `update payment_attempts set status = 'failed', failure_reason = $2, updated_at = $3 where id = $1`,
      [
        payment.id,
        error instanceof ProviderUnavailableError ? 'initialize_unavailable' : 'initialize_error',
        deps.now(),
      ],
    );
    throw new AppError(
      503,
      WALLET_ERROR_CODES.PAYMENTS_UNAVAILABLE,
      'We could not start the payment. Please try again.',
    );
  }
}

export type ProcessOutcome =
  | 'credited'
  | 'already_credited'
  | 'failed'
  | 'pending'
  | 'expired'
  | 'review'
  | 'provider_unavailable'
  | 'not_found';

/**
 * Verifies a payment with the provider and applies the result exactly once.
 *
 * - The provider is called OUTSIDE any database transaction (no locks held
 *   during network I/O).
 * - The result is applied under a row lock; a payment already credited is
 *   never credited again, and the ledger's unique reference makes a second
 *   credit impossible even if two processors race.
 * - Success is credited only if reference, amount and currency all match
 *   what Captain created; any mismatch goes to `review` (no credit) with an alert.
 * - Unknown outcomes (provider unreachable) leave the payment pending.
 */
export async function processPayment(
  deps: PaymentDeps,
  paymentId: string,
  source: 'webhook' | 'verify' | 'redirect' | 'reconcile',
): Promise<ProcessOutcome> {
  const provider = requireProvider(deps);
  const current = await one<PaymentRow>(deps.pool, `select * from payment_attempts where id = $1`, [
    paymentId,
  ]);
  if (!current) return 'not_found';
  if (current.status === 'succeeded') return 'already_credited';

  let result: VerifyResult;
  try {
    result = await provider.verify(current.tx_ref);
  } catch (error) {
    if (!(error instanceof ProviderUnavailableError)) throw error;
    await deps.pool.query(
      `insert into payment_events (payment_id, provider, source, payload, outcome) values ($1,$2,$3,$4,'verify_unavailable')`,
      [paymentId, current.provider, source, JSON.stringify({ error: 'provider_unavailable' })],
    );
    await deps.pool.query(`update payment_attempts set last_checked_at = $2 where id = $1`, [
      paymentId,
      deps.now(),
    ]);
    return 'provider_unavailable';
  }

  return withTransaction(deps.pool, async (client): Promise<ProcessOutcome> => {
    const now = deps.now();
    const payment = (await one<PaymentRow>(
      client,
      `select * from payment_attempts where id = $1 for update`,
      [paymentId],
    ))!;
    const record = (outcome: string) =>
      client.query(
        `insert into payment_events (payment_id, provider, source, payload, outcome) values ($1,$2,'verify',$3,$4)`,
        [
          payment.id,
          payment.provider,
          JSON.stringify({ trigger: source, ...result, raw: result.raw }),
          outcome,
        ],
      );

    if (payment.status === 'succeeded') {
      await record('already_credited');
      return 'already_credited';
    }

    if (result.status === 'success') {
      const mismatch =
        (result.txRef !== undefined && result.txRef !== payment.tx_ref) ||
        result.amountSantim !== payment.amount_santim ||
        result.currency !== 'ETB' ||
        (payment.provider_reference !== null &&
          result.providerReference !== undefined &&
          result.providerReference !== payment.provider_reference);
      if (mismatch || payment.status === 'failed') {
        // Never credit a payment whose details differ from what we created,
        // or one we already recorded as failed: a human must reconcile it.
        await client.query(
          `update payment_attempts set status = 'review', verified_amount_santim = $2, verified_currency = $3,
             failure_reason = $4, last_checked_at = $5, updated_at = $5 where id = $1`,
          [
            payment.id,
            result.amountSantim ?? null,
            result.currency ?? null,
            mismatch ? 'verification_mismatch' : 'success_after_failure',
            now,
          ],
        );
        await openAlert(client, {
          kind: 'payment_review',
          severity: 'critical',
          dedupeKey: `payment_review:${payment.id}`,
          data: {
            paymentId: payment.id,
            reason: mismatch ? 'verification_mismatch' : 'success_after_failure',
          },
        });
        await record('review');
        return 'review';
      }
      const walletId = await lockWallet(client, payment.rider_id);
      const clearing = await systemAccountId(client, 'provider_clearing');
      const { journalId } = await postJournal(client, {
        kind: 'topup',
        referenceType: 'payment_attempt',
        referenceId: payment.id,
        description: `Wallet top-up (${payment.provider}${payment.provider === 'fake' ? ', SIMULATED' : ''})`,
        createdBy: { type: 'system' },
        lines: [
          { accountId: clearing, amountSantim: -payment.amount_santim },
          { accountId: walletId, amountSantim: payment.amount_santim },
        ],
      });
      await client.query(
        `update payment_attempts set status = 'succeeded', journal_id = $2, verified_at = $3, verified_amount_santim = $4,
           verified_currency = $5, provider_reference = coalesce(provider_reference, $6), last_checked_at = $3,
           updated_at = $3, failure_reason = case when status = 'expired' then 'late_success' else failure_reason end
         where id = $1`,
        [
          payment.id,
          journalId,
          now,
          result.amountSantim,
          result.currency,
          result.providerReference ?? null,
        ],
      );
      await record('credited');
      return 'credited';
    }

    if (result.status === 'failed') {
      if (
        payment.status === 'initiated' ||
        payment.status === 'pending' ||
        payment.status === 'expired'
      ) {
        await client.query(
          `update payment_attempts set status = 'failed', failure_reason = coalesce(failure_reason, 'provider_reported_failure'),
             last_checked_at = $2, updated_at = $2 where id = $1`,
          [payment.id, now],
        );
      }
      await record('failed');
      return 'failed';
    }

    // Still pending at the provider.
    if (
      now > payment.expires_at &&
      (payment.status === 'pending' || payment.status === 'initiated')
    ) {
      await client.query(
        `update payment_attempts set status = 'expired', last_checked_at = $2, updated_at = $2 where id = $1`,
        [payment.id, now],
      );
      await record('expired');
      return 'expired';
    }
    await client.query(`update payment_attempts set last_checked_at = $2 where id = $1`, [
      payment.id,
      now,
    ]);
    await record('pending');
    return 'pending';
  });
}

/**
 * Worker sweep: re-verifies open payments whose webhook may have been lost,
 * and late successes on expired ones (bounded per run).
 */
export async function reconcilePayments(deps: PaymentDeps, limit = 50): Promise<number> {
  if (!deps.provider) return 0;
  const now = deps.now();
  const { rows } = await deps.pool.query<{ id: string }>(
    `select id from payment_attempts
     where status in ('initiated','pending','expired')
       and provider = $1
       and created_at < $2
       and (last_checked_at is null or last_checked_at < $2)
       and created_at > $3
     order by coalesce(last_checked_at, created_at) limit $4`,
    [
      deps.provider.name,
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 7 * 86_400_000),
      limit,
    ],
  );
  let processed = 0;
  for (const { id } of rows) {
    const outcome = await processPayment(deps, id, 'reconcile');
    if (outcome !== 'pending') processed++;
  }
  return processed;
}

export function toTopUp(row: PaymentRow) {
  return {
    id: row.id,
    txRef: row.tx_ref,
    amountSantim: Number(row.amount_santim),
    currency: 'ETB' as const,
    status: row.status,
    checkoutUrl: row.status === 'pending' ? row.checkout_url : null,
    provider: row.provider,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null,
  };
}
