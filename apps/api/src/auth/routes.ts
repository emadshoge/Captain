import {
  OtpRequestResponseSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  RefreshRequestSchema,
  SessionResponseSchema,
} from '@captain/contracts';
import { COMMON_ERROR_CODES } from '@captain/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors';
import {
  assertAllowedOrigin,
  authenticate,
  clearSessionCookies,
  cookieNames,
  requestMeta,
  setSessionCookies,
} from './http';
import {
  type AuthDeps,
  type IssuedSession,
  csrfTokenFor,
  refreshSession,
  requestOtp,
  revokeSession,
  verifyLogin,
} from './service';

function tokenBody(deps: AuthDeps, client: 'mobile' | 'web', session: IssuedSession) {
  return {
    sessionId: session.sessionId,
    accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
    sessionExpiresAt: session.sessionExpiresAt.toISOString(),
    // Mobile keeps tokens in secure storage; web gets HttpOnly cookies + a CSRF token instead.
    ...(client === 'mobile'
      ? { accessToken: session.accessToken, refreshToken: session.refreshToken }
      : { csrfToken: csrfTokenFor(deps.config.AUTH_SECRET, session.sessionId) }),
  };
}

export const authRoutes: FastifyPluginAsyncZod<{ deps: AuthDeps }> = async (app, { deps }) => {
  app.post(
    '/v1/auth/otp/request',
    { schema: { body: OtpRequestSchema, response: { 202: OtpRequestResponseSchema } } },
    async (request, reply) => {
      const result = await requestOtp(deps, request.body, requestMeta(request));
      return reply.code(202).send({
        challengeId: result.challengeId,
        expiresAt: result.expiresAt.toISOString(),
        resendAvailableAt: result.resendAvailableAt.toISOString(),
      });
    },
  );

  app.post(
    '/v1/auth/otp/verify',
    { schema: { body: OtpVerifySchema, response: { 200: SessionResponseSchema } } },
    async (request, reply) => {
      // Login CSRF: a browser sign-in must come from an allowed origin.
      if (request.body.client === 'web') assertAllowedOrigin(request, deps.config);
      const { session, subject } = await verifyLogin(deps, request.body, requestMeta(request));
      if (request.body.client === 'web') setSessionCookies(reply, deps.config, session);
      return { ...tokenBody(deps, request.body.client, session), subject };
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      schema: {
        body: RefreshRequestSchema.optional(),
        response: { 200: SessionResponseSchema.omit({ subject: true }) },
      },
    },
    async (request, reply) => {
      const fromBody = request.body?.refreshToken;
      const fromCookie = request.cookies[cookieNames(deps.config).refresh];
      const token = fromBody ?? fromCookie;
      if (!token)
        throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
      if (!fromBody) assertAllowedOrigin(request, deps.config);
      const { session, client } = await refreshSession(deps, token, requestMeta(request));
      if (client === 'web') setSessionCookies(reply, deps.config, session);
      return tokenBody(deps, client, session);
    },
  );

  app.post(
    '/v1/auth/logout',
    { schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      const auth = await authenticate(request, deps);
      await revokeSession(deps.pool, auth.sessionId, 'logout', deps.now());
      clearSessionCookies(reply, deps.config);
      return reply.code(204).send(null);
    },
  );

  /** Current principal; web clients use it to obtain the CSRF token after a reload. */
  app.get('/v1/auth/session', async (request) => {
    const auth = await authenticate(request, deps);
    return auth.type === 'rider'
      ? {
          type: 'rider',
          riderId: auth.riderId,
          sessionId: auth.sessionId,
          client: auth.client,
          csrfToken: csrfTokenFor(deps.config.AUTH_SECRET, auth.sessionId),
        }
      : {
          type: 'staff',
          staffId: auth.staffId,
          sessionId: auth.sessionId,
          client: auth.client,
          roles: auth.roles,
          permissions: [...auth.permissions].sort(),
          csrfToken: csrfTokenFor(deps.config.AUTH_SECRET, auth.sessionId),
        };
  });
};
