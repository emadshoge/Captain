'use client';

import type {
  CurrentRideSchema,
  RideSchema,
  ScooterLookupSchema,
  PricingSummarySchema,
  TopUpSchema,
  WalletSchema,
  WalletTransactionSchema,
} from '@captain/contracts';
import type { z } from 'zod';

export type Ride = z.infer<typeof RideSchema>;
export type Wallet = z.infer<typeof WalletSchema>;
export type WalletTransaction = z.infer<typeof WalletTransactionSchema>;
export type TopUp = z.infer<typeof TopUpSchema>;
export type ScooterLookup = z.infer<typeof ScooterLookupSchema>;
export type Pricing = z.infer<typeof PricingSummarySchema>;

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * Browser API client. Sessions live in HttpOnly SameSite=Strict cookies set
 * by the API (JavaScript never sees the tokens). Unsafe requests carry the
 * session-bound CSRF token, fetched from /v1/auth/session and kept only in
 * memory. An expired access cookie is refreshed once (shared by concurrent
 * requests).
 */
class WebApi {
  private csrf: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  setCsrf(token: string | null) {
    this.csrf = token;
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    try {
      return await fetch(`${API_URL}${path}`, {
        method,
        credentials: 'include',
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method !== 'GET' && this.csrf ? { 'x-csrf-token': this.csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach Captain. Check your connection.');
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const e = (
        json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      )?.error;
      throw new ApiError(
        response.status,
        e?.code ?? 'HTTP_ERROR',
        e?.message ?? 'Something went wrong.',
        e?.details,
      );
    }
    return json as T;
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const response = await this.send('POST', '/v1/auth/refresh', {});
        if (!response.ok) return false;
        await this.loadSession();
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = opts.idempotencyKey
      ? { 'idempotency-key': opts.idempotencyKey }
      : {};
    let response = await this.send(method, path, body, headers);
    if (response.status === 401 && !path.startsWith('/v1/auth/')) {
      if (await this.refresh()) response = await this.send(method, path, body, headers);
    }
    return this.parse<T>(response);
  }

  /** Returns the signed-in rider (and caches the CSRF token), or null. */
  async loadSession(): Promise<{ riderId: string } | null> {
    const response = await this.send('GET', '/v1/auth/session');
    if (response.status === 401) {
      this.csrf = null;
      return null;
    }
    const session = await this.parse<{ type: string; riderId?: string; csrfToken: string }>(
      response,
    );
    this.csrf = session.csrfToken;
    return session.type === 'rider' && session.riderId ? { riderId: session.riderId } : null;
  }

  async currentSession(): Promise<{ riderId: string } | null> {
    const session = await this.loadSession();
    if (session) return session;
    return (await this.refresh()) ? this.loadSession() : null;
  }

  requestCode = (channel: 'sms' | 'email', destination: string) =>
    this.request<{ challengeId: string }>('POST', '/v1/auth/otp/request', {
      audience: 'rider',
      channel,
      destination,
    });

  async verifyCode(challengeId: string, code: string) {
    const session = await this.request<{ csrfToken?: string }>('POST', '/v1/auth/otp/verify', {
      challengeId,
      code,
      client: 'web',
    });
    this.csrf = session.csrfToken ?? null;
  }

  async signOut() {
    try {
      await this.request('POST', '/v1/auth/logout', {});
    } finally {
      this.csrf = null;
    }
  }

  pricing = () => this.request<Pricing>('GET', '/v1/rider/pricing');
  lookup = (code: string) =>
    this.request<ScooterLookup>(
      'GET',
      `/v1/rider/scooters/lookup?code=${encodeURIComponent(code)}`,
    );
  startRide = (code: string, idempotencyKey: string) =>
    this.request<Ride>('POST', '/v1/rider/rides', { code }, { idempotencyKey });
  currentRide = () =>
    this.request<z.infer<typeof CurrentRideSchema>>('GET', '/v1/rider/rides/current');
  ride = (id: string) => this.request<Ride>('GET', `/v1/rider/rides/${id}`);
  rides = () => this.request<Ride[]>('GET', '/v1/rider/rides');
  pause = (id: string) => this.request<Ride>('POST', `/v1/rider/rides/${id}/pause`, {});
  resume = (id: string) => this.request<Ride>('POST', `/v1/rider/rides/${id}/resume`, {});
  endRide = (id: string, location: { lat: number; lng: number } | null) =>
    this.request<Ride>('POST', `/v1/rider/rides/${id}/end`, location ?? {});
  wallet = () => this.request<Wallet>('GET', '/v1/rider/wallet');
  transactions = () => this.request<WalletTransaction[]>('GET', '/v1/rider/wallet/transactions');
  createTopUp = (amountSantim: number, idempotencyKey: string) =>
    this.request<TopUp>('POST', '/v1/rider/wallet/topups', { amountSantim }, { idempotencyKey });
  topUp = (id: string) => this.request<TopUp>('GET', `/v1/rider/wallet/topups/${id}`);
  checkTopUp = (id: string) =>
    this.request<TopUp>('POST', `/v1/rider/wallet/topups/${id}/check`, {});
}

export const api = new WebApi();

export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `w-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const MESSAGES: Record<string, string> = {
  BALANCE_TOO_LOW: 'Your balance is too low. Top up your wallet to ride.',
  INSUFFICIENT_FUNDS: 'Your balance is too low. Top up your wallet to ride.',
  SCOOTER_UNAVAILABLE: 'This scooter cannot be rented right now.',
  SCOOTER_NOT_FOUND: 'We could not find that scooter. Check the code.',
  RIDE_ALREADY_ACTIVE: 'You already have a ride in progress.',
  SCOOTER_NOT_STATIONARY: 'Stop the scooter completely, then end the ride.',
  PARKING_NOT_ALLOWED: 'You cannot park here. Move to an allowed area and try again.',
  PRICING_NOT_CONFIGURED: 'This service is not available yet.',
  PAYMENTS_UNAVAILABLE: 'Top-ups are not available right now.',
  TOPUP_BELOW_MINIMUM: 'The minimum top-up is ETB 500.00.',
  OTP_INVALID: 'That code is not correct.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment.',
  NETWORK_ERROR: 'Cannot reach Captain. Check your connection.',
};

export function messageFor(error: unknown): string {
  if (error instanceof ApiError)
    return MESSAGES[error.code] ?? error.message ?? 'Something went wrong.';
  return 'Something went wrong. Please try again.';
}
