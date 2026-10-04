import type { AppEnv } from './env';
import { ConfigError } from './errors';

// Duplicated from env.ts to avoid a runtime import cycle.
const DEV_AUTH_SECRET = 'captain-development-only-auth-secret-not-for-real-use';

/** Provider values that fake or simulate a real integration. */
export const FAKE_PROVIDER_VALUES: ReadonlySet<string> = new Set(['fake', 'log_only', 'simulated']);

/** Env var prefixes that only make sense outside production. */
const FORBIDDEN_PRODUCTION_PREFIXES = ['DEV_', 'ALLOW_FAKE_', 'FAKE_', 'SIMULATED_'];
/** Specific dev-only switches, e.g. a fixed OTP code for local testing. */
const FORBIDDEN_PRODUCTION_KEYS = ['OTP_FIXED_CODE', 'OTP_DEV_CODE'];
const PROVIDER_KEYS = [
  'PAYMENT_PROVIDER',
  'OTP_SMS_PROVIDER',
  'OTP_EMAIL_PROVIDER',
  'DEVICE_ADAPTER',
];

/**
 * Production safety guard. In production, fake payments, fake/log-only OTP,
 * simulated devices and dev-only switches are refused. There is deliberately
 * no override flag.
 */
export function assertProductionSafe(
  config: { APP_ENV: AppEnv } & Record<string, unknown>,
  env: Record<string, string | undefined>,
): void {
  if (config.APP_ENV !== 'production') return;

  const issues: string[] = [];
  // Verbose levels can capture request details; never enable them in production.
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') {
    issues.push(
      `LOG_LEVEL: "${config.LOG_LEVEL}" is not allowed in production (use info or higher)`,
    );
  }
  if (config.AUTH_SECRET === DEV_AUTH_SECRET) {
    issues.push('AUTH_SECRET: the development secret is not allowed in production');
  }
  for (const key of PROVIDER_KEYS) {
    const value = config[key];
    if (typeof value === 'string' && FAKE_PROVIDER_VALUES.has(value)) {
      issues.push(`${key}: "${value}" is not allowed in production`);
    }
  }
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) continue;
    if (
      FORBIDDEN_PRODUCTION_KEYS.includes(key) ||
      FORBIDDEN_PRODUCTION_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      // Name only: the value may be a secret.
      issues.push(`${key}: development-only variable must not be set in production`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
}
