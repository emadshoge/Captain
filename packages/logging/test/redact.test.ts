import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  isSensitiveKey,
  redactDeep,
  redactString,
  redactUrl,
  resolveRequestId,
} from '../src';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'newPassword',
    'PASSWORD',
    'client_secret',
    'CHAPA_SECRET_KEY',
    'accessToken',
    'refresh_token',
    'EXPO_TOKEN',
    'otp',
    'otpCode',
    'OTP_CODE',
    'otp_hash',
    'verificationCode',
    'authorization',
    'cookie',
    'set-cookie',
    'apiKey',
    'x-api-key',
    'GEEZSMS_API_KEY',
    'privateKey',
    'credentials',
    'signature',
    'DATABASE_URL',
    'databaseUrl',
    'connectionString',
    'dsn',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'code',
    'message',
    'requestId',
    'status',
    'method',
    'url',
    'phoneCountry',
    'scooterCode',
  ])('keeps %s', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactString', () => {
  it('masks credentials in connection strings', () => {
    expect(redactString('connect postgres://captain:hunter2@db.internal:5432/captain failed')).toBe(
      `connect postgres://${REDACTED}@db.internal:5432/captain failed`,
    );
    expect(redactString('redis://:s3cret@cache:6379')).toBe(`redis://${REDACTED}@cache:6379`);
    expect(redactString('postgres://captain@127.0.0.1:54329/db')).toBe(
      `postgres://${REDACTED}@127.0.0.1:54329/db`,
    );
  });

  it('masks bearer tokens and key=value secrets', () => {
    expect(redactString('Authorization: Bearer abc.def-ghi')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(redactString('host=db password=hunter2 user=x')).toBe(
      `host=db password=${REDACTED} user=x`,
    );
    expect(redactString('otp: 123456')).toBe(`otp: ${REDACTED}`);
  });

  it('leaves ordinary text alone', () => {
    expect(redactString('scooter CAP-0042 unlocked at https://captain.et/rides')).toBe(
      'scooter CAP-0042 unlocked at https://captain.et/rides',
    );
  });
});

describe('redactDeep', () => {
  it('redacts nested sensitive keys and strings without mutating input', () => {
    const input = {
      user: { email: 'a@b.et', password: 'pw', profile: { otp: '123456' } },
      headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
      config: { DATABASE_URL: 'postgres://u:p@h/db', PORT: 3000 },
      list: [{ apiKey: 'k' }, 'postgres://u:p@h/db'],
    };
    const copy = structuredClone(input);
    expect(redactDeep(input)).toEqual({
      user: { email: 'a@b.et', password: REDACTED, profile: { otp: REDACTED } },
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
      config: { DATABASE_URL: REDACTED, PORT: 3000 },
      list: [{ apiKey: REDACTED }, `postgres://${REDACTED}@h/db`],
    });
    expect(input).toEqual(copy);
  });

  it('handles cycles, depth, and errors', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    expect(redactDeep(cyclic)).toEqual({ name: 'a', self: '[Circular]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain('[Truncated]');

    const error = Object.assign(new Error('auth failed for postgres://u:pw@h/db'), {
      password: 'x',
    });
    const out = redactDeep(error) as Record<string, unknown>;
    expect(out.message).toBe(`auth failed for postgres://${REDACTED}@h/db`);
    expect(out.password).toBe(REDACTED);
  });
});

describe('redactUrl', () => {
  it('masks sensitive query parameters only', () => {
    expect(redactUrl('/v1/x?token=abc&page=2&otp=1234')).toBe(
      `/v1/x?token=${REDACTED}&page=2&otp=${REDACTED}`,
    );
    expect(redactUrl('/health')).toBe('/health');
  });
});

describe('resolveRequestId', () => {
  it('accepts safe incoming IDs', () => {
    expect(resolveRequestId('abc-123_X.y:z')).toBe('abc-123_X.y:z');
    expect(resolveRequestId(['first', 'second'])).toBe('first');
  });

  it.each([undefined, '', 'has space', 'line\nbreak', 'a'.repeat(129), '<script>'])(
    'replaces unsafe or missing ID %j with a UUID',
    (incoming) => {
      expect(resolveRequestId(incoming)).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});
