import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadGatewayConfig } from '../src';

const DB = 'postgres://captain@127.0.0.1:54329/captain_dev';

describe('loadApiConfig', () => {
  it('parses a development config with defaults', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB });
    expect(config).toMatchObject({
      APP_ENV: 'development',
      PORT: 3000,
      PAYMENT_PROVIDER: 'none',
      DEVICE_ADAPTER: 'none',
    });
  });

  it('requires APP_ENV explicitly (no silent development default)', () => {
    expect(() => loadApiConfig({ DATABASE_URL: DB })).toThrow(/APP_ENV/);
  });

  it('requires a postgres DATABASE_URL', () => {
    expect(() => loadApiConfig({ APP_ENV: 'test' })).toThrow(/DATABASE_URL/);
    expect(() => loadApiConfig({ APP_ENV: 'test', DATABASE_URL: 'mysql://x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('allows fake and simulated providers outside production', () => {
    for (const APP_ENV of ['development', 'test', 'staging']) {
      expect(() =>
        loadApiConfig({
          ...(APP_ENV === 'staging'
            ? {
                AUTH_SECRET: 's'.repeat(32),
                INTERNAL_API_TOKEN: 'i'.repeat(32),
                RIDE_BILLING_CUTOFF: 'end_request',
                RIDE_END_CONFIRMATION: 'device_lock',
                RIDE_PARKING_POLICY: 'flag',
                CORS_ORIGINS: 'https://staging.captain.et',
                PUBLIC_API_URL: 'https://api.staging.captain.et',
                RIDER_RETURN_URL: 'https://staging.captain.et/wallet',
              }
            : {}),
          APP_ENV,
          DATABASE_URL: DB,
          PAYMENT_PROVIDER: 'fake',
          OTP_SMS_PROVIDER: 'log_only',
          OTP_EMAIL_PROVIDER: 'log_only',
          DEVICE_ADAPTER: 'simulated',
        }),
      ).not.toThrow();
    }
  });
});

/** Minimal valid production environment (email-only sign-in over SMTP). */
const PROD = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://db.internal/captain',
  AUTH_SECRET: 'p'.repeat(40),
  INTERNAL_API_TOKEN: 'i'.repeat(40),
  RIDE_BILLING_CUTOFF: 'end_request',
  RIDE_END_CONFIRMATION: 'device_lock',
  RIDE_PARKING_POLICY: 'flag',
  PUBLIC_API_URL: 'https://api.captain.et',
  RIDER_RETURN_URL: 'https://app.captain.et/wallet',
  CORS_ORIGINS: 'https://app.captain.et,https://staff.captain.et',
  AUTH_RIDER_CHANNELS: 'email',
  OTP_EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'smtp.example.et',
  SMTP_USER: 'captain',
  SMTP_PASSWORD: 'smtp-secret-value',
  EMAIL_FROM: 'Captain <no-reply@captain.et>',
};

