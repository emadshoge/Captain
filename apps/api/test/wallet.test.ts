import { loadApiConfig } from '@captain/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStaffCommand } from '../src/cli/staff';
import { processPayment, reconcilePayments } from '../src/wallet/payments';
import { FakePaymentProvider } from '../src/wallet/providers';
import { sweepPaymentReconciliation } from '../src/worker/sweeps';
import {
  bearer,
  buildTestApp,
  createHarness,
  destroyHarness,
  signInRider,
  signInStaff,
  type Harness,
  type TestApp,
} from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  const env = { APP_ENV: 'test', DATABASE_URL: h.db.url };
  await runStaffCommand(
    [
      'create',
      '--email',
      'fin-a@captain.et',
      '--name',
      'Fin A',
      '--role',
      'admin',
      '--reason',
      'tests',
    ],
    env,
  );
  await runStaffCommand(
    [
      'create',
      '--email',
      'fin-b@captain.et',
      '--name',
      'Fin B',
      '--role',
      'admin',
      '--reason',
      'tests',
    ],
    env,
  );
  await runStaffCommand(
    [
      'create',
      '--email',
      'wallet-op@captain.et',
      '--name',
      'Op',
      '--role',
      'operator',
      '--reason',
      'tests',
    ],
    env,
  );
});
afterAll(async () => {
  await destroyHarness(h);
});

let keySeq = 0;
const key = () => `test-key-${Date.now()}-${keySeq++}`;

async function setup() {
  const provider = new FakePaymentProvider();
  const t = await buildTestAppWithProvider(provider);
  return { t, provider, rider: await signInRider(t) };
}

const buildTestAppWithProvider = (provider: FakePaymentProvider | null) =>
  buildTestApp(h, {}, undefined, provider);

async function topUp(t: TestApp, token: string, amountSantim: number, idempotencyKey = key()) {
  return t.request({
    method: 'POST',
    url: '/v1/rider/wallet/topups',
    headers: { ...bearer(token), 'idempotency-key': idempotencyKey },
    payload: { amountSantim },
  });
}

async function webhook(
  t: TestApp,
  provider: FakePaymentProvider,
  body: Record<string, unknown>,
  signature?: string,
) {
  const signed = provider.signWebhook(body);
  return t.request({
    method: 'POST',
    url: '/v1/webhooks/fake',
    headers: {
      'content-type': 'application/json',
      'x-fake-signature': signature ?? signed.signature,
    },
    payload: signed.raw,
  });
}

const wallet = async (t: TestApp, token: string) =>
  (await t.request({ method: 'GET', url: '/v1/rider/wallet', headers: bearer(token) })).json();

const journalsFor = async (paymentId: string) =>
  (
    await h.pool.query(
      `select count(*)::int n from journal_entries where reference_type = 'payment_attempt' and reference_id = $1`,
      [paymentId],
    )
  ).rows[0].n as number;

