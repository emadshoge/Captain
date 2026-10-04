import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import type { NearbyScooter } from '../api/types';
import { Body, Button, Card, ErrorBanner, Row, Screen, Title } from '../components/ui';
import { appConfig } from '../config';
import { formatDistance } from '../format';
import { t } from '../i18n';
import { statusMessage } from '../ride/model';
import { useSession } from '../session/SessionContext';
import { messageFor, useApi } from '../useApi';

/**
 * Home: current ride shortcut, nearby scooters and "scan to ride". The
 * Mapbox map needs a token and a development build (user actions B1/B5);
 * until then the nearby scooters are shown as a list.
 */
export function HomeScreen({
  onScan,
  onOpenRide,
}: {
  onScan: () => void;
  onOpenRide: (id: string) => void;
}) {
  const { client } = useSession();
  const current = useApi(() => client.currentRide(), [], 10_000);
  const [nearby, setNearby] = useState<NearbyScooter[] | null>(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { granted } = await Location.requestForegroundPermissionsAsync();
        if (!granted) {
          if (!cancelled) setLocationDenied(true);
          return;
        }
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const list = await client.nearby(position.coords.latitude, position.coords.longitude);
        if (!cancelled) setNearby(list);
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const ride = current.data?.ride ?? null;
  return (
    <Screen>
      {ride ? (
        <Card>
          <Title>{t('home.currentRide')}</Title>
          <Body>{t(statusMessage(ride.status))}</Body>
          <Button label={t('home.openRide')} onPress={() => onOpenRide(ride.id)} />
        </Card>
      ) : (
        <Button testID="scan" label={t('home.scan')} onPress={onScan} />
      )}
      <Title>{t('home.nearby')}</Title>
      {appConfig.mapboxToken ? null : <Body muted>{t('home.mapUnavailable')}</Body>}
      {locationDenied ? <Body muted>{t('home.locationDenied')}</Body> : null}
      <ErrorBanner message={error} />
      {nearby?.length === 0 ? <Body muted>{t('home.noNearby')}</Body> : null}
      {nearby?.map((s) => (
        <Card key={s.code}>
          <Row label={s.code} value={formatDistance(s.distanceM)} />
          {s.batteryPercent !== null ? (
            <Body muted>{t('home.battery', { percent: s.batteryPercent })}</Body>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
