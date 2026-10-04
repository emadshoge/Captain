import {
  AcceptTermsSchema,
  COMMON_ERROR_CODES,
  ContactChangeRequestSchema,
  ContactChangeVerifySchema,
  DeletionRequestSchema,
  OtpRequestResponseSchema,
  RiderProfileSchema,
  SessionSummarySchema,
  UpdateProfileSchema,
} from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors';
import { clearSessionCookies, requestMeta, requireRider, riderOf } from '../auth/http';
import {
  type AuthDeps,
  requestOtp,
  revokeAllSessions,
  revokeSession,
  verifyContactChange,
} from '../auth/service';
import { type Queryable, one, withTransaction } from '../lib/db';

async function loadProfile(
  q: Queryable,
  riderId: string,
): Promise<z.infer<typeof RiderProfileSchema>> {
  const rider = await one<{
    id: string;
    display_name: string | null;
    preferred_language: string;
    status: 'active' | 'suspended' | 'deletion_requested' | 'deleted';
    terms_version: string | null;
    terms_accepted_at: Date | null;
  }>(
    q,
    `select id, display_name, preferred_language, status, terms_version, terms_accepted_at from riders where id = $1`,
    [riderId],
  );
  if (!rider) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
  const contacts = await q.query<{ kind: 'email' | 'phone'; value: string; verified_at: Date }>(
    `select kind, value, verified_at from rider_contacts where rider_id = $1 order by kind`,
    [riderId],
  );
  return {
    id: rider.id,
    displayName: rider.display_name,
    preferredLanguage: rider.preferred_language,
    status: rider.status,
    termsVersion: rider.terms_version,
    termsAcceptedAt: rider.terms_accepted_at?.toISOString() ?? null,
    contacts: contacts.rows.map((c) => ({
      kind: c.kind,
      value: c.value,
      verifiedAt: c.verified_at.toISOString(),
    })),
  };
}

export const riderAccountRoutes: FastifyPluginAsyncZod<{ deps: AuthDeps }> = async (
  app,
  { deps },
) => {
  app.addHook('preHandler', requireRider(deps));

  app.get('/v1/rider/me', { schema: { response: { 200: RiderProfileSchema } } }, async (request) =>
    loadProfile(deps.pool, riderOf(request).riderId),
  );

  app.patch(
    '/v1/rider/me',
    { schema: { body: UpdateProfileSchema, response: { 200: RiderProfileSchema } } },
    async (request) => {
      const { riderId } = riderOf(request);
      await deps.pool.query(
        `update riders set display_name = coalesce($2, display_name),
           preferred_language = coalesce($3, preferred_language), updated_at = now() where id = $1`,
        [riderId, request.body.displayName ?? null, request.body.preferredLanguage ?? null],
      );
      return loadProfile(deps.pool, riderId);
    },
  );

  app.post(
    '/v1/rider/me/terms',
    { schema: { body: AcceptTermsSchema, response: { 200: RiderProfileSchema } } },
    async (request) => {
      const { riderId } = riderOf(request);
      const now = deps.now();
      await deps.pool.query(
        `update riders set terms_version = $2, terms_accepted_at = $3, age_attested_at = $3, updated_at = $3 where id = $1`,
        [riderId, request.body.termsVersion, now],
      );
      return loadProfile(deps.pool, riderId);
    },
  );

  app.post(
    '/v1/rider/me/contacts/otp',
    { schema: { body: ContactChangeRequestSchema, response: { 202: OtpRequestResponseSchema } } },
    async (request, reply) => {
      const { riderId } = riderOf(request);
      const result = await requestOtp(
        deps,
        {
          audience: 'rider',
          channel: request.body.channel,
          destination: request.body.destination,
          purpose: 'contact_change',
          riderId,
        },
        requestMeta(request),
      );
      return reply.code(202).send({
        challengeId: result.challengeId,
        expiresAt: result.expiresAt.toISOString(),
        resendAvailableAt: result.resendAvailableAt.toISOString(),
      });
    },
  );

  app.post(
    '/v1/rider/me/contacts/verify',
    { schema: { body: ContactChangeVerifySchema, response: { 200: RiderProfileSchema } } },
    async (request) => {
      const { riderId } = riderOf(request);
      await verifyContactChange(deps, riderId, request.body, requestMeta(request));
      return loadProfile(deps.pool, riderId);
    },
  );

  /**
   * Starts account deletion. Sessions end immediately. Staff complete the
   * deletion (Phase 5): personal data is removed, while rides, payments and
   * ledger history are retained as financial records (docs/privacy-retention.md).
   */
  app.post(
    '/v1/rider/me/deletion-request',
    {
      schema: {
        body: DeletionRequestSchema,
        response: { 202: z.object({ status: z.literal('deletion_requested') }) },
      },
    },
    async (request, reply) => {
      const { riderId } = riderOf(request);
      const now = deps.now();
      await withTransaction(deps.pool, async (client) => {
        await client.query(
          `update riders set status = 'deletion_requested', deletion_requested_at = $2, updated_at = $2
           where id = $1 and status = 'active'`,
          [riderId, now],
        );
        await revokeAllSessions(client, { riderId }, 'deletion_requested', now);
        await client.query(
          `insert into audit_log (actor_type, actor_rider_id, action, target_type, target_id, ip)
           values ('rider', $1::uuid, 'rider.deletion_requested', 'rider', $1::text, $2)`,
          [riderId, request.ip],
        );
      });
      clearSessionCookies(reply, deps.config);
      return reply.code(202).send({ status: 'deletion_requested' as const });
    },
  );

  app.get(
    '/v1/rider/me/sessions',
    { schema: { response: { 200: z.array(SessionSummarySchema) } } },
    async (request) => {
      const auth = riderOf(request);
      const { rows } = await deps.pool.query<{
        id: string;
        client: 'mobile' | 'web';
        created_at: Date;
        last_used_at: Date;
        expires_at: Date;
      }>(
        `select id, client, created_at, last_used_at, expires_at from auth_sessions
       where rider_id = $1 and revoked_at is null and expires_at > now() order by last_used_at desc limit 50`,
        [auth.riderId],
      );
      return rows.map((r) => ({
        id: r.id,
        client: r.client,
        createdAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        current: r.id === auth.sessionId,
      }));
    },
  );

  app.delete(
    '/v1/rider/me/sessions/:sessionId',
    { schema: { params: z.object({ sessionId: z.uuid() }), response: { 204: z.null() } } },
    async (request, reply) => {
      const { riderId } = riderOf(request);
      // Ownership check in SQL: another rider's session id is simply "not found".
      const owned = await one(
        deps.pool,
        `select 1 from auth_sessions where id = $1 and rider_id = $2`,
        [request.params.sessionId, riderId],
      );
      if (!owned) throw new AppError(404, COMMON_ERROR_CODES.NOT_FOUND, 'Resource not found.');
      await revokeSession(deps.pool, request.params.sessionId, 'revoked_by_rider', deps.now());
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/v1/rider/me/sessions/revoke-all',
    { schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      await revokeAllSessions(
        deps.pool,
        { riderId: riderOf(request).riderId },
        'revoked_all_by_rider',
        deps.now(),
      );
      clearSessionCookies(reply, deps.config);
      return reply.code(204).send(null);
    },
  );
};
