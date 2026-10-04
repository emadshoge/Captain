import {
  AuditEntrySchema,
  AuditQuerySchema,
  COMMON_ERROR_CODES,
  ReasonBodySchema,
  RiderAdminDetailSchema,
  RiderAdminSummarySchema,
  STAFF_ERROR_CODES,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { type AuthDeps, revokeAllSessions } from '../auth/service';
import { AppError } from '../errors';
import { recordAudit } from '../lib/audit';
import { normalizeEmail, normalizeEthiopianPhone } from '../lib/contacts';
import { type Queryable, one, withTransaction } from '../lib/db';

const IdParams = z.object({ id: z.uuid() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RiderStatus = 'active' | 'suspended' | 'deletion_requested' | 'deleted';

interface RiderRow {
  id: string;
  display_name: string | null;
  status: RiderStatus;
  status_reason: string | null;
  terms_version: string | null;
  terms_accepted_at: Date | null;
  deletion_requested_at: Date | null;
  created_at: Date;
  contacts: { kind: 'email' | 'phone'; value: string }[];
}

const RIDER_SELECT = `
  select r.id, r.display_name, r.status, r.status_reason, r.terms_version, r.terms_accepted_at,
         r.deletion_requested_at, r.created_at,
         coalesce(json_agg(json_build_object('kind', c.kind, 'value', c.value) order by c.kind)
                  filter (where c.id is not null), '[]') as contacts
  from riders r left join rider_contacts c on c.rider_id = r.id`;

/** Wallet figures straight from the ledger (sum of lines) and active holds. */
export async function walletFigures(q: Queryable, riderId: string) {
  const row = await one<{ balance: string; held: string }>(
    q,
    `select
       coalesce((select sum(l.amount_santim) from ledger_lines l
                 join ledger_accounts a on a.id = l.account_id
                 where a.type = 'rider_wallet' and a.rider_id = $1), 0) as balance,
       coalesce((select sum(amount_santim) from wallet_holds where rider_id = $1 and status = 'active'), 0) as held`,
    [riderId],
  );
  return { balanceSantim: Number(row?.balance ?? 0), heldSantim: Number(row?.held ?? 0) };
}

async function openRideId(q: Queryable, riderId: string): Promise<string | null> {
  const row = await one<{ id: string }>(
    q,
    `select id from rides where rider_id = $1 and status not in ('completed','start_failed') limit 1`,
    [riderId],
  );
  return row?.id ?? null;
}

async function loadRider(q: Queryable, id: string): Promise<RiderRow> {
  const row = await one<RiderRow>(q, `${RIDER_SELECT} where r.id = $1 group by r.id`, [id]);
  if (!row) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
  return row;
}

function summary(row: RiderRow): z.infer<typeof RiderAdminSummarySchema> {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    contacts: row.contacts,
    createdAt: row.created_at.toISOString(),
  };
}

export const adminRoutes: FastifyPluginAsyncZod<{ deps: AuthDeps }> = async (app, { deps }) => {
  app.get(
    '/v1/admin/riders',
    {
      config: { permission: 'riders.read' },
      schema: {
        querystring: z.object({
          q: z.string().trim().max(254).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: z.array(RiderAdminSummarySchema) },
      },
    },
    async (request) => {
      const { q, limit } = request.query;
      let where = 'true';
      const params: unknown[] = [];
      if (q) {
        const phone = normalizeEthiopianPhone(q);
        const email = normalizeEmail(q);
        if (UUID.test(q)) {
          params.push(q);
          where = `r.id = $1`;
        } else if (phone || email) {
          params.push(phone ?? email);
          where = `r.id in (select rider_id from rider_contacts where value = $1)`;
        } else {
          params.push(`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
          where = `r.display_name ilike $1`;
        }
      }
      params.push(limit);
      const { rows } = await deps.pool.query<RiderRow>(
        `${RIDER_SELECT} where ${where} group by r.id order by r.created_at desc limit $${params.length}`,
        params,
      );
      return rows.map(summary);
    },
  );

  app.get(
    '/v1/admin/riders/:id',
    {
      config: { permission: 'riders.read' },
      schema: { params: IdParams, response: { 200: RiderAdminDetailSchema } },
    },
    async (request) => {
      const row = await loadRider(deps.pool, request.params.id);
      const wallet = await walletFigures(deps.pool, row.id);
      // Viewing a rider's personal data is itself an audited action.
      await recordAudit(deps.pool, request, {
        action: 'rider.viewed',
        targetType: 'rider',
        targetId: row.id,
      });
      return {
        ...summary(row),
        statusReason: row.status_reason,
        termsVersion: row.terms_version,
        termsAcceptedAt: row.terms_accepted_at?.toISOString() ?? null,
        deletionRequestedAt: row.deletion_requested_at?.toISOString() ?? null,
        walletBalanceSantim: wallet.balanceSantim,
        heldSantim: wallet.heldSantim,
        openRideId: await openRideId(deps.pool, row.id),
      };
    },
  );

  const transition = (
    path: string,
    action: string,
    from: RiderStatus[],
    to: RiderStatus,
    revokeSessions: boolean,
  ) =>
    app.post(
      path,
      {
        config: { permission: 'riders.manage' },
        schema: {
          params: IdParams,
          body: ReasonBodySchema,
          response: { 200: RiderAdminSummarySchema },
        },
      },
      async (request) => {
        await withTransaction(deps.pool, async (client) => {
          const before = await loadRider(client, request.params.id);
          if (!from.includes(before.status)) {
            throw new AppError(409, STAFF_ERROR_CODES.INVALID_STATE, `Rider is ${before.status}.`);
          }
          await client.query(
            `update riders set status = $2, status_reason = $3, updated_at = now() where id = $1`,
            [before.id, to, request.body.reason],
          );
          if (revokeSessions)
            await revokeAllSessions(client, { riderId: before.id }, `rider_${to}`, deps.now());
          await recordAudit(client, request, {
            action,
            targetType: 'rider',
            targetId: before.id,
            reason: request.body.reason,
            before: { status: before.status },
            after: { status: to },
          });
        });
        return summary(await loadRider(deps.pool, request.params.id));
      },
    );

  transition('/v1/admin/riders/:id/suspend', 'rider.suspended', ['active'], 'suspended', true);
  transition('/v1/admin/riders/:id/unsuspend', 'rider.unsuspended', ['suspended'], 'active', false);

  /**
   * Completes a rider-requested deletion (docs/privacy-retention.md): removes
   * personal data, keeps rides and the ledger. Refused while anything financial
   * or operational is still open.
   */
  app.post(
    '/v1/admin/riders/:id/complete-deletion',
    {
      config: { permission: 'riders.manage' },
      schema: {
        params: IdParams,
        body: ReasonBodySchema,
        response: { 200: RiderAdminSummarySchema },
      },
    },
    async (request) => {
      await withTransaction(deps.pool, async (client) => {
        await client.query(`select id from riders where id = $1 for update`, [request.params.id]);
        const rider = await loadRider(client, request.params.id);
        if (rider.status !== 'deletion_requested') {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            'The rider has not requested deletion.',
          );
        }
        const blockers: string[] = [];
        if (await openRideId(client, rider.id)) blockers.push('open_ride');
        const reservation = await one(
          client,
          `select 1 from reservations where rider_id = $1 and status = 'active'`,
          [rider.id],
        );
        if (reservation) blockers.push('active_reservation');
        const wallet = await walletFigures(client, rider.id);
        if (wallet.balanceSantim !== 0) blockers.push('wallet_balance_not_zero');
        if (wallet.heldSantim !== 0) blockers.push('active_holds');
        const incident = await one(
          client,
          `select 1 from incidents where rider_id = $1 and status <> 'resolved'`,
          [rider.id],
        );
        if (incident) blockers.push('open_incident');
        const refund = await one(
          client,
          `select 1 from refunds where rider_id = $1 and status in ('requested','approved','processing')`,
          [rider.id],
        );
        if (refund) blockers.push('open_refund');
        if (blockers.length > 0) {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.DELETION_BLOCKED,
            'Deletion cannot be completed yet.',
            { blockers },
          );
        }
        await client.query(`delete from rider_contacts where rider_id = $1`, [rider.id]);
        await client.query(`delete from otp_challenges where rider_id = $1`, [rider.id]);
        await revokeAllSessions(client, { riderId: rider.id }, 'rider_deleted', deps.now());
        await client.query(
          `update riders set display_name = null, status = 'deleted', status_reason = null, deleted_at = $2, updated_at = $2
           where id = $1`,
          [rider.id, deps.now()],
        );
        await recordAudit(client, request, {
          action: 'rider.deleted',
          targetType: 'rider',
          targetId: rider.id,
          reason: request.body.reason,
          before: { status: rider.status, contactKinds: rider.contacts.map((c) => c.kind) },
          after: { status: 'deleted' },
        });
      });
      return summary(await loadRider(deps.pool, request.params.id));
    },
  );

  app.get(
    '/v1/admin/audit',
    {
      config: { permission: 'audit.read' },
      schema: {
        querystring: AuditQuerySchema,
        response: {
          200: z.object({
            entries: z.array(AuditEntrySchema),
            nextBefore: z.number().int().nullable(),
          }),
        },
      },
    },
    async (request) => {
      const filters: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        filters.push(sql.replace('?', `$${params.length}`));
      };
      const q = request.query;
      if (q.targetType) add('target_type = ?', q.targetType);
      if (q.targetId) add('target_id = ?', q.targetId);
      if (q.actorStaffId) add('actor_staff_id = ?', q.actorStaffId);
      if (q.action) add('action = ?', q.action);
      if (q.before) add('id < ?', q.before);
      params.push(q.limit);
      const { rows } = await deps.pool.query<{
        id: number;
        actor_type: 'system' | 'staff' | 'rider';
        actor_staff_id: string | null;
        actor_rider_id: string | null;
        action: string;
        target_type: string;
        target_id: string | null;
        reason: string | null;
        before: unknown;
        after: unknown;
        request_id: string | null;
        created_at: Date;
      }>(
        `select * from audit_log ${filters.length ? `where ${filters.join(' and ')}` : ''}
         order by id desc limit $${params.length}`,
        params,
      );
      return {
        entries: rows.map((r) => ({
          id: Number(r.id),
          actorType: r.actor_type,
          actorStaffId: r.actor_staff_id,
          actorRiderId: r.actor_rider_id,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          reason: r.reason,
          before: r.before,
          after: r.after,
          requestId: r.request_id,
          createdAt: r.created_at.toISOString(),
        })),
        nextBefore: rows.length === q.limit ? Number(rows.at(-1)!.id) : null,
      };
    },
  );
};
