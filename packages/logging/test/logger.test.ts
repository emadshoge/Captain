import { describe, expect, it } from 'vitest';
import { REDACTED } from '../src';
import { captureLogger } from './capture';

describe('createLogger', () => {
  it('writes structured JSON with service, env, level label and ISO time', () => {
    const { logger, entries } = captureLogger({ service: 'captain-api', appEnv: 'development' });
    logger.info({ scooterCode: 'CAP-1' }, 'hello');
    const [entry] = entries();
    expect(entry).toMatchObject({
      level: 'info',
      service: 'captain-api',
      env: 'development',
      msg: 'hello',
      scooterCode: 'CAP-1',
    });
    expect(String(entry?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts secrets in merged objects, messages, child bindings and errors', () => {
    const { logger, text } = captureLogger();
    const child = logger.child({ apiKey: 'child-binding-secret' });
    child.info(
      { password: 'pw-123', nested: { otp: '987654' }, DATABASE_URL: 'postgres://u:dbpass@h/db' },
      'merged',
    );
    logger.warn('connect to postgres://captain:msgpass@db/captain failed, token=tok-777');
    logger.error(
      { err: new Error('pg: password authentication failed for postgres://u:errpass@h/db') },
      'boom',
    );

    const output = text();
    for (const secret of [
      'child-binding-secret',
      'pw-123',
      '987654',
      'dbpass',
      'msgpass',
      'tok-777',
      'errpass',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain(REDACTED);
  });

  it('redacts headers when a whole request-like object is logged', () => {
    const { logger, entries } = captureLogger();
    logger.info(
      { headers: { authorization: 'Bearer abc', cookie: 'sid=1', accept: '*/*' } },
      'headers',
    );
    expect(entries()[0]?.headers).toEqual({
      authorization: REDACTED,
      cookie: REDACTED,
      accept: '*/*',
    });
  });

  it('respects the configured level', () => {
    const { logger, lines } = captureLogger({ level: 'warn' });
    logger.info('hidden');
    logger.warn('shown');
    expect(lines).toHaveLength(1);
  });
});
