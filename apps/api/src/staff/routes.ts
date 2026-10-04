import {
  COMMON_ERROR_CODES,
  CreateStaffSchema,
  ReasonBodySchema,
  STAFF_ERROR_CODES,
  SetStaffRolesSchema,
  StaffMeSchema,
  StaffSummarySchema,
  TotpConfirmSchema,
  TotpSetupResponseSchema,
  UpdateStaffStatusSchema,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { staffOf } from '../auth/http';
import { type AuthDeps, revokeAllSessions } from '../auth/service';
import { AppError } from '../errors';
import { recordAudit } from '../lib/audit';
import { normalizeEmail } from '../lib/contacts';
import { type Queryable, isUniqueViolation, one, withTransaction } from '../lib/db';
import {
  decryptSecret,
  encryptSecret,
  newTotpSecret,
  otpauthUri,
  base32Encode,
  verifyTotp,
} from '../lib/totp';

const IdParams = z.object({ id: z.uuid() });

interface StaffRow {
  id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended' | 'disabled';
  last_login_at: Date | null;
  created_at: Date;
  roles: string[];
  mfa_enabled: boolean;
}

const STAFF_SELECT = `
  select s.id, s.email, s.display_name, s.status, s.last_login_at, s.created_at,
         coalesce(array_agg(r.role_key order by r.role_key) filter (where r.role_key is not null), '{}') as roles,
         exists (select 1 from staff_totp t where t.staff_id = s.id and t.confirmed_at is not null) as mfa_enabled
  from staff_users s left join staff_roles r on r.staff_id = s.id`;

function toSummary(row: StaffRow): z.infer<typeof StaffSummarySchema> {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    roles: row.roles,
    mfaEnabled: row.mfa_enabled,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadStaff(q: Queryable, id: string): Promise<StaffRow> {
  const row = await one<StaffRow>(q, `${STAFF_SELECT} where s.id = $1 group by s.id`, [id]);
  if (!row) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
  return row;
}

/** Fails if the change would leave no active administrator. */
async function assertAdminRemains(q: Queryable, excludingStaffId: string) {
  const row = await one<{ n: number }>(
    q,
    `select count(*)::int as n from staff_users s join staff_roles r on r.staff_id = s.id
     where r.role_key = 'admin' and s.status = 'active' and s.id <> $1`,
    [excludingStaffId],
  );
  if (!row || row.n < 1) {
    throw new AppError(
      409,
      STAFF_ERROR_CODES.LAST_ADMIN,
      'At least one active administrator must remain.',
    );
  }
}

function forbidSelf(actorId: string, targetId: string) {
  if (actorId === targetId) {
    throw new AppError(
      409,
      STAFF_ERROR_CODES.SELF_CHANGE_FORBIDDEN,
      'Ask another administrator to make this change.',
    );
  }
}

export const staffRoutes: FastifyPluginAsyncZod<{ deps: AuthDeps }> = async (app, { deps }) => {
  // ---- Self service -------------------------------------------------------
  app.get(
    '/v1/staff/me',
    {
      config: { permission: 'any-staff', allowWithoutMfa: true },
      schema: { response: { 200: StaffMeSchema } },
    },
    async (request) => {
      const auth = staffOf(request);
      const row = await loadStaff(deps.pool, auth.staffId);
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        roles: row.roles,
        permissions: [...auth.permissions].sort(),
        mfaEnabled: row.mfa_enabled,
        mfaVerifiedThisSession: auth.mfaVerified,
      };
    },
  );

  app.post(
    '/v1/staff/me/totp/setup',
    {
      config: { permission: 'any-staff', allowWithoutMfa: true },
      schema: { response: { 200: TotpSetupResponseSchema } },
    },
    async (request) => {
      const auth = staffOf(request);
      const staff = await loadStaff(deps.pool, auth.staffId);
      if (staff.mfa_enabled) {
        throw new AppError(
          409,
          STAFF_ERROR_CODES.INVALID_STATE,
          'An authenticator is already set up. Ask an administrator to reset it.',
        );
      }
      const secret = newTotpSecret();
      await deps.pool.query(
        `insert into staff_totp (staff_id, secret_ciphertext) values ($1, $2)
         on conflict (staff_id) do update set secret_ciphertext = excluded.secret_ciphertext, created_at = now()
         where staff_totp.confirmed_at is null`,
        [auth.staffId, encryptSecret(secret, deps.config.AUTH_SECRET)],
      );
      return { otpauthUri: otpauthUri(secret, staff.email), secret: base32Encode(secret) };
    },
  );

  app.post(
    '/v1/staff/me/totp/confirm',
    {
      config: { permission: 'any-staff', allowWithoutMfa: true },
      schema: { body: TotpConfirmSchema, response: { 200: StaffMeSchema } },
    },
    async (request) => {
      const auth = staffOf(request);
      await withTransaction(deps.pool, async (client) => {
        const pending = await one<{ secret_ciphertext: string; confirmed_at: Date | null }>(
          client,
          `select secret_ciphertext, confirmed_at from staff_totp where staff_id = $1 for update`,
          [auth.staffId],
        );
        if (!pending || pending.confirmed_at) {
          throw new AppError(
            409,
            STAFF_ERROR_CODES.INVALID_STATE,
            'Start authenticator setup first.',
          );
        }
        const step = verifyTotp(
          decryptSecret(pending.secret_ciphertext, deps.config.AUTH_SECRET),
          request.body.code,
          deps.now().getTime(),
          null,
        );
        if (step === null) {
          throw new AppError(400, 'MFA_INVALID', 'The authenticator code is incorrect.');
        }
        await client.query(
          `update staff_totp set confirmed_at = $2, last_used_step = $3 where staff_id = $1`,
          [auth.staffId, deps.now(), step],
        );
        // This session proved possession of the new factor.
        await client.query(`update auth_sessions set mfa_verified = true where id = $1`, [
          auth.sessionId,
        ]);
        await recordAudit(client, request, {
          action: 'staff.mfa.enrolled',
          targetType: 'staff_user',
          targetId: auth.staffId,
        });
      });
      const row = await loadStaff(deps.pool, auth.staffId);
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        roles: row.roles,
        permissions: [...auth.permissions].sort(),
        mfaEnabled: row.mfa_enabled,
        mfaVerifiedThisSession: true,
      };
    },
  );

  // ---- Administration (staff.manage) ---------------------------------------
  app.get(
    '/v1/admin/staff',
    {
      config: { permission: 'staff.manage' },
      schema: { response: { 200: z.array(StaffSummarySchema) } },
    },
    async () => {
      const { rows } = await deps.pool.query<StaffRow>(
        `${STAFF_SELECT} group by s.id order by s.created_at`,
      );
      return rows.map(toSummary);
    },
  );

  app.post(
    '/v1/admin/staff',
    {
      config: { permission: 'staff.manage' },
      schema: { body: CreateStaffSchema, response: { 201: StaffSummarySchema } },
    },
    async (request, reply) => {
      const actor = staffOf(request);
      const email = normalizeEmail(request.body.email);
      if (!email)
        throw new AppError(
          400,
          COMMON_ERROR_CODES.VALIDATION_FAILED,
          'Enter a valid email address.',
        );
      const id = await withTransaction(deps.pool, async (client) => {
        let created: { id: string } | undefined;
        try {
          created = await one<{ id: string }>(
            client,
            `insert into staff_users (email, display_name, created_by_staff_id) values ($1,$2,$3) returning id`,
            [email, request.body.displayName, actor.staffId],
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError(
              409,
              STAFF_ERROR_CODES.STAFF_EXISTS,
              'A staff member with this email already exists.',
            );
          }
          throw error;
        }
        for (const role of new Set(request.body.roles)) {
          await client.query(
            `insert into staff_roles (staff_id, role_key, granted_by_staff_id) values ($1,$2,$3)`,
            [created!.id, role, actor.staffId],
          );
        }
        await recordAudit(client, request, {
          action: 'staff.created',
          targetType: 'staff_user',
          targetId: created!.id,
          reason: request.body.reason,
          after: { email, roles: request.body.roles },
        });
        return created!.id;
      });
      return reply.code(201).send(toSummary(await loadStaff(deps.pool, id)));
    },
  );

  app.patch(
    '/v1/admin/staff/:id/status',
    {
      config: { permission: 'staff.manage' },
      schema: {
        params: IdParams,
        body: UpdateStaffStatusSchema,
        response: { 200: StaffSummarySchema },
      },
    },
    async (request) => {
      const actor = staffOf(request);
      forbidSelf(actor.staffId, request.params.id);
      await withTransaction(deps.pool, async (client) => {
        const before = await loadStaff(client, request.params.id);
        await client.query(`select id from staff_users where id = $1 for update`, [
          request.params.id,
        ]);
        if (request.body.status !== 'active' && before.roles.includes('admin')) {
          await assertAdminRemains(client, request.params.id);
        }
        await client.query(`update staff_users set status = $2, updated_at = now() where id = $1`, [
          request.params.id,
          request.body.status,
        ]);
        if (request.body.status !== 'active') {
          await revokeAllSessions(
            client,
            { staffId: request.params.id },
            `staff_${request.body.status}`,
            deps.now(),
          );
        }
        await recordAudit(client, request, {
          action: 'staff.status_changed',
          targetType: 'staff_user',
          targetId: request.params.id,
          reason: request.body.reason,
          before: { status: before.status },
          after: { status: request.body.status },
        });
      });
      return toSummary(await loadStaff(deps.pool, request.params.id));
    },
  );

  app.put(
    '/v1/admin/staff/:id/roles',
    {
      config: { permission: 'staff.manage' },
      schema: {
        params: IdParams,
        body: SetStaffRolesSchema,
        response: { 200: StaffSummarySchema },
      },
    },
    async (request) => {
      const actor = staffOf(request);
      const roles = [...new Set(request.body.roles)].sort();
      await withTransaction(deps.pool, async (client) => {
        const before = await loadStaff(client, request.params.id);
        await client.query(`select id from staff_users where id = $1 for update`, [
          request.params.id,
        ]);
        if (before.roles.includes('admin') && !roles.includes('admin')) {
          forbidSelf(actor.staffId, request.params.id);
          await assertAdminRemains(client, request.params.id);
        }
        await client.query(`delete from staff_roles where staff_id = $1`, [request.params.id]);
        for (const role of roles) {
          await client.query(
            `insert into staff_roles (staff_id, role_key, granted_by_staff_id) values ($1,$2,$3)`,
            [request.params.id, role, actor.staffId],
          );
        }
        await recordAudit(client, request, {
          action: 'staff.roles_changed',
          targetType: 'staff_user',
          targetId: request.params.id,
          reason: request.body.reason,
          before: { roles: before.roles },
          after: { roles },
        });
      });
      return toSummary(await loadStaff(deps.pool, request.params.id));
    },
  );

  app.post(
    '/v1/admin/staff/:id/totp/reset',
    {
      config: { permission: 'staff.manage' },
      schema: { params: IdParams, body: ReasonBodySchema, response: { 200: StaffSummarySchema } },
    },
    async (request) => {
      const actor = staffOf(request);
      forbidSelf(actor.staffId, request.params.id);
      await withTransaction(deps.pool, async (client) => {
        await loadStaff(client, request.params.id);
        await client.query(`delete from staff_totp where staff_id = $1`, [request.params.id]);
        await revokeAllSessions(client, { staffId: request.params.id }, 'mfa_reset', deps.now());
        await recordAudit(client, request, {
          action: 'staff.mfa.reset',
          targetType: 'staff_user',
          targetId: request.params.id,
          reason: request.body.reason,
        });
      });
      return toSummary(await loadStaff(deps.pool, request.params.id));
    },
  );
};
