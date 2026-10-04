import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  boolean,
} from 'drizzle-orm/pg-core';
import { createdAt, currency, currencyIsEtb, santim, ts, updatedAt } from './_common';
import { riders, staffUsers } from './identity';
import { reservations, rides } from './rides';

export const ledgerAccountType = pgEnum('ledger_account_type', [
  'rider_wallet',
  'provider_clearing',
  'ride_revenue',
  'reservation_revenue',
  'refunds',
  'adjustments',
]);

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: ledgerAccountType('type').notNull(),
    riderId: uuid('rider_id').references(() => riders.id),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_accounts_rider_uq')
      .on(t.riderId)
      .where(sql`${t.type} = 'rider_wallet'`),
    uniqueIndex('ledger_accounts_system_uq')
      .on(t.type, t.currency)
      .where(sql`${t.riderId} is null`),
    unique('ledger_accounts_id_currency_uq').on(t.id, t.currency),
    currencyIsEtb(t, 'ledger_accounts_currency'),
    check('ledger_accounts_owner', sql`(${t.type} = 'rider_wallet') = (${t.riderId} is not null)`),
  ],
);

export const journalKind = pgEnum('journal_kind', [
  'topup',
  'ride_charge',
  'reservation_fee',
  'refund',
  'adjustment',
  'reversal',
]);
export const actorType = pgEnum('actor_type', ['system', 'staff', 'rider']);

/**
 * A balanced set of ledger lines. Append-only: corrections are new
 * `reversal`/`adjustment` journals. Balance and immutability are enforced by
 * database triggers (migration 0002).
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: journalKind('kind').notNull(),
    /** What caused it, e.g. ('payment_attempt', <id>) or ('ride', <id>). */
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id').notNull(),
    description: text('description').notNull(),
    reversesJournalId: uuid('reverses_journal_id'),
    createdByType: actorType('created_by_type').notNull(),
    createdByStaffId: uuid('created_by_staff_id').references(() => staffUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_entries_reference_uq').on(t.referenceType, t.referenceId, t.kind),
    foreignKey({
      columns: [t.reversesJournalId],
      foreignColumns: [t.id],
      name: 'journal_entries_reverses_fk',
    }),
  ],
);

export const ledgerLines = pgTable(
  'ledger_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid('account_id').notNull(),
    /** Signed: positive increases the account balance, negative decreases it. */
    amountSantim: santim('amount_santim').notNull(),
    currency: currency(),
    createdAt: createdAt(),
  },
  (t) => [
    // Line currency must equal the account currency.
    foreignKey({
      columns: [t.accountId, t.currency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
      name: 'ledger_lines_account_currency_fk',
    }),
    index('ledger_lines_account_idx').on(t.accountId, t.id),
    index('ledger_lines_journal_idx').on(t.journalId),
    check('ledger_lines_nonzero', sql`${t.amountSantim} <> 0`),
    currencyIsEtb(t, 'ledger_lines_currency'),
  ],
);

export const holdStatus = pgEnum('hold_status', ['active', 'released', 'captured']);

/** Funds reserved against a rider wallet (affects available balance, not the ledger). */
export const walletHolds = pgTable(
  'wallet_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    rideId: uuid('ride_id').references(() => rides.id),
    reservationId: uuid('reservation_id').references(() => reservations.id),
    amountSantim: santim('amount_santim').notNull(),
    currency: currency(),
    status: holdStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    releasedAt: ts('released_at'),
  },
  (t) => [
    index('wallet_holds_active_idx')
      .on(t.riderId)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex('wallet_holds_active_ride_uq')
      .on(t.rideId)
      .where(sql`${t.status} = 'active'`),
    check('wallet_holds_positive', sql`${t.amountSantim} > 0`),
    currencyIsEtb(t, 'wallet_holds_currency'),
  ],
);

export const paymentProvider = pgEnum('payment_provider', ['chapa', 'fake']);
export const paymentStatus = pgEnum('payment_status', [
  'initiated',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'review',
]);

