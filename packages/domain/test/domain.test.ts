import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  addSantim,
  elapsedSeconds,
  formatEthiopiaDateTime,
  formatSantim,
  multiplySantim,
  parseEtb,
} from '../src';

describe('parseEtb', () => {
  it.each([
    ['500', 50_000],
    ['500.5', 50_050],
    ['500.05', 50_005],
    ['1,250.00', 125_000],
    [' 0.01 ', 1],
  ])('%s -> %d santim', (input, expected) => {
    expect(parseEtb(input)).toBe(expected);
  });

  it.each(['', '-5', '1.234', 'abc', '1e3', '1.', '.5', '12345678901234'])(
    'rejects %j',
    (input) => {
      expect(() => parseEtb(input)).toThrow(MoneyError);
    },
  );
});

describe('formatSantim', () => {
  it.each([
    [0, '0.00 ETB'],
    [5, '0.05 ETB'],
    [50_000, '500.00 ETB'],
    [123_456_789, '1,234,567.89 ETB'],
    [-1_050, '-10.50 ETB'],
  ])('%d -> %s', (santim, expected) => {
    expect(formatSantim(santim)).toBe(expected);
  });

  it('rejects fractional santim', () => {
    expect(() => formatSantim(1.5)).toThrow(MoneyError);
  });
});

describe('integer arithmetic', () => {
  it('adds and multiplies without floats', () => {
    expect(addSantim(1_000, 300, -50)).toBe(1_250);
    expect(multiplySantim(350, 7)).toBe(2_450);
    expect(() => multiplySantim(350, 1.5)).toThrow(MoneyError);
    expect(() => addSantim(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
  });
});

describe('time', () => {
  it('formats in East Africa Time (UTC+3)', () => {
    expect(formatEthiopiaDateTime(new Date('2026-10-04T14:05:00Z'))).toBe('04/10/2026, 17:05');
  });

  it('computes non-negative elapsed seconds', () => {
    expect(
      elapsedSeconds(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:01:30.900Z')),
    ).toBe(90);
    expect(elapsedSeconds(new Date('2026-01-01T00:01:00Z'), new Date('2026-01-01T00:00:00Z'))).toBe(
      0,
    );
  });
});
