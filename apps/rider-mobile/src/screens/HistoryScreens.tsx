import { Pressable } from 'react-native';
import type { Ride } from '../api/types';
import { Body, Card, ErrorBanner, Row, Screen, SimulatedBadge, Title } from '../components/ui';
import { formatEtb } from '../format';
import { t } from '../i18n';
import { statusMessage } from '../ride/model';
import { useSession } from '../session/SessionContext';
import { useApi } from '../useApi';

export function HistoryScreen({ onOpen }: { onOpen: (id: string) => void }) {
  const { client } = useSession();
  const { data, error } = useApi(() => client.rides());
  return (
    <Screen>
      <ErrorBanner message={error} />
      {data?.length === 0 ? <Body muted>{t('history.empty')}</Body> : null}
      {data?.map((ride) => (
        <Pressable key={ride.id} accessibilityRole="button" onPress={() => onOpen(ride.id)}>
          <Card>
            <Row
              label={new Date(ride.requestedAt).toLocaleString()}
              value={ride.chargedSantim !== null ? formatEtb(ride.chargedSantim) : '—'}
            />
            <Body muted>
              {ride.scooterCode} · {t(statusMessage(ride.status))}
            </Body>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}

export function Receipt({ ride }: { ride: Ride }) {
  const fare = ride.fare;
  return (
    <Card>
      <Title>{t('receipt.title')}</Title>
      <SimulatedBadge simulated={ride.isSimulated} devPricing={ride.pricing.isDevFixture} />
      <Body muted>
        {ride.scooterCode} · {t(statusMessage(ride.status))}
      </Body>
      {fare ? (
        <>
          <Row label={t('receipt.unlock')} value={formatEtb(fare.unlockFeeSantim)} />
          <Row
            label={t('receipt.riding', { minutes: Math.ceil(fare.ridingSeconds / 60) })}
            value={formatEtb(fare.ridingSantim)}
          />
          {fare.pausedSeconds > 0 ? (
            <Row
              label={t('receipt.paused', { minutes: Math.ceil(fare.pausedSeconds / 60) })}
              value={formatEtb(fare.pausedSantim)}
            />
          ) : null}
          <Row label={t('receipt.total')} value={formatEtb(fare.totalSantim)} />
        </>
      ) : null}
      {ride.chargedSantim !== null ? (
        <Row label={t('receipt.charged')} value={formatEtb(ride.chargedSantim)} />
      ) : null}
      {ride.unpaidSantim ? (
        <Row label={t('receipt.unpaid')} value={formatEtb(ride.unpaidSantim)} />
      ) : null}
    </Card>
  );
}

export function ReceiptScreen({ rideId }: { rideId: string }) {
  const { client } = useSession();
  const { data, error } = useApi(() => client.ride(rideId), [rideId]);
  return (
    <Screen>
      <ErrorBanner message={error} />
      {data ? <Receipt ride={data} /> : null}
    </Screen>
  );
}
