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

describe('production safety guard', () => {
  const prod = { APP_ENV: 'production', DATABASE_URL: 'postgres://db.internal/captain' };

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
    expect(() => loadGatewayConfig({ APP_ENV: 'production', DEVICE_ADAPTER: 'simulated' })).toThrow(
      /DEVICE_ADAPTER/,
    );
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
  const prod = { APP_ENV: 'production', DATABASE_URL: 'postgres://db.internal/captain' };

  it.each(['debug', 'trace'])('rejects LOG_LEVEL=%s in production', (level) => {
    expect(() => loadApiConfig({ ...prod, LOG_LEVEL: level })).toThrow(/LOG_LEVEL/);
    expect(() => loadGatewayConfig({ APP_ENV: 'production', LOG_LEVEL: level })).toThrow(
      /LOG_LEVEL/,
    );
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
