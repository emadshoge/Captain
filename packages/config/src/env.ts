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
export const OTP_EMAIL_PROVIDERS = ['none', 'log_only'] as const;
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

export const apiEnvSchema = baseSchema.extend(providerSchema.shape).extend({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: port.default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((value) => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
});
export type ApiConfig = z.infer<typeof apiEnvSchema>;

export const gatewayEnvSchema = baseSchema.extend({
  DEVICE_ADAPTER: providerSchema.shape.DEVICE_ADAPTER,
  HOST: z.string().min(1).default('127.0.0.1'),
  HEALTH_PORT: port.default(3100),
});
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
