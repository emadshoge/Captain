import { createHmac } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

async function outboxCode(destination: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const response = await fetch(
      `${API}/v1/dev/outbox?destination=${encodeURIComponent(destination)}`,
    );
    const { messages } = (await response.json()) as { messages: { code: string }[] };
    if (messages.length) return messages.at(-1)!.code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code in the development outbox for ${destination}`);
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Email code').fill(await outboxCode(email));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

/** A rider created through the API (mobile client), funded by an admin later. */
async function createRider(phone: string): Promise<void> {
  const request = await fetch(`${API}/v1/auth/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: 'rider', channel: 'sms', destination: phone }),
  });
  const { challengeId } = (await request.json()) as { challengeId: string };
  const verify = await fetch(`${API}/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId, code: await outboxCode(phone), client: 'mobile' }),
  });
  expect(verify.status).toBe(200);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the enrolment test. */
function totp(base32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

test.describe.configure({ mode: 'serial' });

test('operators work the fleet but cannot reach admin pages or APIs', async ({ page }) => {
  await signIn(page, 'e2e-operator@captain.et');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Fleet' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Payments', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);

  // Admin pages refuse, and so does the API when called directly with the operator's session.
  await page.goto('/admin/payments');
  await expect(page.getByTestId('forbidden')).toBeVisible();
  const status = await page.evaluate(
    async (api) => (await fetch(`${api}/v1/admin/payments`, { credentials: 'include' })).status,
    API,
  );
  expect(status).toBe(403);

  // Fleet: simulated scooters are labelled; change a status with a reason.
  await page.goto('/fleet');
  await page.getByRole('link', { name: 'DEV-0005' }).click();
  await expect(page.getByRole('heading', { name: /Scooter DEV-0005/ })).toContainText('SIMULATED');
  const form = page.getByTestId('status-form');
  await form.getByLabel('New status').selectOption('maintenance');
  await form.getByLabel('Reason').fill('brake check requested');
  await form.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByTestId('scooter-status')).toHaveText('maintenance');

  // Incidents: report, take, resolve.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Incidents' })
    .click();
  const report = page.getByRole('form', { name: 'Report an incident' });
  await report.getByLabel('Kind').selectOption('damage_report');
  await report.getByLabel('Description').fill('Cracked mudguard on DEV-0005');
  await report.getByRole('button', { name: 'Report incident' }).click();
  await expect(page.getByRole('cell', { name: 'Cracked mudguard on DEV-0005' })).toBeVisible();
  await page.getByRole('button', { name: 'Take' }).first().click();
  await page.getByRole('button', { name: 'Resolve…' }).first().click();
  const resolve = page.getByRole('form', { name: 'Resolve incident' });
  await resolve.getByLabel('What was done').fill('Mudguard replaced');
  await resolve.getByRole('button', { name: 'Resolve incident' }).click();
  await expect(page.getByRole('cell', { name: 'Cracked mudguard on DEV-0005' })).toHaveCount(0);
});

test('admins adjust wallets with confirmation and refunds need a second administrator', async ({
  browser,
}) => {
  const phone = '+251911555666';
  await createRider(phone);

  const a = await browser.newPage();
  await signIn(a, 'e2e-admin-a@captain.et');
  await a.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Riders' }).click();
  await a.getByLabel('Search phone, email or name').fill(phone);
  await a.getByRole('link', { name: phone }).click();
  await expect(a.getByTestId('rider-balance')).toHaveText('ETB 0.00');

  const adjust = a.getByTestId('adjust-form');
  await adjust.getByLabel('Amount in ETB (negative to debit)').fill('25');
  await adjust.getByLabel('Reason').fill('goodwill for a failed unlock');
  const submit = adjust.getByRole('button', { name: 'Apply adjustment' });
  await expect(submit).toBeDisabled(); // confirmation not ticked yet
  await adjust.getByRole('checkbox').check();
  await submit.click();
  await expect(a.getByTestId('rider-balance')).toHaveText('ETB 25.00');

  // Overdrawing is refused by the server.
  await adjust.getByLabel('Amount in ETB (negative to debit)').fill('-100');
  await adjust.getByLabel('Reason').fill('test overdraw');
  await adjust.getByRole('checkbox').check();
  await adjust.getByRole('button', { name: 'Apply adjustment' }).click();
  await expect(adjust.getByRole('alert')).toContainText('not enough money');
  await expect(a.getByTestId('rider-balance')).toHaveText('ETB 25.00');

  const refund = a.getByRole('form', { name: 'Request a refund' });
  await refund.getByLabel('Amount in ETB').fill('10');
  await refund.getByLabel('Reason').fill('scooter stopped mid-ride');
  await refund.getByRole('button', { name: 'Request refund' }).click();
  await expect(refund.getByRole('status')).toContainText('second administrator');

  await a.goto('/admin/refunds');
  await expect(a.getByText('Needs another administrator')).toBeVisible();

  const b = await browser.newPage();
  await signIn(b, 'e2e-admin-b@captain.et');
  await b.goto('/admin/refunds');
  await b.getByRole('button', { name: 'Approve…' }).click();
  const approve = b.getByRole('form', { name: 'Approve refund' });
  await approve.getByLabel('Note').fill('checked the ride log');
  await approve.getByRole('checkbox').check();
  await approve.getByRole('button', { name: 'Approve refund' }).click();
  await expect(b.getByText('No refunds.')).toBeVisible();

  await a.goto('/admin/riders');
  await a.getByLabel('Search phone, email or name').fill(phone);
  await a.getByRole('link', { name: phone }).click();
  await expect(a.getByTestId('rider-balance')).toHaveText('ETB 35.00');

  await a.goto('/admin/audit');
  await a.getByLabel('Action').fill('wallet.adjusted');
  await expect(a.getByRole('cell', { name: 'goodwill for a failed unlock' })).toBeVisible();
});

test('admins download the reconciliation CSV and enrol an authenticator', async ({ page }) => {
  // A separate account: OTP resend cooldowns are real.
  await signIn(page, 'e2e-admin-c@captain.et');
  await page.goto('/admin/payments');
  const download = page.waitForEvent('download');
  await page.getByTestId('export-form').getByRole('button', { name: 'Download CSV' }).click();
  const file = await download;
  const content = await (await file.createReadStream()).toArray();
  const csv = Buffer.concat(content).toString('utf8');
  expect(csv.split('\n')[0]).toContain('tx_ref');

  await page.getByRole('link', { name: 'Account' }).click();
  await expect(page.getByTestId('mfa-state')).toHaveText('Authenticator: not enrolled');
  await page.getByRole('button', { name: 'Start setup' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  await page.getByLabel('Code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.getByTestId('mfa-state')).toHaveText('Authenticator: enrolled');
});
