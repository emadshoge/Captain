import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { newIdempotencyKey } from '../api/client';
import type { TopUp } from '../api/types';
import { Body, Button, Card, ErrorBanner, Field, Row, Screen, Title } from '../components/ui';
import { formatEtb, parseEtbInput } from '../format';
import { t } from '../i18n';
import { useSession } from '../session/SessionContext';
import { messageFor, useApi } from '../useApi';

export function topUpMessage(status: TopUp['status']) {
  switch (status) {
    case 'succeeded':
      return t('wallet.credited');
    case 'failed':
    case 'expired':
      return t('wallet.failed');
    case 'review':
      return t('wallet.review');
    default:
      return t('wallet.pending');
  }
}

/**
 * Balance, top-up and history. After checkout the app only asks the server
 * to verify the payment; the balance changes only when the server confirms
 * it with the payment provider (never because the browser came back).
 */
export function WalletScreen({
  openCheckout = (url: string) => WebBrowser.openBrowserAsync(url),
}: {
  openCheckout?: (url: string) => Promise<unknown>;
}) {
  const { client } = useSession();
  const wallet = useApi(() => client.wallet());
  const history = useApi(() => client.transactions());
  const [amount, setAmount] = useState('500');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = useRef<{ amount: number; key: string } | null>(null);

  const santim = parseEtbInput(amount);
  const minimum = wallet.data?.minimumTopUpSantim ?? 50_000;

  async function topUp() {
    if (santim === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (key.current?.amount !== santim)
        key.current = { amount: santim, key: newIdempotencyKey() };
      const payment = await client.createTopUp(santim, key.current.key);
      if (payment.checkoutUrl) await openCheckout(payment.checkoutUrl);
      setNotice(t('wallet.checking'));
      const checked = await client.checkTopUp(payment.id);
      setNotice(topUpMessage(checked.status));
      key.current = null;
      await Promise.all([wallet.reload(), history.reload()]);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Card>
        <Body muted>{t('wallet.balance')}</Body>
        <Title>{wallet.data ? formatEtb(wallet.data.balanceSantim) : '—'}</Title>
        {wallet.data && wallet.data.heldSantim > 0 ? (
          <Body muted>
            {t('wallet.available', { amount: formatEtb(wallet.data.availableSantim) })}
          </Body>
        ) : null}
      </Card>
      <ErrorBanner message={wallet.error} />
      <Title>{t('wallet.topUp')}</Title>
      <Field
        label={t('wallet.amount')}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        testID="topup-amount"
      />
      <Body muted>{t('wallet.minimum', { amount: formatEtb(minimum) })}</Body>
      <ErrorBanner message={error} />
      {notice ? <Body>{notice}</Body> : null}
      <Button
        testID="topup"
        label={t('wallet.pay')}
        onPress={() => void topUp()}
        busy={busy}
        disabled={santim === null || santim < minimum}
      />
      <Title>{t('wallet.history')}</Title>
      {history.data?.length === 0 ? <Body muted>{t('wallet.empty')}</Body> : null}
      {history.data?.map((tx) => (
        <Card key={tx.journalId}>
          <Row label={tx.description} value={formatEtb(tx.amountSantim)} />
          <Body muted>{new Date(tx.createdAt).toLocaleString()}</Body>
        </Card>
      ))}
    </Screen>
  );
}
