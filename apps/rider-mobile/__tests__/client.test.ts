import { ApiError } from '../src/api/client';
import { fakeApi } from './fake-api';

describe('ApiClient', () => {
  it('refreshes an expired access token once for concurrent requests and retries', async () => {
    let refreshes = 0;
    const { client, calls, store } = fakeApi({
      'GET /v1/rider/wallet': (call) =>
        call.headers.authorization === 'Bearer acc-2'
          ? { body: { balanceSantim: 1 } }
          : { status: 401, body: { error: { code: 'TOKEN_EXPIRED', message: 'expired' } } },
      'POST /v1/auth/refresh': async (call) => {
        refreshes++;
        expect(call.body).toEqual({ refreshToken: 'ref-1' });
        return { body: { accessToken: 'acc-2', refreshToken: 'ref-2' } };
      },
    });
    const results = await Promise.all([client.wallet(), client.wallet(), client.wallet()]);
    expect(results.every((r) => r.balanceSantim === 1)).toBe(true);
    expect(refreshes).toBe(1);
    expect(store.current).toEqual({ accessToken: 'acc-2', refreshToken: 'ref-2' });
    expect(calls.filter((c) => c.path === '/v1/auth/refresh')).toHaveLength(1);
  });

  it('signs out locally when the refresh token is rejected', async () => {
    const signedOut = jest.fn();
    const api = fakeApi({
      'GET /v1/rider/wallet': () => ({
        status: 401,
        body: { error: { code: 'TOKEN_EXPIRED', message: 'x' } },
      }),
      'POST /v1/auth/refresh': () => ({
        status: 401,
        body: { error: { code: 'REFRESH_TOKEN_REUSED', message: 'x' } },
      }),
    });
    (api.client as unknown as { options: { onSignedOut: () => void } }).options.onSignedOut =
      signedOut;
    await expect(api.client.wallet()).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' });
    expect(api.store.current).toBeNull();
    expect(signedOut).toHaveBeenCalled();
    expect(await api.client.isSignedIn()).toBe(false);
  });

  it('sends the idempotency key and surfaces the API error envelope', async () => {
    const { client, calls } = fakeApi({
      'POST /v1/rider/rides': () => ({
        status: 409,
        body: {
          error: { code: 'BALANCE_TOO_LOW', message: 'Top up', details: { requiredSantim: 5000 } },
        },
      }),
    });
    const error = await client
      .startRide({ code: 'CAP-1' }, 'key-12345678')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'BALANCE_TOO_LOW', details: { requiredSantim: 5000 } });
    expect(calls[0]!.headers['idempotency-key']).toBe('key-12345678');
    expect(calls[0]!.headers.authorization).toBe('Bearer acc-1');
  });

  it('reports network failures without leaking details', async () => {
    const { client } = fakeApi({});
    (client as unknown as { fetchFn: () => Promise<never> }).fetchFn = () =>
      Promise.reject(new Error('ECONNREFUSED 10.0.0.1'));
    await expect(client.wallet()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('stores tokens only after a successful code verification and never sends auth for sign-in', async () => {
    const { client, calls, store } = fakeApi(
      {
        'POST /v1/auth/otp/request': () => ({
          status: 202,
          body: { challengeId: 'c1', expiresAt: '', resendAvailableAt: '' },
        }),
        'POST /v1/auth/otp/verify': () => ({ body: { accessToken: 'a', refreshToken: 'r' } }),
      },
      false,
    );
    await client.requestCode('sms', '+251911000000');
    expect(store.current).toBeNull();
    await client.verifyCode('c1', '123456');
    expect(store.current).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(calls.every((c) => c.headers.authorization === undefined)).toBe(true);
    expect(calls[1]!.body).toEqual({ challengeId: 'c1', code: '123456', client: 'mobile' });
  });
});