export const MIN_TOPUP_SANTIM = 50_000; // 500 ETB (decision R-09)

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    provider: paymentProvider('provider').notNull(),
    /** Captain-generated unique reference sent to the provider. */
    txRef: text('tx_ref').notNull(),
    amountSantim: santim('amount_santim').notNull(),
    currency: currency(),
    status: paymentStatus('status').notNull().default('initiated'),
    providerReference: text('provider_reference'),
    checkoutUrl: text('checkout_url'),
    verifiedAt: ts('verified_at'),
    verifiedAmountSantim: santim('verified_amount_santim'),
    verifiedCurrency: text('verified_currency'),
    journalId: uuid('journal_id').references(() => journalEntries.id),
    failureReason: text('failure_reason'),
    expiresAt: ts('expires_at').notNull(),
    lastCheckedAt: ts('last_checked_at'),
    reconciledAt: ts('reconciled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_attempts_tx_ref_uq').on(t.txRef),
    uniqueIndex('payment_attempts_journal_uq').on(t.journalId),
    index('payment_attempts_rider_idx').on(t.riderId, t.createdAt),
    index('payment_attempts_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} in ('initiated','pending')`),
    check(
      'payment_attempts_min_topup',
      sql`${t.amountSantim} >= ${sql.raw(String(MIN_TOPUP_SANTIM))}`,
    ),
    currencyIsEtb(t, 'payment_attempts_currency'),
    check(
      'payment_attempts_success_credited',
      sql`${t.status} <> 'succeeded' or (${t.journalId} is not null and ${t.verifiedAt} is not null)`,
    ),
  ],
);

export const paymentEventSource = pgEnum('payment_event_source', [
  'webhook',
  'verify',
  'redirect',
  'reconcile',
]);

/** Raw provider notifications and verification results. Append-only. */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    paymentId: uuid('payment_id').references(() => paymentAttempts.id),
    provider: paymentProvider('provider').notNull(),
    source: paymentEventSource('source').notNull(),
    /** Provider event identity used to drop duplicates (null when the provider gives none). */
    dedupeKey: text('dedupe_key'),
    signatureValid: boolean('signature_valid'),
    payload: jsonb('payload').notNull(),
    outcome: text('outcome'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_events_dedupe_uq')
      .on(t.provider, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index('payment_events_payment_idx').on(t.paymentId),
  ],
);

export const refundStatus = pgEnum('refund_status', [
  'requested',
  'approved',
  'rejected',
  'processing',
  'completed',
  'failed',
]);
export const refundDestination = pgEnum('refund_destination', ['wallet', 'original_payment']);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    paymentId: uuid('payment_id').references(() => paymentAttempts.id),
    rideId: uuid('ride_id').references(() => rides.id),
    amountSantim: santim('amount_santim').notNull(),
    currency: currency(),
    destination: refundDestination('destination').notNull(),
    status: refundStatus('status').notNull().default('requested'),
    reason: text('reason').notNull(),
    requestedByType: actorType('requested_by_type').notNull(),
    requestedByStaffId: uuid('requested_by_staff_id').references(() => staffUsers.id),
    decidedByStaffId: uuid('decided_by_staff_id').references(() => staffUsers.id),
    decidedAt: ts('decided_at'),
    decisionNote: text('decision_note'),
    journalId: uuid('journal_id').references(() => journalEntries.id),
    providerReference: text('provider_reference'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('refunds_positive', sql`${t.amountSantim} > 0`),
    check('refunds_reason', sql`length(trim(${t.reason})) >= 3`),
    currencyIsEtb(t, 'refunds_currency'),
    index('refunds_status_idx').on(t.status),
  ],
);

/** Staff wallet adjustments; every one posts a journal and an audit record. */
export const walletAdjustments = pgTable(
  'wallet_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    riderId: uuid('rider_id')
      .notNull()
      .references(() => riders.id),
    amountSantim: santim('amount_santim').notNull(),
    currency: currency(),
    reason: text('reason').notNull(),
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffUsers.id),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => journalEntries.id),
    createdAt: createdAt(),
  },
  (t) => [
    check('wallet_adjustments_nonzero', sql`${t.amountSantim} <> 0`),
    check('wallet_adjustments_reason', sql`length(trim(${t.reason})) >= 3`),
    currencyIsEtb(t, 'wallet_adjustments_currency'),
  ],
);
