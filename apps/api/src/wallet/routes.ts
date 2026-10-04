import {
  AdjustmentSchema,
  AdminPaymentSchema,
  AdminPaymentsQuerySchema,
  COMMON_ERROR_CODES,
  CompleteRefundSchema,
  CreateRefundSchema,
  CreateTopUpSchema,
  ExportQuerySchema,
  RefundDecisionSchema,
  RefundSchema,
  STAFF_ERROR_CODES,
  TopUpSchema,
  TransactionsQuerySchema,
  WALLET_ERROR_CODES,
  WalletSchema,
  WalletTransactionSchema,
} from '@captain/contracts';
import { MIN_TOPUP_SANTIM } from '@captain/domain';
import type { FastifyPluginAsync } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRider, riderOf, staffOf } from '../auth/http';
import { AppError } from '../errors';
import { recordAudit } from '../lib/audit';
import { toCsv } from '../lib/csv';
import { type Queryable, isUniqueViolation, one, withTransaction } from '../lib/db';
import { withIdempotency } from '../lib/idempotency';
import { enforceRateLimit } from '../lib/rate-limit';
import {
  lockWallet,
  notFound,
  postJournal,
  requireFunds,
  systemAccountId,
  walletFigures,
} from './ledger';
import {
  type PaymentDeps,
  type PaymentRow,
  createTopUp,
  processPayment,
  toTopUp,
} from './payments';
import { FakePaymentProvider } from './providers';

const IdParams = z.object({ id: z.uuid() });

async function walletTransactions(
  q: Queryable,
  riderId: string,
  before: string | undefined,
  limit: number,
) {
  const { rows } = await q.query<{
    journal_id: string;
    kind: z.infer<typeof WalletTransactionSchema>['kind'];
    amount: number;
    description: string;
    reference_type: string;
    reference_id: string;
    created_at: Date;
  }>(
    `select j.id as journal_id, j.kind::text as kind, sum(l.amount_santim) as amount, j.description,
            j.reference_type, j.reference_id, j.created_at
     from ledger_lines l
     join ledger_accounts a on a.id = l.account_id and a.type = 'rider_wallet' and a.rider_id = $1
     join journal_entries j on j.id = l.journal_id
     where ($2::timestamptz is null or j.created_at < $2)
     group by j.id order by j.created_at desc, j.id desc limit $3`,
    [riderId, before ?? null, limit],
  );
  return rows.map((r) => ({
    journalId: r.journal_id,
    kind: r.kind,
    amountSantim: Number(r.amount),
    description: r.description,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    createdAt: r.created_at.toISOString(),
  }));
}

function walletBody(figures: Awaited<ReturnType<typeof walletFigures>>) {
  return { currency: 'ETB' as const, ...figures, minimumTopUpSantim: MIN_TOPUP_SANTIM };
}

// ---------------------------------------------------------------------------
// Rider wallet
// ---------------------------------------------------------------------------

export const riderWalletRoutes: FastifyPluginAsyncZod<{
  deps: PaymentDeps;
  authDeps: Parameters<typeof requireRider>[0];
}> = async (app, { deps, authDeps }) => {
  app.addHook('onRequest', requireRider(authDeps));

  app.get('/v1/rider/wallet', { schema: { response: { 200: WalletSchema } } }, async (request) =>
    walletBody(await walletFigures(deps.pool, riderOf(request).riderId)),
  );

  app.get(
    '/v1/rider/wallet/transactions',
    {
      schema: {
        querystring: TransactionsQuerySchema,
        response: { 200: z.array(WalletTransactionSchema) },
      },
    },
    async (request) =>
      walletTransactions(
        deps.pool,
        riderOf(request).riderId,
        request.query.before,
        request.query.limit,
      ),
  );

  app.post(
    '/v1/rider/wallet/topups',
    { schema: { body: CreateTopUpSchema, response: { 201: TopUpSchema } } },
    async (request, reply) => {
      const { riderId } = riderOf(request);
      await enforceRateLimit(
        deps.pool,
        { scope: 'topup-create', limit: 10, windowSeconds: 3_600 },
        riderId,
        deps.now(),
      );
      return withIdempotency(
        deps.pool,
        request,
        reply,
        `rider:${riderId}`,
        deps.now(),
        async () => ({
          status: 201,
          body: toTopUp(await createTopUp(deps, riderId, request.body.amountSantim)),
        }),
      );
    },
  );

  app.get(
    '/v1/rider/wallet/topups/:id',
    { schema: { params: IdParams, response: { 200: TopUpSchema } } },
    async (request) => {
      // Ownership enforced in SQL: another rider's payment is "not found".
      const row = await one<PaymentRow>(
        deps.pool,
        `select * from payment_attempts where id = $1 and rider_id = $2`,
        [request.params.id, riderOf(request).riderId],
      );
      if (!row) throw notFound();
      return toTopUp(row);
    },
  );

  /**
   * Called when the rider returns from checkout. It only asks the server to
   * VERIFY with the provider; nothing the client says can credit the wallet.
   */
  app.post(
    '/v1/rider/wallet/topups/:id/check',
    { schema: { params: IdParams, response: { 200: TopUpSchema } } },
    async (request) => {
      const { riderId } = riderOf(request);
      const row = await one<PaymentRow>(
        deps.pool,
        `select * from payment_attempts where id = $1 and rider_id = $2`,
        [request.params.id, riderId],
      );
      if (!row) throw notFound();
      await enforceRateLimit(
        deps.pool,
        { scope: 'topup-check', limit: 30, windowSeconds: 600 },
        row.id,
        deps.now(),
      );
      if (row.status !== 'succeeded') await processPayment(deps, row.id, 'redirect');
      const updated = await one<PaymentRow>(
        deps.pool,
        `select * from payment_attempts where id = $1`,
        [row.id],
      );
      return toTopUp(updated!);
    },
  );
};

