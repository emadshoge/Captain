import { ApiClient } from '../src/api/client';
import { memoryTokenStore } from '../src/session/secure-store';

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (
  call: Call,
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/** A scripted API: routes "METHOD /path" (query string ignored) to handlers. */
export function fakeApi(routes: Record<string, Handler>, signedIn = true) {
  const calls: Call[] = [];
  const store = memoryTokenStore(signedIn ? { accessToken: 'acc-1', refreshToken: 'ref-1' } : null);
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.test', '');
    const call: Call = {
      method: init.method ?? 'GET',
      path,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${path.split('?')[0]}`];
    const result = handler
      ? await handler(call)
      : { status: 404, body: { error: { code: 'NOT_FOUND', message: 'nope' } } };
    return new Response(result.body === undefined ? '' : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new ApiClient({ baseUrl: 'https://api.test', store, fetch });
  return { client, calls, store };
}

export const pricing = {
  planId: '00000000-0000-4000-8000-000000000001',
  name: 'Test',
  isDevFixture: true,
  currency: 'ETB' as const,
  unlockFeeSantim: 1500,
  perMinuteSantim: 300,
  billingIncrementSeconds: 60,
  pausePerMinuteSantim: 100,
  maxPauseMinutes: 15,
  minStartBalanceSantim: 5000,
  holdAmountSantim: 0,
  reservationMinutes: null,
  reservationFeeSantim: null,
  maxRideMinutes: 180,
  lowBalanceFloorSantim: 0,
};

export function ride(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    status: 'active',
    scooterId: '00000000-0000-4000-8000-0000000000bb',
    scooterCode: 'CAP-001',
    isSimulated: true,
    requestedAt: '2026-10-04T10:00:00.000Z',
    startedAt: '2026-10-04T10:00:05.000Z',
    endRequestedAt: null,
    completedAt: null,
    billingCutoffAt: null,
    pausedSince: null,
    pausedSeconds: 0,
    parkingStatus: 'not_checked',
    fare: {
      unlockFeeSantim: 1500,
      ridingSeconds: 300,
      ridingSantim: 1500,
      pausedSeconds: 0,
      pausedSantim: 0,
      totalSantim: 3000,
    },
    fareIsEstimate: true,
    chargedSantim: null,
    unpaidSantim: null,
    failureReason: null,
    pricing,
    ...overrides,
  };
}
