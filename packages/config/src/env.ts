import { z } from 'zod';
import { ConfigError } from './errors';
import { assertProductionSafe } from './guard';

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

/**
 * Provider selections. `none` means the feature is not wired up yet.
 * Fake/log-only/simulated values exist for development and staging only and
 * are rejected in production by `assertProductionSafe`.
 */
export const PAYMENT_PROVIDERS = ['none', 'fake'] as const;
export const OTP_SMS_PROVIDERS = ['none', 'log_only'] as const;
export const OTP_EMAIL_PROVIDERS = ['none', 'log_only', 'smtp'] as const;
export const RIDER_CHANNELS = ['sms', 'email'] as const;
export const DEVICE_ADAPTERS = ['none', 'simulated'] as const;

const baseSchema = z.object({
  // Required with no default: a missing APP_ENV must never silently become
  // `development` (which would allow fake providers) on a production host.
  APP_ENV: z.enum(APP_ENVS),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const providerSchema = z.object({
  PAYMENT_PROVIDER: z.enum(PAYMENT_PROVIDERS).default('none'),
  OTP_SMS_PROVIDER: z.enum(OTP_SMS_PROVIDERS).default('none'),
  OTP_EMAIL_PROVIDER: z.enum(OTP_EMAIL_PROVIDERS).default('none'),
  DEVICE_ADAPTER: z.enum(DEVICE_ADAPTERS).default('none'),
});

const port = z.coerce.number().int().min(1).max(65_535);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
const splitCsv = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
const csvEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform(splitCsv)
    .pipe(z.array(z.enum(values)).min(1));
const csvUrls = z.string().transform(splitCsv).pipe(z.array(z.url()));

/** Development-only signing secret. Refused outside development/test. */
export const DEV_AUTH_SECRET = 'captain-development-only-auth-secret-not-for-real-use';
/** Development-only gateway<->API token. Refused outside development/test. */
export const DEV_INTERNAL_API_TOKEN = 'captain-development-only-internal-token-not-for-real-use';

const internalToken = z.string().min(32, 'must be at least 32 characters');

/** Fleet thresholds: operational settings, not business pricing. */
const fleetSchema = z.object({
  COMMAND_TIMEOUT_SECONDS: int(5, 120).default(20),
  /** Telemetry older than this makes a scooter "stale" (not rentable). */
  FLEET_TELEMETRY_STALE_SECONDS: int(30, 3_600).default(300),
  /** No contact for this long marks a device offline. */
  DEVICE_OFFLINE_SECONDS: int(30, 3_600).default(120),
  FLEET_MIN_RIDEABLE_BATTERY: int(0, 100).default(15),
  FLEET_LOW_BATTERY_PERCENT: int(0, 100).default(20),
});

const apiBaseSchema = baseSchema
  .extend(providerSchema.shape)
  .extend(fleetSchema.shape)
  .extend({
    /** Shared secret for the gateway's internal API calls. Required in staging/production. */
    INTERNAL_API_TOKEN: internalToken.optional(),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: port.default(3000),
    DATABASE_URL: z
      .string()
      .min(1)
      .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
    /** Number of trusted reverse-proxy hops in front of the API (for client IPs). */
    TRUST_PROXY: int(0, 5).default(0),
    BODY_LIMIT_BYTES: int(1_024, 10 * 1024 * 1024).default(1024 * 1024),

    // Authentication (Phase 4)
    /** HMAC key for OTP hashes. Required (>= 32 chars) in staging/production. */
    AUTH_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
    /** Rider sign-in channels offered (D-LOGIN unresolved: both by default). */
    AUTH_RIDER_CHANNELS: csvEnum(RIDER_CHANNELS).default(['sms', 'email']),
    OTP_TTL_SECONDS: int(60, 900).default(300),
    OTP_MAX_ATTEMPTS: int(1, 10).default(5),
    OTP_RESEND_COOLDOWN_SECONDS: int(15, 600).default(60),
    ACCESS_TOKEN_TTL_SECONDS: int(60, 3_600).default(900),
    REFRESH_TOKEN_TTL_DAYS: int(1, 90).default(30),
    RIDER_SESSION_MAX_DAYS: int(1, 365).default(90),
    STAFF_SESSION_MAX_HOURS: int(1, 24).default(12),
    /** Staff must verify a TOTP second factor before using staff APIs. Must be true in staging/production. */
    STAFF_MFA_REQUIRED: bool.default(true),

    // Browser security
    /** Exact origins allowed by CORS (comma-separated). Required in staging/production. */
    CORS_ORIGINS: csvUrls.optional(),
    /** Secure cookies (HTTPS only). Must be true in staging/production. */
    COOKIE_SECURE: bool.default(true),

    // Email (SMTP) — required when OTP_EMAIL_PROVIDER=smtp
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: port.default(587),
    /** true = implicit TLS (465); false = STARTTLS required. */
    SMTP_SECURE: bool.default(false),
    /** Refuse to send without TLS. Must be true in staging/production. */
    SMTP_REQUIRE_TLS: bool.default(true),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3).optional(),
  });

const DEV_CORS_ORIGINS = ['http://localhost:3001', 'http://localhost:3002'];

export const apiEnvSchema = apiBaseSchema
  .superRefine((config, ctx) => {
    const deployed = config.APP_ENV === 'staging' || config.APP_ENV === 'production';
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (deployed && !config.AUTH_SECRET) issue('AUTH_SECRET', 'required in staging/production');
    if (deployed && !config.INTERNAL_API_TOKEN)
      issue('INTERNAL_API_TOKEN', 'required in staging/production');
    if (deployed && (!config.CORS_ORIGINS || config.CORS_ORIGINS.length === 0)) {
      issue('CORS_ORIGINS', 'required in staging/production');
    }
    if (deployed && !config.COOKIE_SECURE)
      issue('COOKIE_SECURE', 'must be true in staging/production');
    if (deployed && !config.SMTP_REQUIRE_TLS)
      issue('SMTP_REQUIRE_TLS', 'must be true in staging/production');
    if (deployed && !config.STAFF_MFA_REQUIRED)
      issue('STAFF_MFA_REQUIRED', 'must be true in staging/production');
    if (config.OTP_EMAIL_PROVIDER === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM'] as const) {
        if (!config[key]) issue(key, 'required when OTP_EMAIL_PROVIDER=smtp');
      }
    }
    if (deployed) {
      if (config.AUTH_RIDER_CHANNELS.includes('sms') && config.OTP_SMS_PROVIDER === 'none') {
        issue('AUTH_RIDER_CHANNELS', 'sms channel enabled but OTP_SMS_PROVIDER is none');
      }
      if (config.AUTH_RIDER_CHANNELS.includes('email') && config.OTP_EMAIL_PROVIDER === 'none') {
        issue('AUTH_RIDER_CHANNELS', 'email channel enabled but OTP_EMAIL_PROVIDER is none');
      }
    }
  })
  .transform((config) => ({
    ...config,
    AUTH_SECRET: config.AUTH_SECRET ?? DEV_AUTH_SECRET,
    INTERNAL_API_TOKEN: config.INTERNAL_API_TOKEN ?? DEV_INTERNAL_API_TOKEN,
    CORS_ORIGINS: config.CORS_ORIGINS ?? DEV_CORS_ORIGINS,
  }));
