'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { RequireRider } from '../../components/session';
import { Card, ErrorText } from '../../components/ui';
import {
  api,
  messageFor,
  newIdempotencyKey,
  type Wallet,
  type WalletTransaction,
} from '../../lib/api';
import { formatEtb, parseEtbInput } from '../../lib/format';

const PENDING_TOPUP_KEY = 'captain.pendingTopUp';

function WalletView() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [history, setHistory] = useState<WalletTransaction[]>([]);
  const [amount, setAmount] = useState('500');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<{ amount: number; key: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, h] = await Promise.all([api.wallet(), api.transactions()]);
        if (cancelled) return;
        setWallet(w);
        setHistory(h);
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const santim = parseEtbInput(amount);
  const minimum = wallet?.minimumTopUpSantim ?? 50_000;

  async function topUp(event: FormEvent) {
    event.preventDefault();
    if (santim === null) return;
    setBusy(true);
    setError(null);
    try {
      if (key.current?.amount !== santim)
        key.current = { amount: santim, key: newIdempotencyKey() };
      const payment = await api.createTopUp(santim, key.current.key);
      // Only the payment id is remembered; the return page asks the server to verify it.
      sessionStorage.setItem(PENDING_TOPUP_KEY, payment.id);
      if (payment.checkoutUrl) window.location.assign(payment.checkoutUrl);
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <span className="muted">Balance</span>
        <h1 data-testid="balance">{wallet ? formatEtb(wallet.balanceSantim) : '—'}</h1>
        {wallet && wallet.heldSantim > 0 ? (
          <span className="muted">Available {formatEtb(wallet.availableSantim)}</span>
        ) : null}
      </Card>
      <form onSubmit={topUp} className="card">
        <h2>Top up</h2>
        <label>
          Amount (ETB)
          <input
            name="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <p className="muted">Minimum top-up is {formatEtb(minimum)}.</p>
        <ErrorText message={error} />
        <button type="submit" disabled={busy || santim === null || santim < minimum}>
          Continue to payment
        </button>
      </form>
      <h2>Transactions</h2>
      {history.length === 0 ? <p className="muted">No transactions yet.</p> : null}
      {history.map((tx) => (
        <div className="card" key={tx.journalId}>
          <div className="row">
            <span>{tx.description}</span>
            <strong>{formatEtb(tx.amountSantim)}</strong>
          </div>
          <span className="muted">{new Date(tx.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </>
  );
}

export default function WalletPage() {
  return (
    <RequireRider>
      <WalletView />
    </RequireRider>
  );
}
