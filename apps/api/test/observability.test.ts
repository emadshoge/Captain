import { ErrorResponseSchema } from '@captain/contracts';
import { loadApiConfig } from '@captain/config';
import { redactDeep } from '@captain/logging';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { AppError } from '../src/errors';

// No database is needed: these routes never touch the pool (port 1 is unreachable).
const DB_URL = 'postgres://captain:db-pass-123@127.0.0.1:1/none';

const SECRETS = {
  password: 'body-password-555',
  otp: '424242',
  bearer: 'bearer-token-abc',
  cookie: 'session-cookie-xyz',
  queryToken: 'query-token-999',
};

async function setup() {
  const lines: string[] = [];
  const config = loadApiConfig({ APP_ENV: 'test', LOG_LEVEL: 'trace', DATABASE_URL: DB_URL });
  const app = await buildApp({
    config,
    logDestination: { write: (line: string) => void lines.push(line) },
  });

  // Test-only routes exercising error paths and request bodies.
  app.get('/test/boom', async () => {
    throw new Error(`query failed: password=${SECRETS.password} at ${DB_URL}`);
  });
  app.get('/test/app-error', async () => {
    throw new AppError(409, 'SCOOTER_UNAVAILABLE', 'This scooter is not available.', {
      scooter: 'CAP-1',
    });
  });
  app.post(
    '/test/echo',
    {
      schema: {
        body: z.object({ name: z.string().min(1), password: z.string(), otp: z.string() }),
      },
    },
    async () => ({ ok: true }),
  );
  return { app, lines, logs: () => lines.join('') };
}

let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const expectNoSecrets = (text: string) => {
  for (const secret of [...Object.values(SECRETS), 'db-pass-123'])
    expect(text).not.toContain(secret);
};

describe('request IDs', () => {
  it('generates an ID, returns it in the header and logs it on every request line', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const requestLines = current.lines.map((l) => JSON.parse(l)).filter((e) => e.req || e.res);
    expect(requestLines.length).toBeGreaterThanOrEqual(2);
    for (const entry of requestLines) expect(entry.requestId).toBe(id);
  });

  it('propagates a safe incoming x-request-id', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'edge-abc.123' },
    });
    expect(res.headers['x-request-id']).toBe('edge-abc.123');
  });

  it('replaces an unsafe incoming x-request-id (log injection)', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'evil" injected {json}' },
    });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(current.logs()).not.toContain('injected');
  });

  it('includes the request ID in error bodies', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/nope' });
    const body = ErrorResponseSchema.parse(res.json());
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('error responses', () => {
  it('returns a generic 500 without internal details and logs the redacted cause', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(res.body).not.toContain('query failed');
    const errorLine = current.lines
      .map((l) => JSON.parse(l))
      .find((e) => e.msg === 'unhandled error');
    expect(errorLine?.err?.message).toContain('query failed');
    expect(errorLine?.requestId).toBe(res.headers['x-request-id']);
    expectNoSecrets(current.logs());
  });

  it('returns AppError code, message and details', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/test/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'SCOOTER_UNAVAILABLE',
      message: 'This scooter is not available.',
      details: { scooter: 'CAP-1' },
    });
  });

  it('returns 404 NOT_FOUND for unknown routes', async () => {
    current = await setup();
    const res = await current.app.inject({ method: 'GET', url: '/v1/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 400 VALIDATION_FAILED with paths only, never submitted values', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: '/test/echo',
      payload: { name: 12345678, password: SECRETS.password, otp: 99 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      '/name',
      '/otp',
    ]);
    expect(res.body).not.toContain('12345678');
    expectNoSecrets(res.body + current.logs());
  });

  it('maps malformed JSON to 400 BAD_REQUEST and oversized bodies to 413', async () => {
    current = await setup();
    const bad = await current.app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: `{"password":"${SECRETS.password}",`,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The request could not be processed.',
    });
    expect(bad.body).not.toContain(SECRETS.password);

    const big = await current.app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024), password: 'p', otp: 'o' }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('PAYLOAD_TOO_LARGE');

    const media = await current.app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(media.statusCode).toBe(415);
    expect(media.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expectNoSecrets(current.logs());
  });
});

describe('log redaction', () => {
  it('never logs request bodies, auth headers, cookies or sensitive query values', async () => {
    current = await setup();
    const res = await current.app.inject({
      method: 'POST',
      url: `/test/echo?token=${SECRETS.queryToken}&page=2`,
      headers: { authorization: `Bearer ${SECRETS.bearer}`, cookie: `sid=${SECRETS.cookie}` },
      payload: { name: 'Abebe', password: SECRETS.password, otp: SECRETS.otp },
    });
    expect(res.statusCode).toBe(200);
    const logs = current.logs();
    expectNoSecrets(logs);
    expect(logs).not.toContain('Abebe'); // body not logged at all
    expect(logs).toContain('page=2');
  });

  it('redacts the database connection string in the startup config summary', () => {
    const config = loadApiConfig({ APP_ENV: 'test', DATABASE_URL: DB_URL });
    const summary = JSON.stringify(redactDeep(config));
    expect(summary).not.toContain('db-pass-123');
    expect(summary).toContain('"DATABASE_URL":"[REDACTED]"');
    expect(summary).toContain('"APP_ENV":"test"');
    // Provider selections are operational settings, not secrets.
    expect(summary).toContain('"OTP_SMS_PROVIDER":"none"');
  });
});
