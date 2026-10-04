import { AUTH_ERROR_CODES, COMMON_ERROR_CODES, type Permission } from '@captain/contracts';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { authenticate } from './http';
import type { AuthDeps } from './service';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required permission for staff routes; 'any-staff' = any authenticated staff member. */
    permission?: Permission | 'any-staff';
    /** Reachable before the staff member has completed MFA enrollment/verification. */
    allowWithoutMfa?: boolean;
  }
}

export const STAFF_ROUTE_PREFIXES = ['/v1/admin/', '/v1/operator/', '/v1/staff/'] as const;

export function isStaffRoute(url: string | undefined): boolean {
  return url !== undefined && STAFF_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Backend authorization for every staff route, fail-closed:
 * - the caller must be an authenticated, active staff member;
 * - a route that forgot to declare `config.permission` is denied (and logged);
 * - with STAFF_MFA_REQUIRED, sessions without a verified second factor can
 *   only reach routes marked `allowWithoutMfa` (enrollment);
 * - the staff member must hold the declared permission.
 */
export function registerStaffGuard(app: FastifyInstance, deps: AuthDeps) {
  // onRequest: authorization runs before body parsing and validation, so
  // unauthorized callers learn nothing about request schemas.
  app.addHook('onRequest', async (request) => {
    const url = request.routeOptions.url;
    if (!isStaffRoute(url)) return;
    const auth = await authenticate(request, deps);
    if (auth.type !== 'staff') {
      throw new AppError(403, COMMON_ERROR_CODES.FORBIDDEN, 'Staff account required.');
    }
    const { permission, allowWithoutMfa } = request.routeOptions.config;
    if (!permission) {
      request.log.error(
        { route: url },
        'staff route has no permission declared; denying (fail closed)',
      );
      throw new AppError(
        403,
        COMMON_ERROR_CODES.FORBIDDEN,
        'You do not have access to this resource.',
      );
    }
    if (deps.config.STAFF_MFA_REQUIRED && !auth.mfaVerified && !allowWithoutMfa) {
      throw new AppError(
        403,
        AUTH_ERROR_CODES.MFA_ENROLLMENT_REQUIRED,
        'Set up your authenticator app and sign in again to continue.',
      );
    }
    if (permission !== 'any-staff' && !auth.permissions.has(permission)) {
      request.log.warn({ permission, staffId: auth.staffId, route: url }, 'permission denied');
      throw new AppError(
        403,
        COMMON_ERROR_CODES.FORBIDDEN,
        'You do not have access to this resource.',
      );
    }
  });
}
