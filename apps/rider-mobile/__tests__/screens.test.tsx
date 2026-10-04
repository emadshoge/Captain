import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { RideCard } from '../src/ride/RideCard';
import { Receipt } from '../src/screens/HistoryScreens';
import { ScanScreen } from '../src/screens/ScanScreen';
import { SignInScreen } from '../src/screens/SignInScreen';
import { WalletScreen } from '../src/screens/WalletScreen';
import { SessionProvider } from '../src/session/SessionContext';
import { memoryTokenStore } from '../src/session/secure-store';
import { fakeApi, pricing, ride } from './fake-api';

jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false }, jest.fn()],
}));

function withSession(client: ReturnType<typeof fakeApi>['client'], children: ReactNode) {
  return (
    <SessionProvider baseUrl="https://api.test" store={memoryTokenStore()} client={client}>
      {children}
    </SessionProvider>
  );
}

describe('RideCard', () => {
  it('shows the running estimate, SIMULATED and test-pricing labels, and the allowed actions', () => {
    const onAction = jest.fn();
    render(
      <RideCard
        ride={ride() as never}
        onAction={onAction}
        now={() => new Date('2026-10-04T10:05:05Z')}
      />,
    );
    expect(screen.getByText('Ride in progress')).toBeTruthy();
    expect(screen.getByText('SIMULATED')).toBeTruthy();
    expect(screen.getByText('Test pricing — not real prices')).toBeTruthy();
    expect(screen.getByText('ETB 30.00')).toBeTruthy();
    expect(screen.getByText('5:00')).toBeTruthy();
    fireEvent.press(screen.getByTestId('ride-end'));
    expect(onAction).toHaveBeenCalledWith('end');
    expect(screen.getByTestId('ride-pause')).toBeTruthy();
  });

  it('offers no actions while the unlock is pending and tells a failed start was not charged', () => {
    const { rerender } = render(
      <RideCard
        ride={ride({ status: 'unlock_pending', startedAt: null, fare: null }) as never}
        onAction={jest.fn()}
      />,
    );
    expect(screen.getByText('Unlocking the scooter…')).toBeTruthy();
    expect(screen.queryByTestId('ride-end')).toBeNull();
    rerender(
      <RideCard
        ride={ride({ status: 'start_failed', startedAt: null, fare: null }) as never}
        onAction={jest.fn()}
      />,
    );
    expect(screen.getByText('The scooter did not unlock. You were not charged.')).toBeTruthy();
  });
});

describe('Receipt', () => {
  it('itemises the fare and shows unpaid amounts', () => {
    render(
      <Receipt
        ride={
          ride({
            status: 'completed',
            fareIsEstimate: false,
            fare: {
              unlockFeeSantim: 1500,
              ridingSeconds: 605,
              ridingSantim: 3300,
              pausedSeconds: 120,
              pausedSantim: 200,
              totalSantim: 5000,
            },
            chargedSantim: 4000,
            unpaidSantim: 1000,
          }) as never
        }
      />,
    );
    expect(screen.getByText('Riding (11 min)')).toBeTruthy();
    expect(screen.getByText('Paused (2 min)')).toBeTruthy();
    expect(screen.getByText('ETB 50.00')).toBeTruthy();
    expect(screen.getByText('ETB 40.00')).toBeTruthy();
    expect(screen.getByText('Unpaid balance')).toBeTruthy();
  });
});

