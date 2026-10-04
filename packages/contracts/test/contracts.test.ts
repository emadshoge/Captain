import { describe, expect, it } from 'vitest';
import { ErrorResponseSchema, ReadinessResponseSchema, SantimSchema } from '../src';

describe('SantimSchema', () => {
  it('accepts integer santim amounts', () => {
    expect(SantimSchema.parse(50_000)).toBe(50_000);
  });

  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (value) => {
    expect(SantimSchema.safeParse(value).success).toBe(false);
  });
});

describe('ErrorResponseSchema', () => {
  it('requires an upper-snake-case code', () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x', requestId: 'r1' } })
        .success,
    ).toBe(true);
    expect(
      ErrorResponseSchema.safeParse({ error: { code: 'not-found', message: 'x', requestId: 'r1' } })
        .success,
    ).toBe(false);
  });
});

describe('ErrorResponseSchema requestId', () => {
  it('requires a requestId so clients can quote it to support', () => {
    expect(
      ErrorResponseSchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success,
    ).toBe(false);
  });
});

describe('ReadinessResponseSchema', () => {
  it('rejects unknown check states', () => {
    const result = ReadinessResponseSchema.safeParse({
      status: 'ready',
      checks: { database: 'maybe', migrations: 'ok' },
    });
    expect(result.success).toBe(false);
  });
});
