import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { Ride } from '../api/types';
import { Body, Button, Card, Row, SimulatedBadge, Title } from '../components/ui';
import { formatDuration, formatEtb } from '../format';
import { t } from '../i18n';
import { availableActions, elapsedSeconds, type RideAction, statusMessage } from './model';

/** Current ride: status, timer, running estimate and the allowed actions. */
export function RideCard({
  ride,
  onAction,
  busy,
  now = () => new Date(),
}: {
  ride: Ride;
  onAction: (action: RideAction) => void;
  busy?: RideAction | null;
  now?: () => Date;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (ride.status !== 'active' && ride.status !== 'paused') return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ride.status]);
  void tick;

  const actions = availableActions(ride);
  const label: Record<RideAction, string> = {
    pause: t('ride.pause'),
    resume: t('ride.resume'),
    end: t('ride.end'),
  };
  return (
    <Card>
      <Title>{t(statusMessage(ride.status))}</Title>
      <SimulatedBadge simulated={ride.isSimulated} devPricing={ride.pricing.isDevFixture} />
      <Body muted>{ride.scooterCode}</Body>
      {ride.startedAt ? (
        <Row label={t('ride.elapsed')} value={formatDuration(elapsedSeconds(ride, now()))} />
      ) : null}
      {ride.fare ? (
        <Row
          label={ride.fareIsEstimate ? t('ride.estimate') : t('receipt.total')}
          value={formatEtb(ride.fare.totalSantim)}
        />
      ) : null}
      {ride.parkingStatus === 'outside' ? (
        <Body tone="warn">{t('ride.parkingOutside')}</Body>
      ) : null}
      {actions.includes('end') ? <Body muted>{t('ride.endHint')}</Body> : null}
      <View style={{ gap: 8 }}>
        {actions.map((action) => (
          <Button
            key={action}
            testID={`ride-${action}`}
            label={label[action]}
            variant={action === 'end' ? 'danger' : 'secondary'}
            busy={busy === action}
            disabled={!!busy && busy !== action}
            onPress={() => onAction(action)}
          />
        ))}
      </View>
    </Card>
  );
}