// ---------------------------------------------------------------------------
// Provider webhooks (raw body for signature verification)
// ---------------------------------------------------------------------------

export const webhookRoutes: FastifyPluginAsync<{ deps: PaymentDeps }> = async (app, { deps }) => {
  // Signatures are computed over the exact bytes received.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.post('/v1/webhooks/:provider', async (request, reply) => {
    const providerName = (request.params as { provider: string }).provider;
    const provider = deps.provider;
    if (!provider || provider.name !== providerName) {
      throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
    }
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
    const notice = provider.parseWebhook(raw, request.headers);

    // Record every notification (deduplicated by provider event id).
    let eventId: number | null;
    try {
      const inserted = await one<{ id: number }>(
        deps.pool,
        `insert into payment_events (provider, source, dedupe_key, signature_valid, payload, outcome)
         values ($1, 'webhook', $2, $3, $4, $5) returning id`,
        [
          provider.name,
          notice.dedupeKey,
          notice.signatureValid,
          JSON.stringify(notice.payload),
          notice.signatureValid ? 'received' : 'rejected_signature',
        ],
      );
      eventId = inserted?.id ?? null;
    } catch (error) {
      if (isUniqueViolation(error))
        return reply.code(200).send({ received: true, duplicate: true });
      throw error;
    }
    if (!notice.signatureValid) {
      request.log.warn({ provider: provider.name }, 'webhook with invalid signature rejected');
      throw new AppError(401, WALLET_ERROR_CODES.INVALID_SIGNATURE, 'Invalid signature.');
    }
    const payment = notice.txRef
      ? await one<{ id: string }>(
          deps.pool,
          `select id from payment_attempts where tx_ref = $1 and provider = $2`,
          [notice.txRef, provider.name],
        )
      : undefined;
    if (!payment) {
      await deps.pool.query(
        `update payment_events set outcome = 'unknown_reference' where id = $1`,
        [eventId],
      );
      return reply.code(200).send({ received: true });
    }
    await deps.pool.query(`update payment_events set payment_id = $2 where id = $1`, [
      eventId,
      payment.id,
    ]);
    // The webhook only triggers a server-side verification.
    const outcome = await processPayment(deps, payment.id, 'webhook');
    return reply.code(200).send({ received: true, outcome });
  });
};

// ---------------------------------------------------------------------------
// Staff: payments, exports, adjustments, refunds
// ---------------------------------------------------------------------------

function toAdminPayment(row: PaymentRow) {
  return {
    ...toTopUp(row),
    checkoutUrl: row.checkout_url,
    riderId: row.rider_id,
    providerReference: row.provider_reference,
    verifiedAmountSantim:
      row.verified_amount_santim === null ? null : Number(row.verified_amount_santim),
    verifiedCurrency: row.verified_currency,
    failureReason: row.failure_reason,
    journalId: row.journal_id,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
  };
}

