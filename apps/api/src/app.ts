import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import type { ApiConfig } from '@captain/config';
import type { Pool } from '@captain/db';
import { createPool } from '@captain/db';
import { createLogger, REQUEST_ID_HEADER, resolveRequestId } from '@captain/logging';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DestinationStream } from 'pino';
import { adminRoutes } from './admin/routes';
import { registerStaffGuard } from './auth/guard';
import { CSRF_HEADER } from './auth/http';
import { authRoutes } from './auth/routes';
import { createOtpSenders, type OtpSenders } from './auth/senders';
import type { AuthDeps } from './auth/service';
import { devRoutes } from './dev/routes';
import { registerErrorHandling } from './errors';
import { internalRoutes } from './fleet/internal-routes';
import { riderFleetRoutes } from './fleet/rider-routes';
import { fleetStaffRoutes } from './fleet/staff-routes';
import { riderAccountRoutes } from './rider/routes';
import { initRideEngine } from './rides/engine';
import { riderRideRoutes, staffRideRoutes } from './rides/routes';
import type { PaymentDeps } from './wallet/payments';
import { createPaymentProvider, type PaymentProvider } from './wallet/providers';
import {
  fakeCheckoutRoutes,
  riderWalletRoutes,
  walletStaffRoutes,
  webhookRoutes,
} from './wallet/routes';
import { healthRoutes } from './routes/health';
import { staffRoutes } from './staff/routes';

export interface BuildAppOptions {
  config: ApiConfig;
  /** Injected in tests; otherwise created from DATABASE_URL. */
  pool?: Pool;
  migrationsFolder?: string;
  /** Test hook: capture log lines instead of writing to stdout. */
  logDestination?: DestinationStream;
  /** Test hooks: replace OTP senders / the clock. */
  senders?: OtpSenders;
  now?: () => Date;
  /** Test hook: inject a payment provider (e.g. a FakePaymentProvider instance). */
  paymentProvider?: PaymentProvider | null;
}

export async function buildApp({
  config,
  pool,
  migrationsFolder,
  logDestination,
  senders,
  now,
  paymentProvider,
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
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Client IPs (rate limits, audit) come from X-Forwarded-For only through trusted hops.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  registerErrorHandling(app);

  await app.register(fastifyHelmet, {
    // JSON API: no HTML, so a locked-down CSP; HSTS only matters behind HTTPS.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    hsts: config.COOKIE_SECURE ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  await app.register(fastifyCors, {
    // Exact origins only; never "*" with credentials.
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      CSRF_HEADER,
      REQUEST_ID_HEADER,
      'idempotency-key',
    ],
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
    maxAge: 600,
  });
  await app.register(fastifyCookie);

  const ownedPool = pool === undefined;
  const dbPool = pool ?? createPool({ connectionString: config.DATABASE_URL });
  if (ownedPool) app.addHook('onClose', async () => dbPool.end());

  const otpSenders = senders ?? createOtpSenders(config);
  const deps: AuthDeps = {
    config,
    pool: dbPool,
    senders: otpSenders,
    now: now ?? (() => new Date()),
  };
  app.decorateRequest('auth', null);
  // Fail-closed authorization for /v1/admin, /v1/operator and /v1/staff routes.
  // Registered before any route plugin so every route inherits it.
  registerStaffGuard(app, deps);

  await app.register(healthRoutes, { pool: dbPool, migrationsFolder });
  await app.register(authRoutes, { deps });
  await app.register(riderAccountRoutes, { deps });
  await app.register(staffRoutes, { deps });
  await app.register(adminRoutes, { deps });
  await app.register(riderFleetRoutes, { deps });
  await app.register(fleetStaffRoutes, { deps });
  await app.register(internalRoutes, { deps });

  const rideDeps = { config, pool: dbPool, now: deps.now };
  initRideEngine(rideDeps);
  await app.register(riderRideRoutes, { deps: rideDeps, authDeps: deps });
  await app.register(staffRideRoutes, { deps: rideDeps });

  const paymentDeps: PaymentDeps = {
    config,
    pool: dbPool,
    now: deps.now,
    provider: paymentProvider === undefined ? createPaymentProvider(config) : paymentProvider,
  };
  await app.register(riderWalletRoutes, { deps: paymentDeps, authDeps: deps });
  await app.register(webhookRoutes, { deps: paymentDeps });
  await app.register(walletStaffRoutes, { deps: paymentDeps });
  if (config.APP_ENV === 'development' || config.APP_ENV === 'test') {
    await app.register(fakeCheckoutRoutes, { deps: paymentDeps });
  }
  if (config.APP_ENV === 'development' || config.APP_ENV === 'test') {
    await app.register(devRoutes, { senders: otpSenders });
  }
  return app;
}