export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const gatewayEnvSchema = baseSchema
  .extend({
    DEVICE_ADAPTER: providerSchema.shape.DEVICE_ADAPTER,
    HOST: z.string().min(1).default('127.0.0.1'),
    HEALTH_PORT: port.default(3100),
    /** Base URL of the API's internal endpoints (private network). */
    API_INTERNAL_URL: z.url().default('http://127.0.0.1:3000'),
    INTERNAL_API_TOKEN: internalToken.optional(),
    COMMAND_POLL_INTERVAL_MS: int(200, 30_000).default(1_000),
    SIM_TELEMETRY_INTERVAL_SECONDS: int(1, 600).default(10),
  })
  .superRefine((config, ctx) => {
    const deployed = config.APP_ENV === 'staging' || config.APP_ENV === 'production';
    if (deployed && !config.INTERNAL_API_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['INTERNAL_API_TOKEN'],
        message: 'required in staging/production',
      });
    }
  })
  .transform((config) => ({
    ...config,
    INTERNAL_API_TOKEN: config.INTERNAL_API_TOKEN ?? DEV_INTERNAL_API_TOKEN,
  }));
export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

type Env = Record<string, string | undefined>;

/**
 * Parses env vars with `schema` and then applies the production guard.
 * Error messages name variables but never include their values.
 */
export function loadConfig<S extends z.ZodType<{ APP_ENV: AppEnv }>>(
  schema: S,
  env: Env = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  assertProductionSafe(result.data, env);
  return result.data;
}

export const loadApiConfig = (env: Env = process.env): ApiConfig => loadConfig(apiEnvSchema, env);
export const loadGatewayConfig = (env: Env = process.env): GatewayConfig =>
  loadConfig(gatewayEnvSchema, env);