describe('wallet and top-up validation', () => {
  it('starts empty and enforces the 500 ETB minimum and idempotency key', async () => {
    const { t, rider } = await setup();
    expect(await wallet(t, rider.accessToken)).toEqual({
      currency: 'ETB',
      balanceSantim: 0,
      heldSantim: 0,
      availableSantim: 0,
      minimumTopUpSantim: 50_000,
    });
    const below = await topUp(t, rider.accessToken, 49_999);
    expect(below.json().error.code).toBe('TOPUP_BELOW_MINIMUM');
    const noKey = await t.request({
      method: 'POST',
      url: '/v1/rider/wallet/topups',
      headers: bearer(rider.accessToken),
      payload: { amountSantim: 50_000 },
    });
    expect(noKey.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await topUp(t, rider.accessToken, 50_000.5)).statusCode).toBe(400);
  });

  it('returns 503 when no payment provider is configured (Chapa blocked)', async () => {
    const t = await buildTestAppWithProvider(null);
    const rider = await signInRider(t);
    const res = await topUp(t, rider.accessToken, 50_000);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('PAYMENTS_UNAVAILABLE');
  });

  it('replays the same idempotency key and refuses a different body with it', async () => {
    const { t, rider } = await setup();
    const k = key();
    const first = await topUp(t, rider.accessToken, 60_000, k);
    const second = await topUp(t, rider.accessToken, 60_000, k);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    const count = await h.pool.query(
      `select count(*)::int n from payment_attempts where rider_id = $1`,
      [rider.subject.riderId],
    );
    expect(count.rows[0].n).toBe(1);
    const reused = await topUp(t, rider.accessToken, 70_000, k);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('verify-before-credit', () => {
  it('credits exactly once after a signed webhook and server-side verification', async () => {
    const { t, provider, rider } = await setup();
    const created = await topUp(t, rider.accessToken, 75_000);
    expect(created.json()).toMatchObject({
      status: 'pending',
      amountSantim: 75_000,
      provider: 'fake',
    });
    expect(created.json().checkoutUrl).toContain('/v1/dev/fake-checkout/');
    const { id, txRef } = created.json();

    // Returning from checkout before paying: still pending, nothing credited.
    const early = await t.request({
      method: 'POST',
      url: `/v1/rider/wallet/topups/${id}/check`,
      headers: bearer(rider.accessToken),
    });
    expect(early.json().status).toBe('pending');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);

    provider.settle(txRef, 'success');
    const hook = await webhook(t, provider, {
      event_id: `evt-${txRef}`,
      tx_ref: txRef,
      status: 'success',
    });
    expect(hook.json()).toMatchObject({ received: true, outcome: 'credited' });
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(75_000);

    // Replayed webhook: deduplicated; a new event id for the same payment: no second credit.
    expect(
      (
        await webhook(t, provider, { event_id: `evt-${txRef}`, tx_ref: txRef, status: 'success' })
      ).json(),
    ).toMatchObject({ duplicate: true });
    expect(
      (
        await webhook(t, provider, { event_id: `evt2-${txRef}`, tx_ref: txRef, status: 'success' })
      ).json().outcome,
    ).toBe('already_credited');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(75_000);
    expect(await journalsFor(id)).toBe(1);

    const tx = (
      await t.request({
        method: 'GET',
        url: '/v1/rider/wallet/transactions',
        headers: bearer(rider.accessToken),
      })
    ).json();
    expect(tx[0]).toMatchObject({ kind: 'topup', amountSantim: 75_000 });
    expect(tx[0].description).toContain('SIMULATED');
  });

  it('never credits from a webhook body or redirect claim when the provider does not confirm', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    // Webhook claims success but the provider still says pending.
    const hook = await webhook(t, provider, {
      event_id: `lie-${txRef}`,
      tx_ref: txRef,
      status: 'success',
      amount: 50_000,
    });
    expect(hook.json().outcome).toBe('pending');
    const claim = await t.request({
      method: 'POST',
      url: `/v1/rider/wallet/topups/${id}/check?status=success&amount=50000`,
      headers: bearer(rider.accessToken),
    });
    expect(claim.json().status).toBe('pending');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);
  });

  it('rejects invalid webhook signatures and records them', async () => {
    const { t, provider, rider } = await setup();
    const { txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'success');
    const forged = await webhook(
      t,
      provider,
      { event_id: `forged-${txRef}`, tx_ref: txRef },
      'f'.repeat(64),
    );
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe('INVALID_SIGNATURE');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);
    const event = await h.pool.query(
      `select signature_valid, outcome from payment_events where dedupe_key = $1`,
      [`forged-${txRef}`],
    );
    expect(event.rows[0]).toEqual({ signature_valid: false, outcome: 'rejected_signature' });
  });

  it.each([
    ['tampered amount', { amountSantim: 5_000_000 }],
    ['wrong currency', { currency: 'USD' }],
    ['different reference', { txRef: 'someone-elses-ref' }],
  ])('sends a %s to review without crediting', async (_label, override) => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'success');
    provider.overrides.set(txRef, override);
    const hook = await webhook(t, provider, { event_id: `t-${txRef}`, tx_ref: txRef });
    expect(hook.json().outcome).toBe('review');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);
    expect(await journalsFor(id)).toBe(0);
    const alert = await h.pool.query(
      `select severity from operational_alerts where dedupe_key = $1`,
      [`payment_review:${id}`],
    );
    expect(alert.rows[0].severity).toBe('critical');
  });

  it('keeps payments pending when the provider is unreachable, then reconciles a lost webhook', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'success');
    provider.unavailable = true;
    const check = await t.request({
      method: 'POST',
      url: `/v1/rider/wallet/topups/${id}/check`,
      headers: bearer(rider.accessToken),
    });
    expect(check.json().status).toBe('pending');
    const event = await h.pool.query(`select outcome from payment_events where payment_id = $1`, [
      id,
    ]);
    expect(event.rows.map((r) => r.outcome)).toContain('verify_unavailable');

    provider.unavailable = false;
    t.advance(120_000);
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
    expect(await reconcilePayments(deps)).toBeGreaterThanOrEqual(1);
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(50_000);
    // The worker never reconciles the per-process fake provider.
    expect(await sweepPaymentReconciliation(deps)).toBe(0);
  });

  it('expires abandoned payments but still credits a late provider success', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    t.advance(61 * 60_000);
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
    expect(await processPayment(deps, id, 'reconcile')).toBe('expired');
    provider.settle(txRef, 'success');
    expect(await processPayment(deps, id, 'reconcile')).toBe('credited');
    const row = (
      await h.pool.query(`select status, failure_reason from payment_attempts where id = $1`, [id])
    ).rows[0];
    expect(row).toEqual({ status: 'succeeded', failure_reason: 'late_success' });
  });

  it('marks failures and sends a later "success" for a failed payment to review', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'failed');
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
    expect(await processPayment(deps, id, 'verify')).toBe('failed');
    provider.settle(txRef, 'success');
    expect(await processPayment(deps, id, 'verify')).toBe('review');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);
  });

  it('credits exactly once under concurrent processing', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 90_000)).json();
    provider.settle(txRef, 'success');
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => processPayment(deps, id, 'webhook')),
    );
    expect(outcomes.filter((o) => o === 'credited')).toHaveLength(1);
    expect(outcomes.every((o) => o === 'credited' || o === 'already_credited')).toBe(true);
    expect(await journalsFor(id)).toBe(1);
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(90_000);
  });

  it('rolls back the credit when finishing the payment fails', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'success');
    await h.pool.query(`
      create function test_fail_success() returns trigger language plpgsql as $$
      begin if new.status = 'succeeded' then raise exception 'simulated database failure'; end if; return new; end $$;
      create trigger test_fail_success before update on payment_attempts for each row execute function test_fail_success();`);
    try {
      const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
      await expect(processPayment(deps, id, 'verify')).rejects.toThrow(
        /simulated database failure/,
      );
      expect(await journalsFor(id)).toBe(0);
      expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(0);
    } finally {
      await h.pool.query(
        `drop trigger test_fail_success on payment_attempts; drop function test_fail_success();`,
      );
    }
    const deps = { config: t.config, pool: h.pool, now: () => new Date(t.now()), provider };
    expect(await processPayment(deps, id, 'verify')).toBe('credited');
  });

  it('hides other riders’ payments', async () => {
    const { t, rider } = await setup();
    const other = await signInRider(t);
    const { id } = (await topUp(t, rider.accessToken, 50_000)).json();
    expect(
      (
        await t.request({
          method: 'GET',
          url: `/v1/rider/wallet/topups/${id}`,
          headers: bearer(other.accessToken),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.request({
          method: 'POST',
          url: `/v1/rider/wallet/topups/${id}/check`,
          headers: bearer(other.accessToken),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('runs the development fake checkout end to end', async () => {
    const { t, rider } = await setup();
    const { txRef } = (await topUp(t, rider.accessToken, 55_000)).json();
    const res = await t.request({
      method: 'POST',
      url: `/v1/dev/fake-checkout/${txRef}/complete`,
      payload: { outcome: 'success' },
    });
    expect(res.json()).toMatchObject({ simulated: true, webhookStatus: 200 });
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(55_000);
  });
});

describe('staff adjustments and refunds', () => {
  it('adjusts with a reason, never below zero, and serializes concurrent debits', async () => {
    const { t, rider } = await setup();
    const admin = await signInStaff(t, 'fin-a@captain.et');
    const id = rider.subject.riderId;
    const adjust = (amountSantim: number) =>
      t.request({
        method: 'POST',
        url: `/v1/admin/riders/${id}/adjustments`,
        headers: {
          cookie: admin.cookie,
          origin: 'http://localhost:3001',
          'x-csrf-token': admin.csrfToken,
          'idempotency-key': key(),
        },
        payload: { amountSantim, reason: 'goodwill credit test' },
      });
    expect((await adjust(1_000)).json().balanceSantim).toBe(1_000);
    expect((await adjust(-5_000)).json().error.code).toBe('INSUFFICIENT_FUNDS');

    const results = await Promise.all(Array.from({ length: 6 }, () => adjust(-300)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(100);
    const audit = await h.pool.query(
      `select count(*)::int n from audit_log where action = 'wallet.adjusted' and target_id = $1`,
      [id],
    );
    expect(audit.rows[0].n).toBe(4);
  });

  it('requires a second approver and credits wallet refunds on approval', async () => {
    const { t, rider } = await setup();
    const a = await signInStaff(t, 'fin-a@captain.et');
    const b = await signInStaff(t, 'fin-b@captain.et');
    const created = await a.call('POST', '/v1/admin/refunds', {
      riderId: rider.subject.riderId,
      amountSantim: 2_500,
      destination: 'wallet',
      reason: 'scooter failed mid-ride',
    });
    expect(created.json().status).toBe('requested');
    const self = await a.call('POST', `/v1/admin/refunds/${created.json().id}/approve`, {
      note: 'looks fine',
    });
    expect(self.json().error.code).toBe('SECOND_APPROVER_REQUIRED');
    const approved = await b.call('POST', `/v1/admin/refunds/${created.json().id}/approve`, {
      note: 'verified ride log',
    });
    expect(approved.json()).toMatchObject({ status: 'completed', decidedByStaffId: b.staffId });
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(2_500);
    expect(
      (await b.call('POST', `/v1/admin/refunds/${created.json().id}/approve`, { note: 'again' }))
        .statusCode,
    ).toBe(409);
  });

  it('refunds to the original payment only after finance records the provider reference', async () => {
    const { t, provider, rider } = await setup();
    const { id, txRef } = (await topUp(t, rider.accessToken, 60_000)).json();
    provider.settle(txRef, 'success');
    await webhook(t, provider, { event_id: `r-${txRef}`, tx_ref: txRef });
    const a = await signInStaff(t, 'fin-a@captain.et');
    const b = await signInStaff(t, 'fin-b@captain.et');
    const tooMuch = await a.call('POST', '/v1/admin/refunds', {
      riderId: rider.subject.riderId,
      amountSantim: 60_001,
      destination: 'original_payment',
      paymentId: id,
      reason: 'customer request',
    });
    expect(tooMuch.statusCode).toBe(409);
    const refund = (
      await a.call('POST', '/v1/admin/refunds', {
        riderId: rider.subject.riderId,
        amountSantim: 20_000,
        destination: 'original_payment',
        paymentId: id,
        reason: 'customer request',
      })
    ).json();
    expect(
      (
        await b.call('POST', `/v1/admin/refunds/${refund.id}/approve`, { note: 'ok to refund' })
      ).json().status,
    ).toBe('approved');
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(60_000); // not debited yet
    const done = await b.call('POST', `/v1/admin/refunds/${refund.id}/complete`, {
      providerReference: 'MANUAL-REF-1',
      note: 'sent via provider dashboard',
    });
    expect(done.json()).toMatchObject({ status: 'completed', providerReference: 'MANUAL-REF-1' });
    expect((await wallet(t, rider.accessToken)).balanceSantim).toBe(40_000);
  });

  it('keeps operators out of money endpoints', async () => {
    const { t, rider } = await setup();
    const op = await signInStaff(t, 'wallet-op@captain.et');
    for (const [method, url, payload] of [
      ['GET', '/v1/admin/payments'],
      ['GET', `/v1/admin/riders/${rider.subject.riderId}/wallet`],
      [
        'POST',
        `/v1/admin/riders/${rider.subject.riderId}/adjustments`,
        { amountSantim: 100, reason: 'escalation' },
      ],
      [
        'POST',
        '/v1/admin/refunds',
        {
          riderId: rider.subject.riderId,
          amountSantim: 1,
          destination: 'wallet',
          reason: 'escalation',
        },
      ],
      ['GET', '/v1/admin/payments/export.csv?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z'],
    ] as const) {
      expect((await op.call(method, url, payload)).statusCode).toBe(403);
    }
  });
});

describe('reconciliation reporting', () => {
  it('exports a bounded, formula-safe CSV', async () => {
    const { t, rider } = await setup();
    const admin = await signInStaff(t, 'fin-a@captain.et');
    const { id } = (await topUp(t, rider.accessToken, 50_000)).json();
    await h.pool.query(
      `update payment_attempts set failure_reason = '=HYPERLINK("http://evil")' where id = $1`,
      [id],
    );
    const from = new Date(t.now() - 3_600_000).toISOString();
    const to = new Date(t.now() + 3_600_000).toISOString();
    const res = await admin.call('GET', `/v1/admin/payments/export.csv?from=${from}&to=${to}`);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.body).not.toMatch(/,=HYPERLINK/);
    const tooLong = await admin.call(
      'GET',
      `/v1/admin/payments/export.csv?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z`,
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it('lists payments, shows events, and re-verifies on demand', async () => {
    const { t, provider, rider } = await setup();
    const admin = await signInStaff(t, 'fin-a@captain.et');
    const { id, txRef } = (await topUp(t, rider.accessToken, 50_000)).json();
    provider.settle(txRef, 'success');
    expect((await admin.call('POST', `/v1/admin/payments/${id}/verify`)).json()).toEqual({
      outcome: 'credited',
    });
    const detail = (await admin.call('GET', `/v1/admin/payments/${id}`)).json();
    expect(detail.payment).toMatchObject({ status: 'succeeded', verifiedAmountSantim: 50_000 });
    expect(detail.events.length).toBeGreaterThan(0);
    const list = (
      await admin.call('GET', `/v1/admin/payments?riderId=${rider.subject.riderId}`)
    ).json();
    expect(list[0].id).toBe(id);
  });

  it('keeps the whole ledger balanced', async () => {
    const total = await h.pool.query(
      `select coalesce(sum(amount_santim), 0)::bigint as total from ledger_lines`,
    );
    expect(Number(total.rows[0].total)).toBe(0);
  });

  it('refuses the fake provider and dev checkout outside development/test', () => {
    expect(() =>
      loadApiConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://x/y',
        PAYMENT_PROVIDER: 'fake',
      }),
    ).toThrow();
  });
});
