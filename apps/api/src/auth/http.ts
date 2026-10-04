import type { ApiConfig } from '@captain/config';
import { AUTH_ERROR_CODES, COMMON_ERROR_CODES } from '@captain/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { safeEqual } from '../lib/crypto';
import {
  type AuthContext,
  type AuthDeps,
  type IssuedSession,
  authenticateAccessToken,
  csrfTokenFor,
} from './service';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const CSRF_HEADER = 'x-csrf-token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function cookieNames(config: ApiConfig) {
  // __Host- prefix: Secure, Path=/, no Domain (bound to the API host).
  const prefix = config.COOKIE_SECURE ? '__Host-' : '';
  return { access: `${prefix}captain_at`, refresh: `${prefix}captain_rt` };
}

export function setSessionCookies(reply: FastifyReply, config: ApiConfig, session: IssuedSession) {
  const names = cookieNames(config);
  const base = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict' as const,
    path: '/',
  };
  reply.setCookie(names.access, session.accessToken, {
    ...base,
    expires: session.accessTokenExpiresAt,
  });
  reply.setCookie(names.refresh, session.refreshToken, {
    ...base,
    expires: session.refreshTokenExpiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply, config: ApiConfig) {
  const names = cookieNames(config);
  const base = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict' as const,
    path: '/',
  };
  reply.clearCookie(names.access, base);
  reply.clearCookie(names.refresh, base);
}

/** Origin must be one of CORS_ORIGINS when the browser sends it. */
export function assertAllowedOrigin(request: FastifyRequest, config: ApiConfig) {
  const origin = request.headers.origin;
  if (origin !== undefined && !config.CORS_ORIGINS.includes(origin)) {
    throw new AppError(403, AUTH_ERROR_CODES.CSRF_FAILED, 'Request origin is not allowed.');
  }
}

function extractToken(
  request: FastifyRequest,
  config: ApiConfig,
): { token: string; via: 'bearer' | 'cookie' } | null {
  const header = request.headers.authorization;
  if (header) {
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match)
      throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
    return { token: match[1]!, via: 'bearer' };
  }
  const cookie = request.cookies[cookieNames(config).access];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

/**
 * Authenticates the request (bearer token or session cookie). Cookie-based
 * unsafe requests also need the session-bound CSRF header and an allowed Origin.
 */
export async function authenticate(request: FastifyRequest, deps: AuthDeps): Promise<AuthContext> {
  const found = extractToken(request, deps.config);
  if (!found)
    throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
  const auth = await authenticateAccessToken(deps, found.token, found.via);
  if (found.via === 'cookie' && UNSAFE_METHODS.has(request.method)) {
    assertAllowedOrigin(request, deps.config);
    const provided = request.headers[CSRF_HEADER];
    const expected = csrfTokenFor(deps.config.AUTH_SECRET, auth.sessionId);
    if (typeof provided !== 'string' || !safeEqual(provided, expected)) {
      throw new AppError(403, AUTH_ERROR_CODES.CSRF_FAILED, 'Missing or invalid CSRF token.');
    }
  }
  request.auth = auth;
  return auth;
}

export function requireRider(deps: AuthDeps) {
  return async (request: FastifyRequest) => {
    const auth = await authenticate(request, deps);
    if (auth.type !== 'rider')
      throw new AppError(403, COMMON_ERROR_CODES.FORBIDDEN, 'Rider account required.');
  };
}

/** Staff guard; with a permission, also enforces it (backend is the security boundary). */
export function requireStaff(deps: AuthDeps, permission?: string) {
  return async (request: FastifyRequest) => {
    const auth = await authenticate(request, deps);
    if (auth.type !== 'staff')
      throw new AppError(403, COMMON_ERROR_CODES.FORBIDDEN, 'Staff account required.');
    if (permission && !auth.permissions.has(permission)) {
      request.log.warn({ permission, staffId: auth.staffId }, 'permission denied');
      throw new AppError(
        403,
        COMMON_ERROR_CODES.FORBIDDEN,
        'You do not have access to this resource.',
      );
    }
  };
}

export function riderOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth || auth.type !== 'rider')
    throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
  return auth;
}

export function staffOf(request: FastifyRequest) {
  const auth = request.auth;
  if (!auth || auth.type !== 'staff')
    throw new AppError(401, COMMON_ERROR_CODES.UNAUTHORIZED, 'Authentication is required.');
  return auth;
}

export function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}
