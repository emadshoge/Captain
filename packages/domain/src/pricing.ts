import { assertSantim } from './money';

/**
 * The pricing numbers a ride is billed with, copied from the active pricing
 * plan when the ride starts (the ride never changes plan afterwards).
 * Production values are unresolved business decisions (D-PRICE, D-ROUND,
 * D-PAUSE, D-MINBAL); development uses labelled fixtures.
 */
export interface PricingSnapshot {
  planId: string;
  name: string;
  isDevFixture: boolean;
  currency: 'ETB';
  unlockFeeSantim: number;
  perMinuteSantim: number;
  /** 60 = per started minute, 1 = per second. */
  billingIncrementSeconds: number;
  /** null = pausing not offered. */
  pausePerMinuteSantim: number | null;
  maxPauseMinutes: number | null;
  minStartBalanceSantim: number;
  holdAmountSantim: number;
  reservationMinutes: number | null;
  reservationFeeSantim: number | null;
  maxRideMinutes: number | null;
  /** Lowest balance a ride charge may take the wallet to (<= 0). */
  lowBalanceFloorSantim: number;
}

export interface FareBreakdown {
  unlockFeeSantim: number;
  /** Seconds billed at the riding rate (includes pause beyond the allowance). */
  ridingSeconds: number;
  ridingSantim: number;
  /** Seconds billed at the pause rate. */
  pausedSeconds: number;
  pausedSantim: number;
  totalSantim: number;
}

/**
 * Charge for `seconds` at `perMinuteSantim`, rounded UP to the billing
 * increment and then up to a whole santim. Integer arithmetic only.
 */
export function timeCharge(
  seconds: number,
  perMinuteSantim: number,
  incrementSeconds: number,
): number {
  if (!Number.isInteger(seconds) || seconds < 0)
    throw new RangeError('seconds must be a non-negative integer');
  if (!Number.isInteger(incrementSeconds) || incrementSeconds < 1)
    throw new RangeError('invalid billing increment');
  assertSantim(perMinuteSantim, 'per-minute price');
  if (seconds === 0 || perMinuteSantim === 0) return 0;
  const billedSeconds = Math.ceil(seconds / incrementSeconds) * incrementSeconds;
  return assertSantim(Math.ceil((billedSeconds * perMinuteSantim) / 60), 'time charge');
}

/**
 * Fare for a ride of `totalSeconds` (unlock confirmation → billing cutoff),
 * of which `pausedSeconds` were paused. Pause time beyond the plan's pause
 * allowance is billed at the riding rate; if the plan offers no pausing, all
 * time is riding time.
 */
export function computeFare(
  snapshot: Pick<
    PricingSnapshot,
    | 'unlockFeeSantim'
    | 'perMinuteSantim'
    | 'billingIncrementSeconds'
    | 'pausePerMinuteSantim'
    | 'maxPauseMinutes'
  >,
  totalSeconds: number,
  pausedSeconds: number,
): FareBreakdown {
  const total = Math.max(0, Math.floor(totalSeconds));
  let paused = Math.min(Math.max(0, Math.floor(pausedSeconds)), total);
  if (snapshot.pausePerMinuteSantim === null) paused = 0;
  else if (snapshot.maxPauseMinutes !== null)
    paused = Math.min(paused, snapshot.maxPauseMinutes * 60);
  const riding = total - paused;
  const ridingSantim = timeCharge(
    riding,
    snapshot.perMinuteSantim,
    snapshot.billingIncrementSeconds,
  );
  const pausedSantim =
    snapshot.pausePerMinuteSantim === null
      ? 0
      : timeCharge(paused, snapshot.pausePerMinuteSantim, snapshot.billingIncrementSeconds);
  return {
    unlockFeeSantim: snapshot.unlockFeeSantim,
    ridingSeconds: riding,
    ridingSantim,
    pausedSeconds: paused,
    pausedSantim,
    totalSantim: assertSantim(snapshot.unlockFeeSantim + ridingSantim + pausedSantim, 'fare'),
  };
}

/**
 * How much of a fare can be charged without taking the wallet below the
 * plan's floor. The remainder is recorded as unpaid (D-UNPAID); it never
 * triggers any device action.
 */
export function chargeableAmount(fareSantim: number, balanceSantim: number, floorSantim: number) {
  const capacity = Math.max(0, balanceSantim - Math.min(0, floorSantim));
  const charged = Math.min(fareSantim, capacity);
  return { chargedSantim: charged, unpaidSantim: fareSantim - charged };
}
