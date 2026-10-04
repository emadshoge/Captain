import { z } from 'zod';
import { SantimSchema } from './common';
import { ReasonSchema } from './staff';

export const WALLET_ERROR_CODES = {
  TOPUP_BELOW_MINIMUM: 'TOPUP_BELOW_MINIMUM',
  TOPUP_ABOVE_LIMIT: 'TOPUP_ABOVE_LIMIT',
  PAYMENTS_UNAVAILABLE: 'PAYMENTS_UNAVAILABLE',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  SECOND_APPROVER_REQUIRED: 'SECOND_APPROVER_REQUIRED',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
} as const;

export const WalletSchema = z.object({
  currency: z.literal('ETB'),
  /** Sum of the rider's ledger lines. */
  balanceSantim: z.number().int(),
  /** Funds reserved by active holds (e.g. during a ride). */
  heldSantim: z.number().int(),
  /** balance − held: what can be spent now. */
  availableSantim: z.number().int(),
  minimumTopUpSantim: z.number().int(),
});

export const WalletTransactionSchema = z.object({
  journalId: z.uuid(),
  kind: z.enum(['topup', 'ride_charge', 'reservation_fee', 'refund', 'adjustment', 'reversal']),
  amountSantim: z.number().int(),
  description: z.string(),
  referenceType: z.string(),
  referenceId: z.string(),
  createdAt: z.iso.datetime(),
});

export const TransactionsQuerySchema = z.object({
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const CreateTopUpSchema = z.object({ amountSantim: SantimSchema });

export const PaymentStatusSchema = z.enum([
  'initiated',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'review',
]);

export const TopUpSchema = z.object({
  id: z.uuid(),
  txRef: z.string(),
  amountSantim: z.number().int(),
  currency: z.literal('ETB'),
  status: PaymentStatusSchema,
  checkoutUrl: z.string().nullable(),
  provider: z.enum(['chapa', 'fake']),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
});

export const AdminPaymentSchema = TopUpSchema.extend({
  riderId: z.uuid(),
  providerReference: z.string().nullable(),
  verifiedAmountSantim: z.number().int().nullable(),
  verifiedCurrency: z.string().nullable(),
  failureReason: z.string().nullable(),
  journalId: z.uuid().nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
});

export const AdminPaymentsQuerySchema = z.object({
  status: PaymentStatusSchema.optional(),
  riderId: z.uuid().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ExportQuerySchema = z.object({ from: z.iso.datetime(), to: z.iso.datetime() });

export const AdjustmentSchema = z.object({
  /** Signed: positive credits the rider, negative debits. */
  amountSantim: z
    .number()
    .int()
    .refine((v) => v !== 0, 'must not be zero'),
  reason: ReasonSchema,
});

export const CreateRefundSchema = z.object({
  riderId: z.uuid(),
  amountSantim: SantimSchema.refine((v) => v > 0, 'must be positive'),
  destination: z.enum(['wallet', 'original_payment']),
  paymentId: z.uuid().optional(),
  rideId: z.uuid().optional(),
  reason: ReasonSchema,
});

export const RefundDecisionSchema = z.object({ note: z.string().trim().min(3).max(500) });
export const CompleteRefundSchema = z.object({
  providerReference: z.string().trim().min(3).max(120),
  note: z.string().trim().min(3).max(500),
});

export const RefundSchema = z.object({
  id: z.uuid(),
  riderId: z.uuid(),
  paymentId: z.uuid().nullable(),
  rideId: z.uuid().nullable(),
  amountSantim: z.number().int(),
  destination: z.enum(['wallet', 'original_payment']),
  status: z.enum(['requested', 'approved', 'rejected', 'processing', 'completed', 'failed']),
  reason: z.string(),
  requestedByStaffId: z.uuid().nullable(),
  decidedByStaffId: z.uuid().nullable(),
  decisionNote: z.string().nullable(),
  journalId: z.uuid().nullable(),
  providerReference: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
