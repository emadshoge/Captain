'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RequireRider } from '../../../components/session';
import { Card } from '../../../components/ui';
import { api, messageFor } from '../../../lib/api';

const PENDING_TOPUP_KEY = 'captain.pendingTopUp';

const TEXT: Record<string, string> = {
  succeeded: 'Payment confirmed. Your wallet was topped up.',
  failed: 'The payment did not go through. You were not charged.',
  expired: 'The payment did not go through. You were not charged.',
  review: 'We are checking this payment. Contact support if it does not resolve.',
  pending: 'Payment pending. Your balance updates once the payment is confirmed.',
  initiated: 'Payment pending. Your balance updates once the payment is confirmed.',
};

/**
 * Return page after checkout. Arriving here proves nothing: the page asks
 * the server to verify the payment with the provider and shows its answer.
 */
function ReturnView() {
  const [message, setMessage] = useState('Checking your payment…');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = sessionStorage.getItem(PENDING_TOPUP_KEY);
      let text: string;
      if (!id) text = 'No payment to check.';
      else {
        try {
          const payment = await api.checkTopUp(id);
          text = TEXT[payment.status] ?? TEXT.pending!;
          if (payment.status !== 'pending' && payment.status !== 'initiated') {
            sessionStorage.removeItem(PENDING_TOPUP_KEY);
          }
        } catch (e) {
          text = messageFor(e);
        }
      }
      if (!cancelled) setMessage(text);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <Card>
      <h1>Top up</h1>
      <p data-testid="topup-result">{message}</p>
      <Link href="/wallet">Back to wallet</Link>
    </Card>
  );
}

export default function WalletReturnPage() {
  return (
    <RequireRider>
      <ReturnView />
    </RequireRider>
  );
}
