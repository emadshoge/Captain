import { describe, expect, it } from 'vitest';
import { chargeableAmount, computeFare, timeCharge } from '../src/pricing';

const plan = {
  unlockFeeSantim: 1_500,
  perMinuteSantim: 300,
  billingIncrementSeconds: 60,
  pausePerMinuteSantim: 100,
  maxPauseMinutes: 15,
};

describe('timeCharge', () => {
  it('rounds up to the billing increment', () => {
    expect(timeCharge(0, 300, 60)).toBe(0);
    expect(timeCharge(1, 300, 60)).toBe(300);
    expect(timeCharge(60, 300, 60)).toBe(300);
    expect(timeCharge(61, 300, 60)).toBe(600);
  });
  it('bills per second with santim rounding up', () => {
    expect(timeCharge(1, 300, 1)).toBe(5);
    expect(timeCharge(7, 100, 1)).toBe(12); // 11.67 → 12
    expect(timeCharge(90, 250, 30)).toBe(375);
  });
  it('rejects invalid input', () => {
    expect(() => timeCharge(-1, 300, 60)).toThrow();
    expect(() => timeCharge(1.5, 300, 60)).toThrow();
    expect(() => timeCharge(10, 300, 0)).toThrow();
    expect(() => timeCharge(10, 0.5, 60)).toThrow();
  });
});

describe('computeFare', () => {
  it('adds the unlock fee and riding time', () => {
    expect(computeFare(plan, 10 * 60 + 5, 0)).toEqual({
      unlockFeeSantim: 1_500,
      ridingSeconds: 605,
      ridingSantim: 3_300,
      pausedSeconds: 0,
      pausedSantim: 0,
      totalSantim: 4_800,
    });
  });
  it('bills pause at the pause rate up to the allowance, the rest as riding', () => {
    const fare = computeFare(plan, 40 * 60, 20 * 60);
    expect(fare.pausedSeconds).toBe(15 * 60);
    expect(fare.pausedSantim).toBe(1_500);
    expect(fare.ridingSeconds).toBe(25 * 60);
    expect(fare.ridingSantim).toBe(7_500);
    expect(fare.totalSantim).toBe(10_500);
  });
  it('treats pause as riding when the plan has no pause option', () => {
    const fare = computeFare({ ...plan, pausePerMinuteSantim: null }, 600, 300);
    expect(fare).toMatchObject({ pausedSeconds: 0, ridingSeconds: 600, totalSantim: 4_500 });
  });
  it('never bills negative or more pause than total time', () => {
    expect(computeFare(plan, -5, 0).totalSantim).toBe(1_500);
    expect(computeFare(plan, 60, 600)).toMatchObject({ pausedSeconds: 60, ridingSeconds: 0 });
  });
});

describe('chargeableAmount', () => {
  it('charges down to the floor and records the rest as unpaid', () => {
    expect(chargeableAmount(4_000, 10_000, 0)).toEqual({ chargedSantim: 4_000, unpaidSantim: 0 });
    expect(chargeableAmount(4_000, 1_000, -2_000)).toEqual({
      chargedSantim: 3_000,
      unpaidSantim: 1_000,
    });
    expect(chargeableAmount(4_000, -500, 0)).toEqual({ chargedSantim: 0, unpaidSantim: 4_000 });
  });
});
