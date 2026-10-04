import { z } from 'zod';

/** GET /health — liveness. Never touches dependencies. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const CheckStatusSchema = z.enum(['ok', 'error', 'pending']);

/** GET /ready — readiness. 200 when every check is ok, otherwise 503. */
export const ReadinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: CheckStatusSchema,
    migrations: CheckStatusSchema,
  }),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
