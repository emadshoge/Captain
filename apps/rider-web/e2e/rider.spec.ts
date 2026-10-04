import { expect, type Page, test } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

async function otpFor(destination: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const response = await fetch(
      `${API}/v1/dev/outbox?destination=${encodeURIComponent(destination)}`,
    );
    const { messages } = (await response.json()) as { messages: { code: string }[] };
    if (messages.length) return messages.at(-1)!.code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no OTP in the development outbox');
}

async function signIn(page: Page, phone: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(`We sent a 6-digit code to ${phone}.`)).toBeVisible();
  await page.getByLabel('Code').fill(await otpFor(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Ride' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('rider signs in, tops up through the simulated checkout, rides and gets a receipt', async ({
  page,
}) => {
  const phone = '+251911000111';
  await signIn(page, phone);

  // The session survives a reload (HttpOnly cookie; CSRF token re-fetched).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Ride' })).toBeVisible();

  // Top-up: checkout page (SIMULATED) → provider webhook → return page asks the server.
  await page.getByRole('link', { name: 'Wallet' }).click();
  await expect(page.getByTestId('balance')).toHaveText('ETB 0.00');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect(
    page.getByRole('heading', { name: 'SIMULATED payment — no real money' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Pay (simulated)' }).click();
  await expect(page).toHaveURL(/\/wallet\/return/);
  await expect(page.getByTestId('topup-result')).toHaveText(
    'Payment confirmed. Your wallet was topped up.',
  );
  await page.getByRole('link', { name: 'Back to wallet' }).click();
  await expect(page.getByTestId('balance')).toHaveText('ETB 500.00');

  // Ride on a simulated scooter; the gateway simulator acknowledges commands.
  await page.getByRole('link', { name: 'Captain' }).click();
  await page.getByLabel('Scooter code').fill('DEV-0001');
  await page.getByRole('button', { name: 'Find scooter' }).click();
  await expect(page.getByRole('heading', { name: 'Start ride on DEV-0001?' })).toBeVisible();
  await expect(page.getByText('Test pricing — not real prices')).toBeVisible();
  await page.getByRole('button', { name: 'Start ride' }).click();
  await expect(page.getByTestId('ride-status')).toHaveText('Ride in progress');
  await expect(page.getByText('SIMULATED')).toBeVisible();

  await page.getByRole('button', { name: 'End ride' }).click();
  await expect(page.getByTestId('ride-status')).toHaveText('Ride complete');
  const charged = await page.getByTestId('charged').textContent();
  expect(charged).toMatch(/^ETB \d+\.\d{2}$/);

  await page.getByRole('link', { name: 'History' }).click();
  await page.getByText('DEV-0001 · Ride complete').click();
  await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
  await expect(page.getByTestId('receipt-total')).toHaveText(charged!);

  await page.getByRole('link', { name: 'Wallet' }).click();
  const expected = 50_000 - Number(charged!.replace(/[^\d]/g, ''));
  await expect(page.getByTestId('balance')).toHaveText(
    `ETB ${Math.floor(expected / 100)}.${String(expected % 100).padStart(2, '0')}`,
  );
});

test('unknown scooter codes and low balances are explained', async ({ page }) => {
  await signIn(page, '+251911000222');
  await page.getByLabel('Scooter code').fill('NOPE-404');
  await page.getByRole('button', { name: 'Find scooter' }).click();
  await expect(page.locator('p[role=alert]')).toHaveText(
    'We could not find that scooter. Check the code.',
  );

  await page.getByLabel('Scooter code').fill('DEV-0002');
  await page.getByRole('button', { name: 'Find scooter' }).click();
  await page.getByRole('button', { name: 'Start ride' }).click();
  await expect(page.locator('p[role=alert]')).toHaveText(
    'Your balance is too low. Top up your wallet to ride.',
  );
});

test('cookie sessions need the CSRF token and an allowed origin; sign-out ends the session', async ({
  page,
}) => {
  await signIn(page, '+251911000333');
  const withoutCsrf = await page.evaluate(async (api) => {
    const response = await fetch(`${api}/v1/rider/rides`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'csrf-test-123456' },
      body: JSON.stringify({ code: 'DEV-0003' }),
    });
    return { status: response.status, body: await response.json() };
  }, API);
  expect(withoutCsrf.status).toBe(403);
  expect(withoutCsrf.body.error.code).toBe('CSRF_FAILED');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  const after = await page.evaluate(
    async (api) => (await fetch(`${api}/v1/rider/wallet`, { credentials: 'include' })).status,
    API,
  );
  expect(after).toBe(401);
});
