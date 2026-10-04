import type { Ride, RideStatus } from '../api/types';
import type { MessageKey } from '../i18n';

export type RideAction = 'pause' | 'resume' | 'end';

/** What the rider can do in each state (the server re-checks every action). */
export function availableActions(ride: Pick<Ride, 'status' | 'pricing'>): RideAction[] {
  switch (ride.status) {
    case 'active':
      return ride.pricing.pausePerMinuteSantim === null ? ['end'] : ['pause', 'end'];
    case 'paused':
      return ['resume', 'end'];
    default:
      return [];
  }
}

/** Plain-language status line for the rider. */
export function statusMessage(status: RideStatus): MessageKey {
  const map: Record<RideStatus, MessageKey> = {
    start_requested: 'ride.status.unlocking',
    unlock_pending: 'ride.status.unlocking',
    active: 'ride.status.active',
    paused: 'ride.status.paused',
    end_requested: 'ride.status.ending',
    completion_pending: 'ride.status.ending',
    completed: 'ride.status.completed',
    start_failed: 'ride.status.startFailed',
    operator_review: 'ride.status.review',
  };
  return map[status];
}

/** States in which the app keeps polling the server for changes. */
export function shouldPoll(status: RideStatus): boolean {
  return [
    'start_requested',
    'unlock_pending',
    'end_requested',
    'completion_pending',
    'active',
    'paused',
  ].includes(status);
}

/** Seconds ridden so far (server timestamps; display only — the server bills). */
export function elapsedSeconds(
  ride: Pick<Ride, 'startedAt' | 'endRequestedAt'>,
  now: Date,
): number {
  if (!ride.startedAt) return 0;
  const end = ride.endRequestedAt ? new Date(ride.endRequestedAt) : now;
  return Math.max(0, Math.floor((end.getTime() - new Date(ride.startedAt).getTime()) / 1000));
}

/** Maps API error codes to rider-facing messages. */
export function errorMessage(code: string, details?: Record<string, unknown>): MessageKey {
  switch (code) {
    case 'BALANCE_TOO_LOW':
    case 'INSUFFICIENT_FUNDS':
      return 'error.balanceTooLow';
    case 'SCOOTER_UNAVAILABLE':
      return details?.reason === 'reserved' ? 'error.scooterReserved' : 'error.scooterUnavailable';
    case 'SCOOTER_NOT_FOUND':
      return 'error.scooterNotFound';
    case 'RIDE_ALREADY_ACTIVE':
      return 'error.rideActive';
    case 'SCOOTER_NOT_STATIONARY':
      return 'error.notStationary';
    case 'PARKING_NOT_ALLOWED':
      return 'error.parking';
    case 'PRICING_NOT_CONFIGURED':
    case 'PAYMENTS_UNAVAILABLE':
      return 'error.serviceUnavailable';
    case 'TOPUP_BELOW_MINIMUM':
      return 'error.topupMinimum';
    case 'NETWORK_ERROR':
      return 'error.network';
    case 'RATE_LIMITED':
      return 'error.rateLimited';
    default:
      return 'error.generic';
  }
}