interface RefundRow {
  id: string;
  rider_id: string;
  payment_id: string | null;
  ride_id: string | null;
  amount_santim: number;
  destination: 'wallet' | 'original_payment';
  status: z.infer<typeof RefundSchema>['status'];
  reason: string;
  requested_by_staff_id: string | null;
  decided_by_staff_id: string | null;
  decision_note: string | null;
  journal_id: string | null;
  provider_reference: string | null;
  created_at: Date;
}
const toRefund = (r: RefundRow) => ({
  id: r.id,
  riderId: r.rider_id,
  paymentId: r.payment_id,
  rideId: r.ride_id,
  amountSantim: Number(r.amount_santim),
  destination: r.destination,
  status: r.status,
  reason: r.reason,
  requestedByStaffId: r.requested_by_staff_id,
  decidedByStaffId: r.decided_by_staff_id,
  decisionNote: r.decision_note,
  journalId: r.journal_id,
  providerReference: r.provider_reference,
  createdAt: r.created_at.toISOString(),
});

export const walletStaffRoutes: FastifyPluginAsyncZod<{ deps: PaymentDeps }> = async (
  app,
  { deps },
) => {
  app.get(
    '/v1/admin/payments',
    {
      config: { permission: 'payments.read' },
      schema: {
        querystring: AdminPaymentsQuerySchema,
        response: { 200: z.array(AdminPaymentSchema) },
      },
    },
    async (request) => {
      const q = request.query;
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.status) where.push(`status = $${params.push(q.status)}`);
      if (q.riderId) where.push(`rider_id = $${params.push(q.riderId)}`);
      if (q.from) where.push(`created_at >= $${params.push(q.from)}`);
      if (q.to) where.push(`created_at < $${params.push(q.to)}`);
      const { rows } = await deps.pool.query<PaymentRow>(
        `select * from payment_attempts ${where.length ? `where ${where.join(' and ')}` : ''}
         order by created_at desc limit $${params.push(q.limit)}`,
        params,
      );
      return rows.map(toAdminPayment);
    },
  );

  app.get(
    '/v1/admin/payments/:id',
    { config: { permission: 'payments.read' }, schema: { params: IdParams } },
    async (request) => {
      const row = await one<PaymentRow>(deps.pool, `select * from payment_attempts where id = $1`, [
        request.params.id,
      ]);
      if (!row) throw notFound();
      const events = await deps.pool.query(
        `select id, source, dedupe_key, signature_valid, outcome, received_at from payment_events where payment_id = $1 order by id`,
        [row.id],
      );
      return { payment: toAdminPayment(row), events: events.rows };
    },
  );

  app.post(
    '/v1/admin/payments/:id/verify',
    { config: { permission: 'payments.reconcile' }, schema: { params: IdParams } },
    async (request) => {
      const outcome = await processPayment(deps, request.params.id, 'reconcile');
      if (outcome === 'not_found') throw notFound();
      await recordAudit(deps.pool, request, {
        action: 'payment.verify_requested',
        targetType: 'payment_attempt',
        targetId: request.params.id,
        after: { outcome },
      });
      return { outcome };
    },
  );

  /** Bounded CSV export (≤ 31 days, ≤ 50 000 rows), formula-injection safe. */
  app.get(
    '/v1/admin/payments/export.csv',
    { config: { permission: 'reports.export' }, schema: { querystring: ExportQuerySchema } },
    async (request, reply) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (to <= from || to.getTime() - from.getTime() > 31 * 86_400_000) {
        throw new AppError(
          400,
          COMMON_ERROR_CODES.VALIDATION_FAILED,
          'Choose a range of at most 31 days.',
        );
      }
      const { rows } = await deps.pool.query<PaymentRow>(
        `select * from payment_attempts where created_at >= $1 and created_at < $2 order by created_at limit 50000`,
        [from, to],
      );
      await recordAudit(deps.pool, request, {
        action: 'report.exported',
        targetType: 'payment_attempts',
        after: { from: request.query.from, to: request.query.to, rows: rows.length },
      });
      const csv = toCsv(
        [
          'payment_id',
          'created_at',
          'rider_id',
          'provider',
          'tx_ref',
          'provider_reference',
          'amount_santim',
          'currency',
          'status',
          'verified_at',
          'journal_id',
          'failure_reason',
        ],
        rows.map((r) => [
          r.id,
          r.created_at,
          r.rider_id,
          r.provider,
          r.tx_ref,
          r.provider_reference,
          Number(r.amount_santim),
          r.currency,
          r.status,
          r.verified_at,
          r.journal_id,
          r.failure_reason,
        ]),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="captain-payments-${request.query.from.slice(0, 10)}.csv"`,
        )
        .send(csv);
    },
  );

  app.get(
    '/v1/admin/riders/:id/wallet',
    {
      config: { permission: 'wallet.read' },
      schema: { params: IdParams, querystring: TransactionsQuerySchema },
    },
    async (request) => {
      const exists = await one(deps.pool, `select 1 from riders where id = $1`, [
        request.params.id,
      ]);
      if (!exists) throw notFound();
      return {
        wallet: walletBody(await walletFigures(deps.pool, request.params.id)),
        transactions: await walletTransactions(
          deps.pool,
          request.params.id,
          request.query.before,
          request.query.limit,
        ),
      };
    },
  );

  /** Staff wallet adjustment: reason required, audited, never below zero available. */
  app.post(
    '/v1/admin/riders/:id/adjustments',
    {
      config: { permission: 'wallet.adjust' },
      schema: { params: IdParams, body: AdjustmentSchema, response: { 201: WalletSchema } },
    },
    async (request, reply) => {
      const staff = staffOf(request);
      return withIdempotency(
        deps.pool,
        request,
        reply,
        `staff:${staff.staffId}`,
        deps.now(),
        async () => {
          await withTransaction(deps.pool, async (client) => {
            const exists = await one(client, `select 1 from riders where id = $1`, [
              request.params.id,
            ]);
            if (!exists) throw notFound();
            const walletId = await lockWallet(client, request.params.id);
            if (request.body.amountSantim < 0)
              requireFunds(
                await walletFigures(client, request.params.id),
                -request.body.amountSantim,
              );
            const adjustmentsAccount = await systemAccountId(client, 'adjustments');
            const adjustmentId = (await one<{ id: string }>(
              client,
              `select gen_random_uuid() as id`,
            ))!.id;
            const { journalId } = await postJournal(client, {
              kind: 'adjustment',
              referenceType: 'wallet_adjustment',
              referenceId: adjustmentId,
              description: `Staff adjustment: ${request.body.reason}`,
              createdBy: { type: 'staff', staffId: staff.staffId },
              lines: [
                { accountId: adjustmentsAccount, amountSantim: -request.body.amountSantim },
                { accountId: walletId, amountSantim: request.body.amountSantim },
              ],
            });
            await client.query(
              `insert into wallet_adjustments (id, rider_id, amount_santim, reason, staff_id, journal_id) values ($1,$2,$3,$4,$5,$6)`,
              [
                adjustmentId,
                request.params.id,
                request.body.amountSantim,
                request.body.reason,
                staff.staffId,
                journalId,
              ],
            );
            await recordAudit(client, request, {
              action: 'wallet.adjusted',
              targetType: 'rider',
              targetId: request.params.id,
              reason: request.body.reason,
              after: { amountSantim: request.body.amountSantim, journalId },
            });
          });
          return {
            status: 201,
            body: walletBody(await walletFigures(deps.pool, request.params.id)),
          };
        },
      );
    },
  );

  // ---- Refunds (maker-checker) ------------------------------------------------
  app.post(
    '/v1/admin/refunds',
    {
      config: { permission: 'wallet.adjust' },
      schema: { body: CreateRefundSchema, response: { 201: RefundSchema } },
    },
    async (request, reply) => {
      const staff = staffOf(request);
      const body = request.body;
      if (body.destination === 'original_payment' && !body.paymentId) {
        throw new AppError(
          400,
          COMMON_ERROR_CODES.VALIDATION_FAILED,
          'A refund to the original payment needs paymentId.',
        );
      }
      const row = await withTransaction(deps.pool, async (client) => {
        if (body.paymentId) {
          const payment = await one<PaymentRow>(
            client,
            `select * from payment_attempts where id = $1 and rider_id = $2`,
            [body.paymentId, body.riderId],
          );
          if (!payment || payment.status !== 'succeeded') {
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'Only a succeeded payment of this rider can be refunded.',
            );
          }
          const refunded = await one<{ total: number }>(
            client,
            `select coalesce(sum(amount_santim), 0) as total from refunds
             where payment_id = $1 and status not in ('rejected','failed')`,
            [body.paymentId],
          );
          if (Number(refunded!.total) + body.amountSantim > Number(payment.amount_santim)) {
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              'Refunds would exceed the original payment.',
            );
          }
        }
        const created = await one<RefundRow>(
          client,
          `insert into refunds (rider_id, payment_id, ride_id, amount_santim, destination, reason, requested_by_type, requested_by_staff_id)
           values ($1,$2,$3,$4,$5,$6,'staff',$7) returning *`,
          [
            body.riderId,
            body.paymentId ?? null,
            body.rideId ?? null,
            body.amountSantim,
            body.destination,
            body.reason,
            staff.staffId,
          ],
        );
        await recordAudit(client, request, {
          action: 'refund.requested',
          targetType: 'refund',
          targetId: created!.id,
          reason: body.reason,
          after: {
            amountSantim: body.amountSantim,
            destination: body.destination,
            riderId: body.riderId,
          },
        });
        return created!;
      });
      return reply.code(201).send(toRefund(row));
    },
  );

  app.get(
    '/v1/admin/refunds',
    {
      config: { permission: 'payments.read' },
      schema: {
        querystring: z.object({ status: RefundSchema.shape.status.optional() }),
        response: { 200: z.array(RefundSchema) },
      },
    },
    async (request) => {
      const { rows } = await deps.pool.query<RefundRow>(
        `select *, destination::text as destination, status::text as status from refunds
         ${request.query.status ? 'where status = $1' : ''} order by created_at desc limit 200`,
        request.query.status ? [request.query.status] : [],
      );
      return rows.map(toRefund);
    },
  );

  const decide = (action: 'approve' | 'reject') =>
    app.post(
      `/v1/admin/refunds/:id/${action}`,
      {
        config: { permission: 'refunds.approve' },
        schema: { params: IdParams, body: RefundDecisionSchema, response: { 200: RefundSchema } },
      },
      async (request) => {
        const staff = staffOf(request);
        const row = await withTransaction(deps.pool, async (client) => {
          const refund = await one<RefundRow>(
            client,
            `select * from refunds where id = $1 for update`,
            [request.params.id],
          );
          if (!refund) throw notFound();
          if (refund.status !== 'requested')
            throw new AppError(
              409,
              STAFF_ERROR_CODES.INVALID_STATE,
              `The refund is ${refund.status}.`,
            );
          if (
            deps.config.REFUNDS_REQUIRE_SECOND_APPROVER &&
            refund.requested_by_staff_id === staff.staffId
          ) {
            throw new AppError(
              409,
              WALLET_ERROR_CODES.SECOND_APPROVER_REQUIRED,
              'A different staff member must approve this refund.',
            );
          }
          let status: RefundRow['status'] = action === 'reject' ? 'rejected' : 'approved';
          let journalId: string | null = null;
          if (action === 'approve' && refund.destination === 'wallet') {
            // Credit the rider's wallet now.
            const walletId = await lockWallet(client, refund.rider_id);
            ({ journalId } = await postJournal(client, {
              kind: 'refund',
              referenceType: 'refund',
              referenceId: refund.id,
              description: `Refund: ${refund.reason}`,
              createdBy: { type: 'staff', staffId: staff.staffId },
              lines: [
                {
                  accountId: await systemAccountId(client, 'refunds'),
                  amountSantim: -Number(refund.amount_santim),
                },
                { accountId: walletId, amountSantim: Number(refund.amount_santim) },
              ],
            }));
            status = 'completed';
          }
          const updated = await one<RefundRow>(
            client,
            `update refunds set status = $2, decided_by_staff_id = $3, decided_at = now(), decision_note = $4,
               journal_id = $5, updated_at = now() where id = $1 returning *`,
            [refund.id, status, staff.staffId, request.body.note, journalId],
          );
          await recordAudit(client, request, {
            action: `refund.${action === 'approve' ? 'approved' : 'rejected'}`,
            targetType: 'refund',
            targetId: refund.id,
            reason: request.body.note,
            before: { status: refund.status },
            after: { status, journalId },
          });
          return updated!;
        });
        return toRefund(row);
      },
    );
  decide('approve');
  decide('reject');

  /**
   * Refunds to the original payment method are executed outside Captain
   * (provider refund capability is unverified, T-01). Finance records the
   * provider's reference here; only then is the wallet debited.
   */
  app.post(
    '/v1/admin/refunds/:id/complete',
    {
      config: { permission: 'refunds.approve' },
      schema: { params: IdParams, body: CompleteRefundSchema, response: { 200: RefundSchema } },
    },
    async (request) => {
      const staff = staffOf(request);
      const row = await withTransaction(deps.pool, async (client) => {
        const refund = await one<RefundRow>(
          client,
          `select * from refunds where id = $1 for update`,
          [request.params.id],
        );
        if (!refund) throw notFound();
        if (refund.destination !== 'original_payment' || refund.status !== 'approved') {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            'Only approved refunds to the original payment can be completed.',
          );
        }
        const walletId = await lockWallet(client, refund.rider_id);
        requireFunds(await walletFigures(client, refund.rider_id), Number(refund.amount_santim));
        const { journalId } = await postJournal(client, {
          kind: 'refund',
          referenceType: 'refund',
          referenceId: refund.id,
          description: `Refund to original payment (${request.body.providerReference})`,
          createdBy: { type: 'staff', staffId: staff.staffId },
          lines: [
            { accountId: walletId, amountSantim: -Number(refund.amount_santim) },
            {
              accountId: await systemAccountId(client, 'provider_clearing'),
              amountSantim: Number(refund.amount_santim),
            },
          ],
        });
        const updated = await one<RefundRow>(
          client,
          `update refunds set status = 'completed', provider_reference = $2, journal_id = $3, decision_note = $4, updated_at = now()
           where id = $1 returning *`,
          [refund.id, request.body.providerReference, journalId, request.body.note],
        );
        await recordAudit(client, request, {
          action: 'refund.completed',
          targetType: 'refund',
          targetId: refund.id,
          reason: request.body.note,
          after: { providerReference: request.body.providerReference, journalId },
        });
        return updated!;
      });
      return toRefund(row);
    },
  );
};

// ---------------------------------------------------------------------------
// Development-only fake checkout (never registered in staging/production)
// ---------------------------------------------------------------------------

export const fakeCheckoutRoutes: FastifyPluginAsyncZod<{ deps: PaymentDeps }> = async (
  app,
  { deps },
) => {
  if (!(deps.provider instanceof FakePaymentProvider)) return;
  const provider: FakePaymentProvider = deps.provider;

  const esc = (value: string) => value.replace(/[<>&"']/g, '');

  app.get('/v1/dev/fake-checkout/:txRef', async (request, reply) => {
    const { txRef } = request.params as { txRef: string };
    const tx = provider.transactions.get(txRef);
    if (!tx) throw notFound();
    const ref = encodeURIComponent(txRef);
    return reply.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><title>SIMULATED checkout</title>
       <h1>SIMULATED payment — no real money</h1><p>Reference ${esc(txRef)}, amount ${tx.amountSantim / 100} ETB.</p>
       <p><a id="pay" href="/v1/dev/fake-checkout/${ref}/pay?outcome=success">Pay (simulated)</a>
       · <a id="fail" href="/v1/dev/fake-checkout/${ref}/pay?outcome=failed">Fail (simulated)</a></p>`,
    );
  });

  async function complete(txRef: string, outcome: 'success' | 'failed') {
    provider.settle(txRef, outcome);
    const { raw, signature } = provider.signWebhook({
      event_id: `evt-${txRef}-${outcome}`,
      tx_ref: txRef,
      status: outcome,
    });
    return app.inject({
      method: 'POST',
      url: '/v1/webhooks/fake',
      headers: { 'content-type': 'application/json', 'x-fake-signature': signature },
      payload: raw,
    });
  }

  /** Browser flow: "pays", sends the signed webhook, returns to the rider app. */
  app.get(
    '/v1/dev/fake-checkout/:txRef/pay',
    {
      schema: {
        params: z.object({ txRef: z.string().min(5).max(80) }),
        querystring: z.object({ outcome: z.enum(['success', 'failed']) }),
      },
    },
    async (request, reply) => {
      if (!provider.transactions.has(request.params.txRef)) throw notFound();
      await complete(request.params.txRef, request.query.outcome);
      const back = deps.config.RIDER_RETURN_URL;
      if (!back) return reply.type('text/html').send('<p>SIMULATED payment recorded.</p>');
      const url = new URL(back);
      url.searchParams.set('txRef', request.params.txRef);
      return reply.redirect(url.toString());
    },
  );

  /** Simulates the customer paying and the provider sending its signed webhook. */
  app.post(
    '/v1/dev/fake-checkout/:txRef/complete',
    {
      schema: {
        params: z.object({ txRef: z.string().min(5).max(80) }),
        body: z.object({ outcome: z.enum(['success', 'failed']) }),
      },
    },
    async (request) => {
      const response = await complete(request.params.txRef, request.body.outcome);
      return { simulated: true, webhookStatus: response.statusCode, webhook: response.json() };
    },
  );
};
