import type { ApiConfig } from '@captain/config';
import type { Pool } from '@captain/db';
import { createPool } from '@captain/db';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { healthRoutes } from './routes/health';

export interface BuildAppOptions {
  config: ApiConfig;
  /** Injected in tests; otherwise created from DATABASE_URL. */
  pool?: Pool;
  migrationsFolder?: string;
}

export async function buildApp({ config, pool, migrationsFolder }: BuildAppOptions) {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const ownedPool = pool === undefined;
  const dbPool = pool ?? createPool({ connectionString: config.DATABASE_URL });
  if (ownedPool) app.addHook('onClose', async () => dbPool.end());

  await app.register(healthRoutes, { pool: dbPool, migrationsFolder });
  return app;
}