describe('SignInScreen', () => {
  it('requests a code, verifies it and stores the session', async () => {
    const api = fakeApi(
      {
        'POST /v1/auth/otp/request': () => ({
          status: 202,
          body: { challengeId: 'c-1', expiresAt: '', resendAvailableAt: '' },
        }),
        'POST /v1/auth/otp/verify': (call) =>
          (call.body as { code: string }).code === '123456'
            ? { body: { accessToken: 'a', refreshToken: 'r' } }
            : { status: 400, body: { error: { code: 'OTP_INVALID', message: 'bad' } } },
      },
      false,
    );
    const onSignedIn = jest.fn();
    render(withSession(api.client, <SignInScreen onSignedIn={onSignedIn} />));
    fireEvent.changeText(screen.getByTestId('destination'), '+251911223344');
    fireEvent.press(screen.getByTestId('send-code'));
    await screen.findByText('We sent a 6-digit code to +251911223344.');
    fireEvent.changeText(screen.getByTestId('code'), '12-34-56');
    fireEvent.press(screen.getByTestId('verify'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(api.store.current).toEqual({ accessToken: 'a', refreshToken: 'r' });
    expect(api.calls[0]!.body).toEqual({
      audience: 'rider',
      channel: 'sms',
      destination: '+251911223344',
    });
  });
});

describe('ScanScreen', () => {
  it('looks up a code, shows the price and starts once with an idempotency key', async () => {
    const api = fakeApi({
      'GET /v1/rider/scooters/lookup': () => ({
        body: {
          code: 'CAP-001',
          model: null,
          available: true,
          unavailableReason: null,
          batteryPercent: 76,
          lastUpdateAt: null,
        },
      }),
      'GET /v1/rider/pricing': () => ({ body: pricing }),
      'POST /v1/rider/rides': () => ({ status: 201, body: ride({ status: 'unlock_pending' }) }),
    });
    const onStarted = jest.fn();
    render(withSession(api.client, <ScanScreen onStarted={onStarted} showCamera={false} />));
    fireEvent.changeText(screen.getByTestId('scooter-code'), 'cap-001');
    fireEvent.press(screen.getByTestId('find'));
    await screen.findByText('Start ride on CAP-001?');
    expect(screen.getByText('Unlock ETB 15.00 + ETB 3.00 per minute')).toBeTruthy();
    expect(screen.getByText('Test pricing — not real prices')).toBeTruthy();
    fireEvent.press(screen.getByTestId('start-ride'));
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith(ride().id));
    const start = api.calls.find((c) => c.path === '/v1/rider/rides')!;
    expect(start.body).toEqual({ code: 'cap-001' });
    expect(start.headers['idempotency-key']).toMatch(/^m-/);
  });

  it('explains why a scooter is unavailable and does not allow starting', async () => {
    const api = fakeApi({
      'GET /v1/rider/scooters/lookup': () => ({
        body: {
          code: 'CAP-002',
          model: null,
          available: false,
          unavailableReason: 'low_battery',
          batteryPercent: 5,
          lastUpdateAt: null,
        },
      }),
      'GET /v1/rider/pricing': () => ({ body: pricing }),
    });
    render(withSession(api.client, <ScanScreen onStarted={jest.fn()} showCamera={false} />));
    fireEvent.changeText(screen.getByTestId('scooter-code'), 'CAP-002');
    fireEvent.press(screen.getByTestId('find'));
    await screen.findByText('This scooter’s battery is too low.');
    expect(screen.getByTestId('start-ride')).toBeDisabled();
  });

  it('shows the balance message when the server refuses the start', async () => {
    const api = fakeApi({
      'GET /v1/rider/scooters/lookup': () => ({
        body: {
          code: 'CAP-003',
          model: null,
          available: true,
          unavailableReason: null,
          batteryPercent: 80,
          lastUpdateAt: null,
        },
      }),
      'GET /v1/rider/pricing': () => ({ body: pricing }),
      'POST /v1/rider/rides': () => ({
        status: 409,
        body: { error: { code: 'BALANCE_TOO_LOW', message: 'x' } },
      }),
    });
    render(withSession(api.client, <ScanScreen onStarted={jest.fn()} showCamera={false} />));
    fireEvent.changeText(screen.getByTestId('scooter-code'), 'CAP-003');
    fireEvent.press(screen.getByTestId('find'));
    fireEvent.press(await screen.findByTestId('start-ride'));
    await screen.findByText('Your balance is too low. Top up your wallet to ride.');
  });
});

describe('WalletScreen', () => {
  it('opens checkout, then only reports what the server verified', async () => {
    let balance = 0;
    const api = fakeApi({
      'GET /v1/rider/wallet': () => ({
        body: {
          currency: 'ETB',
          balanceSantim: balance,
          heldSantim: 0,
          availableSantim: balance,
          minimumTopUpSantim: 50_000,
        },
      }),
      'GET /v1/rider/wallet/transactions': () => ({ body: [] }),
      'POST /v1/rider/wallet/topups': () => ({
        status: 201,
        body: {
          id: 'p-1',
          status: 'pending',
          checkoutUrl: 'https://checkout.test/p-1',
          amountSantim: 50_000,
        },
      }),
      'POST /v1/rider/wallet/topups/p-1/check': () => ({
        body: { id: 'p-1', status: 'pending', checkoutUrl: null },
      }),
    });
    const openCheckout = jest.fn(async () => {
      balance = 50_000; // even if the money moved, only the server's answer counts
    });
    render(withSession(api.client, <WalletScreen openCheckout={openCheckout} />));
    await screen.findByText('ETB 0.00');
    fireEvent.press(screen.getByTestId('topup'));
    await screen.findByText('Payment pending. Your balance updates once the payment is confirmed.');
    expect(openCheckout).toHaveBeenCalledWith('https://checkout.test/p-1');
    const create = api.calls.find((c) => c.path === '/v1/rider/wallet/topups')!;
    expect(create.body).toEqual({ amountSantim: 50_000 });
    expect(create.headers['idempotency-key']).toBeTruthy();
  });

  it('blocks top-ups below the minimum', async () => {
    const api = fakeApi({
      'GET /v1/rider/wallet': () => ({
        body: {
          currency: 'ETB',
          balanceSantim: 0,
          heldSantim: 0,
          availableSantim: 0,
          minimumTopUpSantim: 50_000,
        },
      }),
      'GET /v1/rider/wallet/transactions': () => ({ body: [] }),
    });
    render(withSession(api.client, <WalletScreen openCheckout={jest.fn()} />));
    fireEvent.changeText(screen.getByTestId('topup-amount'), '499.99');
    await waitFor(() => expect(screen.getByTestId('topup')).toBeDisabled());
  });
});
