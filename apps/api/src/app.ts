import type { ApiConfig } from '@captain/config';
import type { Pool } from '@captain/db';
import { createPool } from '@captain/db';
import { createLogger, REQUEST_ID_HEADER, resolveRequestId } from '@captain/logging';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { registerErrorHandling } from './errors';
import { healthRoutes } from './routes/health';

export interface BuildAppOptions {
  config: ApiConfig;
  /** Injected in tests; otherwise created from DATABASE_URL. */
  pool?: Pool;
  migrationsFolder?: string;
  /** Test hook: capture log lines instead of writing to stdout. */
  logDestination?: DestinationStream;
}

export async function buildApp({
  config,
  pool,
  migrationsFolder,
  logDestination,
}: BuildAppOptions) {
  const logger = createLogger({
    service: 'captain-api',
    level: config.LOG_LEVEL,
    appEnv: config.APP_ENV,
    destination: logDestination,
  });

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Use the caller's x-request-id only when it is log-safe; otherwise a UUID.
    genReqId: (req) => resolveRequestId(req.headers[REQUEST_ID_HEADER]),
    requestIdHeader: false,
    // Request bodies are never logged: Fastify's request lines carry only
    // method, URL (sensitive query values masked) and status.
    logController: new LogController({ requestIdLogLabel: 'requestId' }),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  registerErrorHandling(app);

  const ownedPool = pool === undefined;
  const dbPool = pool ?? createPool({ connectionString: config.DATABASE_URL });
  if (ownedPool) app.addHook('onClose', async () => dbPool.end());

  await app.register(healthRoutes, { pool: dbPool, migrationsFolder });
  return app;
}
