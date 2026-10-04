import { COMMON_ERROR_CODES, WALLET_ERROR_CODES } from '@captain/contracts';
import { assertSantim } from '@captain/domain';
import type pg from 'pg';
import { AppError } from '../errors';
import { type Queryable, one } from '../lib/db';

export type SystemAccount =
  'provider_clearing' | 'ride_revenue' | 'reservation_revenue' | 'refunds' | 'adjustments';
export type JournalKind =
  'topup' | 'ride_charge' | 'reservation_fee' | 'refund' | 'adjustment' | 'reversal';

export interface JournalInput {
  kind: JournalKind;
  referenceType: string;
  referenceId: string;
  description: string;
  createdBy: { type: 'system' | 'staff' | 'rider'; staffId?: string | null };
  lines: { accountId: string; amountSantim: number }[];
  reversesJournalId?: string;
}

/**
 * Posts a balanced journal inside the caller's transaction. Idempotent per
 * (referenceType, referenceId, kind): a repeat returns the existing journal
 * and posts nothing. The database independently enforces balance and
 * immutability (migration 0002).
 */
export async function postJournal(
  client: pg.PoolClient,
  input: JournalInput,
): Promise<{ journalId: string; created: boolean }> {
  if (input.lines.length < 2) throw new Error('journal needs at least two lines');
  let sum = 0;
  for (const line of input.lines) {
    assertSantim(line.amountSantim, 'ledger line');
    if (line.amountSantim === 0) throw new Error('ledger lines must be non-zero');
    sum += line.amountSantim;
  }
  if (sum !== 0) throw new Error(`journal is unbalanced by ${sum} santim`);

  const inserted = await one<{ id: string }>(
    client,
    `insert into journal_entries (kind, reference_type, reference_id, description, reverses_journal_id,
       created_by_type, created_by_staff_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (reference_type, reference_id, kind) do nothing
     returning id`,
    [
      input.kind,
      input.referenceType,
      input.referenceId,
      input.description,
      input.reversesJournalId ?? null,
      input.createdBy.type,
      input.createdBy.staffId ?? null,
    ],
  );
  if (!inserted) {
    const existing = await one<{ id: string }>(
      client,
      `select id from journal_entries where reference_type = $1 and reference_id = $2 and kind = $3`,
      [input.referenceType, input.referenceId, input.kind],
    );
    return { journalId: existing!.id, created: false };
  }
  for (const line of input.lines) {
    await client.query(
      `insert into ledger_lines (journal_id, account_id, amount_santim) values ($1, $2, $3)`,
      [inserted.id, line.accountId, line.amountSantim],
    );
  }
  return { journalId: inserted.id, created: true };
}

export async function systemAccountId(q: Queryable, type: SystemAccount): Promise<string> {
  const row = await one<{ id: string }>(
    q,
    `select id from ledger_accounts where type = $1 and rider_id is null and currency = 'ETB'`,
    [type],
  );
  if (!row) throw new Error(`system ledger account ${type} missing`);
  return row.id;
}

/**
 * Locks the rider's wallet account row. Every balance-dependent operation
 * (debits, holds, adjustments) takes this lock first, serializing them per
 * rider so concurrent requests cannot overspend.
 */
export async function lockWallet(client: pg.PoolClient, riderId: string): Promise<string> {
  const row = await one<{ id: string }>(
    client,
    `select id from ledger_accounts where type = 'rider_wallet' and rider_id = $1 for update`,
    [riderId],
  );
  if (row) return row.id;
  // Riders created before wallets existed: create on first use.
  const created = await one<{ id: string }>(
    client,
    `insert into ledger_accounts (type, rider_id) values ('rider_wallet', $1)
     on conflict (rider_id) where type = 'rider_wallet' do nothing returning id`,
    [riderId],
  );
  if (created) return created.id;
  return lockWallet(client, riderId);
}

export interface WalletFigures {
  balanceSantim: number;
  heldSantim: number;
  availableSantim: number;
}

export async function walletFigures(q: Queryable, riderId: string): Promise<WalletFigures> {
  const row = await one<{ balance: string; held: string }>(
    q,
    `select
       coalesce((select sum(l.amount_santim) from ledger_lines l
                 join ledger_accounts a on a.id = l.account_id
                 where a.type = 'rider_wallet' and a.rider_id = $1), 0) as balance,
       coalesce((select sum(amount_santim) from wallet_holds where rider_id = $1 and status = 'active'), 0) as held`,
    [riderId],
  );
  const balanceSantim = Number(row?.balance ?? 0);
  const heldSantim = Number(row?.held ?? 0);
  return { balanceSantim, heldSantim, availableSantim: balanceSantim - heldSantim };
}

export function requireFunds(figures: WalletFigures, amountSantim: number) {
  if (figures.availableSantim < amountSantim) {
    throw new AppError(
      409,
      WALLET_ERROR_CODES.INSUFFICIENT_FUNDS,
      'There is not enough money in the wallet.',
      {
        availableSantim: figures.availableSantim,
        requiredSantim: amountSantim,
      },
    );
  }
}

export function notFound() {
  return new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
}