describe('production safety guard', () => {
  const prod = PROD;

  it('accepts a production config with no fake providers', () => {
    expect(loadApiConfig(prod).APP_ENV).toBe('production');
  });

  it.each([
    ['PAYMENT_PROVIDER', 'fake'],
    ['OTP_SMS_PROVIDER', 'log_only'],
    ['OTP_EMAIL_PROVIDER', 'log_only'],
    ['DEVICE_ADAPTER', 'simulated'],
  ])('rejects %s=%s in production', (key, value) => {
    expect(() => loadApiConfig({ ...prod, [key]: value })).toThrow(ConfigError);
  });

  it('rejects a simulated device adapter for the gateway in production', () => {
    expect(() =>
      loadGatewayConfig({
        APP_ENV: 'production',
        INTERNAL_API_TOKEN: 'g'.repeat(40),
        DEVICE_ADAPTER: 'simulated',
      }),
    ).toThrow(/DEVICE_ADAPTER/);
  });

  it.each([
    'DEV_SKIP_AUTH',
    'ALLOW_FAKE_UNLOCK',
    'FAKE_PAYMENTS',
    'SIMULATED_DEVICES',
    'OTP_FIXED_CODE',
  ])('rejects dev-only variable %s in production', (key) => {
    expect(() => loadApiConfig({ ...prod, [key]: '1' })).toThrow(new RegExp(key));
  });

  it('never includes variable values in error messages', () => {
    const secret = 'super-secret-value-123';
    try {
      loadApiConfig({ ...prod, DEV_TOKEN: secret, DATABASE_URL: `mysql://${secret}` });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('Phase 2 configuration hardening', () => {
  const prod = PROD;

  it.each(['debug', 'trace'])('rejects LOG_LEVEL=%s in production', (level) => {
    expect(() => loadApiConfig({ ...prod, LOG_LEVEL: level })).toThrow(/LOG_LEVEL/);
    expect(() =>
      loadGatewayConfig({
        APP_ENV: 'production',
        INTERNAL_API_TOKEN: 'g'.repeat(40),
        LOG_LEVEL: level,
      }),
    ).toThrow(/LOG_LEVEL/);
  });

  it.each(['info', 'warn', 'error'])('allows LOG_LEVEL=%s in production', (level) => {
    expect(loadApiConfig({ ...prod, LOG_LEVEL: level }).LOG_LEVEL).toBe(level);
  });

  it('allows debug logging outside production', () => {
    expect(
      loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB, LOG_LEVEL: 'debug' }).LOG_LEVEL,
    ).toBe('debug');
  });

  it.each([
    ['APP_ENV', 'prod-secret-env'],
    ['LOG_LEVEL', 'loud-secret-level'],
    ['PORT', 'port-secret-xyz'],
    ['PAYMENT_PROVIDER', 'chapa-secret-key-value'],
    ['DATABASE_URL', 'mysql://admin:db-secret-pw@host/x'],
  ])('never echoes the invalid value of %s', (key, value) => {
    const env = { APP_ENV: 'development', DATABASE_URL: DB, [key]: value };
    try {
      loadApiConfig(env);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain(key);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it('reports every problem at once', () => {
    try {
      loadApiConfig({ ...prod, PAYMENT_PROVIDER: 'fake', DEVICE_ADAPTER: 'simulated', DEV_X: '1' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).issues).toHaveLength(3);
    }
  });
});

describe('Phase 4 authentication and browser settings', () => {
  it('defaults development to a labelled dev secret and localhost origins', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB });
    expect(config.AUTH_SECRET).toMatch(/development-only/);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3001', 'http://localhost:3002']);
    expect(config.AUTH_RIDER_CHANNELS).toEqual(['sms', 'email']);
  });

  it.each(['AUTH_SECRET', 'CORS_ORIGINS'])('requires %s in staging and production', (key) => {
    const env: Record<string, string> = { ...PROD };
    delete env[key];
    expect(() => loadApiConfig(env)).toThrow(new RegExp(key));
    expect(() => loadApiConfig({ ...env, APP_ENV: 'staging' })).toThrow(new RegExp(key));
  });

  it('refuses the development secret, insecure cookies and short secrets in production', () => {
    expect(() =>
      loadApiConfig({
        ...PROD,
        AUTH_SECRET: 'captain-development-only-auth-secret-not-for-real-use',
      }),
    ).toThrow(/development secret/);
    expect(() => loadApiConfig({ ...PROD, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(() => loadApiConfig({ ...PROD, AUTH_SECRET: 'short' })).toThrow(/AUTH_SECRET/);
  });

  it('requires staff MFA in staging and production', () => {
    expect(() => loadApiConfig({ ...PROD, STAFF_MFA_REQUIRED: 'false' })).toThrow(
      /STAFF_MFA_REQUIRED/,
    );
    expect(
      loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB, STAFF_MFA_REQUIRED: 'false' })
        .STAFF_MFA_REQUIRED,
    ).toBe(false);
  });

  it('requires a real provider for every enabled rider channel in production', () => {
    expect(() => loadApiConfig({ ...PROD, AUTH_RIDER_CHANNELS: 'sms,email' })).toThrow(
      /sms channel/,
    );
  });

  it('requires SMTP settings when the SMTP provider is selected', () => {
    expect(() => loadApiConfig({ ...PROD, SMTP_HOST: undefined })).toThrow(/SMTP_HOST/);
    expect(() =>
      loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB, OTP_EMAIL_PROVIDER: 'smtp' }),
    ).toThrow(/SMTP_USER/);
  });

  it('rejects malformed origins and unknown channels without echoing them', () => {
    try {
      loadApiConfig({
        ...PROD,
        CORS_ORIGINS: 'not a url secretish',
        AUTH_RIDER_CHANNELS: 'carrier-pigeon',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/CORS_ORIGINS/);
      expect((error as Error).message).toMatch(/AUTH_RIDER_CHANNELS/);
      expect((error as Error).message).not.toContain('secretish');
      expect((error as Error).message).not.toContain('carrier-pigeon');
    }
  });

  it('never echoes the SMTP password in errors', () => {
    try {
      loadApiConfig({ ...PROD, OTP_EMAIL_PROVIDER: 'log_only' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('smtp-secret-value');
    }
  });
});

describe('Phase 7 payment settings', () => {
  it('requires callback/return URLs when a provider is enabled in staging', () => {
    const staging = {
      ...PROD,
      APP_ENV: 'staging',
      PAYMENT_PROVIDER: 'fake',
      PUBLIC_API_URL: undefined,
    };
    expect(() => loadApiConfig(staging)).toThrow(/PUBLIC_API_URL/);
    expect(
      loadApiConfig({
        ...staging,
        PUBLIC_API_URL: 'https://api.staging.captain.et',
        RIDER_RETURN_URL: 'https://staging.captain.et/wallet',
      }).PAYMENT_PROVIDER,
    ).toBe('fake');
  });

  it('keeps maker-checker refunds mandatory in production and has no Chapa option yet', () => {
    expect(() => loadApiConfig({ ...PROD, REFUNDS_REQUIRE_SECOND_APPROVER: 'false' })).toThrow(
      /REFUNDS_REQUIRE_SECOND_APPROVER/,
    );
    expect(() => loadApiConfig({ ...PROD, PAYMENT_PROVIDER: 'chapa' })).toThrow(/PAYMENT_PROVIDER/);
  });
});

describe('Phase 6 fleet and internal settings', () => {
  it('requires a real internal token in staging/production for API and gateway', () => {
    const env: Record<string, string> = { ...PROD };
    delete env.INTERNAL_API_TOKEN;
    expect(() => loadApiConfig(env)).toThrow(/INTERNAL_API_TOKEN/);
    expect(() => loadGatewayConfig({ APP_ENV: 'production' })).toThrow(/INTERNAL_API_TOKEN/);
    expect(() =>
      loadApiConfig({
        ...PROD,
        INTERNAL_API_TOKEN: 'captain-development-only-internal-token-not-for-real-use',
      }),
    ).toThrow(/development token/);
    expect(
      loadGatewayConfig({ APP_ENV: 'production', INTERNAL_API_TOKEN: 'g'.repeat(40) }).APP_ENV,
    ).toBe('production');
  });

  it('has bounded fleet thresholds', () => {
    const config = loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB });
    expect(config).toMatchObject({
      COMMAND_TIMEOUT_SECONDS: 20,
      FLEET_TELEMETRY_STALE_SECONDS: 300,
    });
    expect(() =>
      loadApiConfig({ APP_ENV: 'development', DATABASE_URL: DB, COMMAND_TIMEOUT_SECONDS: '1' }),
    ).toThrow(/COMMAND_TIMEOUT_SECONDS/);
  });
});
