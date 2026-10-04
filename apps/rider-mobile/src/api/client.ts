import type {
  CurrentRide,
  NearbyScooter,
  OtpChallenge,
  Pricing,
  Ride,
  RiderProfile,
  ScooterLookup,
  Session,
  TopUp,
  Wallet,
  WalletTransaction,
} from './types';

/** Error returned by the API's stable error envelope (or a network failure). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Where tokens live. The app uses the OS keychain/keystore (SecureStore). */
export interface TokenStore {
  load(): Promise<Tokens | null>;
  save(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  store: TokenStore;
  fetch?: FetchLike;
  /** Called when the session can no longer be refreshed (user must sign in again). */
  onSignedOut?: () => void;
}

/** A fresh Idempotency-Key for one user action (reuse it when retrying that action). */
export function newIdempotencyKey(): string {
  const random = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
  return `m-${Date.now().toString(36)}-${random}`.slice(0, 100);
}

export class ApiClient {
  private tokens: Tokens | null = null;
  private loaded = false;
  private refreshing: Promise<boolean> | null = null;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: ClientOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async isSignedIn(): Promise<boolean> {
    await this.ensureLoaded();
    return this.tokens !== null;
  }

  private async ensureLoaded() {
    if (!this.loaded) {
      this.tokens = await this.options.store.load();
      this.loaded = true;
    }
  }

  private async raw(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchFn(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach Captain. Check your connection.');
    }
  }

  private static async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok) {
      const error = (
        json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      )?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'HTTP_ERROR',
        error?.message ?? 'Something went wrong.',
        error?.details,
      );
    }
    return json as T;
  }

  /**
   * Authenticated request. An expired access token is refreshed once
   * (refresh tokens rotate; concurrent requests share one refresh).
   */
  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string; auth?: boolean } = {},
  ): Promise<T> {
    await this.ensureLoaded();
    const headers = (): Record<string, string> => ({
      ...(opts.auth !== false && this.tokens
        ? { authorization: `Bearer ${this.tokens.accessToken}` }
        : {}),
      ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
    });
    let response = await this.raw(method, path, body, headers());
    if (response.status === 401 && opts.auth !== false && this.tokens) {
      if (await this.refresh()) response = await this.raw(method, path, body, headers());
    }
    return ApiClient.parse<T>(response);
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const current = this.tokens;
        if (!current) return false;
        const response = await this.raw(
          'POST',
          '/v1/auth/refresh',
          { refreshToken: current.refreshToken },
          {},
        );
        if (!response.ok) {
          await this.signOutLocally();
          return false;
        }
        const session = (await response.json()) as Session;
        if (!session.accessToken || !session.refreshToken) {
          await this.signOutLocally();
          return false;
        }
        await this.setTokens({
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
        });
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async setTokens(tokens: Tokens) {
    this.tokens = tokens;
    await this.options.store.save(tokens);
  }

  private async signOutLocally() {
    this.tokens = null;
    await this.options.store.clear();
    this.options.onSignedOut?.();
  }

  // --- Auth -----------------------------------------------------------------

  requestCode(channel: 'sms' | 'email', destination: string) {
    return this.request<OtpChallenge>(
      'POST',
      '/v1/auth/otp/request',
      { audience: 'rider', channel, destination },
      { auth: false },
    );
  }

  async verifyCode(challengeId: string, code: string) {
    const session = await this.request<Session>(
      'POST',
      '/v1/auth/otp/verify',
      { challengeId, code, client: 'mobile' },
      { auth: false },
    );
    if (!session.accessToken || !session.refreshToken) {
      throw new ApiError(500, 'NO_TOKENS', 'Sign-in failed. Please try again.');
    }
    await this.setTokens({ accessToken: session.accessToken, refreshToken: session.refreshToken });
    return session;
  }

  async signOut() {
    try {
      if (this.tokens) await this.request('POST', '/v1/auth/logout', {});
    } catch {
      // Signing out locally must work offline too.
    }
    await this.signOutLocally();
  }

  // --- Rider ----------------------------------------------------------------

  me = () => this.request<RiderProfile>('GET', '/v1/rider/me');
  pricing = () => this.request<Pricing>('GET', '/v1/rider/pricing');
  nearby = (lat: number, lng: number) =>
    this.request<NearbyScooter[]>('GET', `/v1/rider/scooters/nearby?lat=${lat}&lng=${lng}`);
  lookup = (by: { code: string } | { qr: string }) =>
    this.request<ScooterLookup>(
      'GET',
      `/v1/rider/scooters/lookup?${'code' in by ? `code=${encodeURIComponent(by.code)}` : `qr=${encodeURIComponent(by.qr)}`}`,
    );

  startRide = (by: { code: string } | { qr: string }, idempotencyKey: string) =>
    this.request<Ride>('POST', '/v1/rider/rides', by, { idempotencyKey });
  currentRide = () => this.request<CurrentRide>('GET', '/v1/rider/rides/current');
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
  /** Asks the server to verify with the provider. Never credits on its own. */
  checkTopUp = (id: string) =>
    this.request<TopUp>('POST', `/v1/rider/wallet/topups/${id}/check`, {});
}
