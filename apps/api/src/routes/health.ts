import type { ReadinessResponse } from '@captain/contracts';
import { HealthResponseSchema, ReadinessResponseSchema } from '@captain/contracts';
import type { Pool } from '@captain/db';
import { getMigrationStatus } from '@captain/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

interface HealthOptions {
  pool: Pool;
  migrationsFolder?: string;
}

export const healthRoutes: FastifyPluginAsyncZod<HealthOptions> = async (
  app,
  { pool, migrationsFolder },
) => {
  // Liveness: the process is up. Does not touch dependencies.
  app.get('/health', { schema: { response: { 200: HealthResponseSchema } } }, async () => ({
    status: 'ok' as const,
    service: 'captain-api',
  }));

  // Readiness: database reachable and all migrations applied.
  app.get(
    '/ready',
    { schema: { response: { 200: ReadinessResponseSchema, 503: ReadinessResponseSchema } } },
    async (request, reply) => {
      const checks: ReadinessResponse['checks'] = { database: 'error', migrations: 'error' };
      try {
        await pool.query('select 1');
        checks.database = 'ok';
        const status = await getMigrationStatus(pool, migrationsFolder);
        checks.migrations = status.pending.length === 0 ? 'ok' : 'pending';
      } catch (error) {
        request.log.warn({ err: error }, 'readiness check failed');
      }
      const ready = checks.database === 'ok' && checks.migrations === 'ok';
      return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
    },
  );
};
