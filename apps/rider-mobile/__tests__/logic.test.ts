import { newIdempotencyKey } from '../src/api/client';
import {
  formatDistance,
  formatDuration,
  formatEtb,
  parseEtbInput,
  parseScooterQr,
} from '../src/format';
import { setLocale, t } from '../src/i18n';
import {
  availableActions,
  elapsedSeconds,
  errorMessage,
  shouldPoll,
  statusMessage,
} from '../src/ride/model';
import { pricing } from './fake-api';

describe('money and formatting', () => {
  it('formats santim without floating point', () => {
    expect(formatEtb(0)).toBe('ETB 0.00');
    expect(formatEtb(50_000)).toBe('ETB 500.00');
    expect(formatEtb(123_456_789)).toBe('ETB 1,234,567.89');
    expect(formatEtb(-2_005)).toBe('−ETB 20.05');
  });
  it('parses ETB input strictly', () => {
    expect(parseEtbInput('500')).toBe(50_000);
    expect(parseEtbInput('1,250.5')).toBe(125_050);
    expect(parseEtbInput('0.07')).toBe(7);
    for (const bad of ['', 'abc', '1.234', '-5', '1e3']) expect(parseEtbInput(bad)).toBeNull();
  });
  it('formats durations and distances', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3_725)).toBe('1:02:05');
    expect(formatDistance(120.4)).toBe('120 m');
    expect(formatDistance(1_460)).toBe('1.5 km');
  });
  it('accepts a bare QR token or a link ending in it', () => {
    expect(parseScooterQr('abcDEF123_-xyz')).toBe('abcDEF123_-xyz');
    expect(parseScooterQr('https://captain.et/s/abcDEF123xyz')).toBe('abcDEF123xyz');
    expect(parseScooterQr('hi')).toBeNull();
    expect(parseScooterQr('javascript:alert(1)')).toBeNull();
    expect(parseScooterQr('captain://x/abcDEF123xyz')).toBeNull();
  });
  it('makes valid, distinct idempotency keys', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe('ride model', () => {
  it('offers actions per state and pause only when the plan allows it', () => {
    expect(availableActions({ status: 'active', pricing })).toEqual(['pause', 'end']);
    expect(
      availableActions({ status: 'active', pricing: { ...pricing, pausePerMinuteSantim: null } }),
    ).toEqual(['end']);
    expect(availableActions({ status: 'paused', pricing })).toEqual(['resume', 'end']);
    for (const status of [
      'unlock_pending',
      'completion_pending',
      'operator_review',
      'completed',
      'start_failed',
    ] as const) {
      expect(availableActions({ status, pricing })).toEqual([]);
    }
  });
  it('has a message for every status and polls only open rides', () => {
    expect(t(statusMessage('start_failed'))).toContain('not charged');
    expect(shouldPoll('unlock_pending')).toBe(true);
    expect(shouldPoll('completed')).toBe(false);
    expect(shouldPoll('operator_review')).toBe(false);
  });
  it('counts elapsed time from the unlock until the end request', () => {
    const r = { startedAt: '2026-10-04T10:00:00Z', endRequestedAt: null };
    expect(elapsedSeconds(r, new Date('2026-10-04T10:01:30Z'))).toBe(90);
    expect(
      elapsedSeconds(
        { ...r, endRequestedAt: '2026-10-04T10:00:40Z' },
        new Date('2026-10-04T11:00:00Z'),
      ),
    ).toBe(40);
    expect(elapsedSeconds({ startedAt: null, endRequestedAt: null }, new Date())).toBe(0);
  });
  it('maps API errors to rider messages', () => {
    expect(errorMessage('SCOOTER_UNAVAILABLE', { reason: 'reserved' })).toBe(
      'error.scooterReserved',
    );
    expect(errorMessage('SCOOTER_NOT_STATIONARY')).toBe('error.notStationary');
    expect(errorMessage('SOMETHING_NEW')).toBe('error.generic');
  });
});

describe('i18n', () => {
  it('fills placeholders and falls back to English for untranslated locales', () => {
    setLocale('am-ET');
    expect(t('wallet.minimum', { amount: 'ETB 500.00' })).toBe('Minimum top-up is ETB 500.00.');
    setLocale('en');
  });
});
