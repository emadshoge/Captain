import { createHmac } from 'node:crypto';
import type { ApiConfig } from '@captain/config';
import { safeEqual } from '../lib/crypto';

/**
 * Payment provider port. Captain credits a wallet only after `verify()`
 * (a server-to-server check) confirms success with the expected reference,
 * amount and currency. Webhooks and browser redirects only *trigger* a
 * verification; their contents are never trusted for crediting.
 */
export interface InitializeInput {
  txRef: string;
  amountSantim: number;
  currency: 'ETB';
  callbackUrl: string | null;
  returnUrl: string | null;
  customer: { email: string | null; phone: string | null };
}

export interface VerifyResult {
  status: 'success' | 'failed' | 'pending';
  amountSantim?: number;
  currency?: string;
  txRef?: string;
  providerReference?: string;
  raw: Record<string, unknown>;
}

export interface WebhookNotice {
  /** Provider's unique event identity (for de-duplication), if any. */
  dedupeKey: string | null;
  txRef: string | null;
  signatureValid: boolean;
  payload: Record<string, unknown>;
}

/** Network/provider failure where the outcome is unknown: never treat as success or failure. */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
  }
}

export interface PaymentProvider {
  readonly name: 'chapa' | 'fake';
  initialize(input: InitializeInput): Promise<{ checkoutUrl: string; providerReference?: string }>;
  verify(txRef: string): Promise<VerifyResult>;
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookNotice;
}

// ---------------------------------------------------------------------------
// Fake provider (development and isolated tests only; refused in production)
// ---------------------------------------------------------------------------

export const FAKE_WEBHOOK_SECRET = 'captain-fake-provider-webhook-secret-dev-only';

interface FakeTransaction {
  txRef: string;
  amountSantim: number;
  currency: string;
  status: 'pending' | 'success' | 'failed';
  providerReference: string;
}

/**
 * Simulates a hosted-checkout provider. Tests and the dev checkout page
 * decide the outcome; the provider can also be told to report a different
 * amount (tampering) or to be unreachable.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const;
  readonly transactions = new Map<string, FakeTransaction>();
  unavailable = false;
  /** Overrides what verify() reports (to test tampered/mismatched data). */
  readonly overrides = new Map<string, Partial<VerifyResult>>();
  private counter = 0;

  constructor(private readonly checkoutBase = 'http://localhost:3000/v1/dev/fake-checkout') {}

  async initialize(input: InitializeInput) {
    if (this.unavailable) throw new ProviderUnavailableError('fake provider unavailable');
    const providerReference = `FAKE-${++this.counter}-${input.txRef.slice(-6)}`;
    this.transactions.set(input.txRef, {
      txRef: input.txRef,
      amountSantim: input.amountSantim,
      currency: input.currency,
      status: 'pending',
      providerReference,
    });
    return {
      checkoutUrl: `${this.checkoutBase}/${encodeURIComponent(input.txRef)}`,
      providerReference,
    };
  }

  async verify(txRef: string): Promise<VerifyResult> {
    if (this.unavailable) throw new ProviderUnavailableError('fake provider unavailable');
    const tx = this.transactions.get(txRef);
    if (!tx) return { status: 'failed', raw: { simulated: true, reason: 'unknown_tx_ref' } };
    return {
      status: tx.status,
      amountSantim: tx.amountSantim,
      currency: tx.currency,
      txRef: tx.txRef,
      providerReference: tx.providerReference,
      raw: { simulated: true },
      ...this.overrides.get(txRef),
    };
  }

  /** The "customer" completes or abandons checkout. */
  settle(txRef: string, outcome: 'success' | 'failed') {
    const tx = this.transactions.get(txRef);
    if (tx) tx.status = outcome;
  }

  /** Builds a webhook body + signature exactly as this fake provider would send it. */
  signWebhook(body: Record<string, unknown>) {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: createHmac('sha256', FAKE_WEBHOOK_SECRET).update(raw).digest('hex') };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookNotice {
    const provided = headers['x-fake-signature'];
    const expected = createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const signatureValid = typeof provided === 'string' && safeEqual(provided, expected);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return {
        dedupeKey: null,
        txRef: null,
        signatureValid: false,
        payload: { unparseable: true },
      };
    }
    return {
      dedupeKey: typeof payload.event_id === 'string' ? payload.event_id : null,
      txRef: typeof payload.tx_ref === 'string' ? payload.tx_ref : null,
      signatureValid,
      payload,
    };
  }
}

/**
 * Selects the provider. Chapa is intentionally absent: its official API and
 * webhook-signing documentation could not be reviewed (decision T-01), so no
 * Chapa adapter exists yet. `none` disables top-ups.
 */
export function createPaymentProvider(config: ApiConfig): PaymentProvider | null {
  if (config.PAYMENT_PROVIDER === 'fake') {
    return new FakePaymentProvider(
      `${config.PUBLIC_API_URL ?? `http://${config.HOST}:${config.PORT}`}/v1/dev/fake-checkout`,
    );
  }
  return null;
}
