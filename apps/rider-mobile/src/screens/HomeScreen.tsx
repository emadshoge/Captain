import * as Location from 'expo-location';
import { useEffect, useState } from 'react';
import type { NearbyScooter } from '../api/types';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Battery,
  Body,
  Brand,
  Button,
  Card,
  ErrorBanner,
  Screen,
  Title,
  fonts,
  useTheme,
} from '../components/ui';
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

  const c = useTheme();
  const ride = current.data?.ride ?? null;
  return (
    <Screen>
      <Brand />
      {ride ? (
        <Card>
          <Title>{t('home.currentRide')}</Title>
          <Body>{t(statusMessage(ride.status))}</Body>
          <Button variant="dark" label={t('home.openRide')} onPress={() => onOpenRide(ride.id)} />
        </Card>
      ) : (
        <View style={[styles.scanPanel, { backgroundColor: c.tint }]}>
          <Body muted>{t('home.scanHint')}</Body>
          <Button testID="scan" label={t('home.scan')} onPress={onScan} />
        </View>
      )}
      <Title>{t('home.nearby')}</Title>
      {appConfig.mapboxToken ? null : <Body muted>{t('home.mapUnavailable')}</Body>}
      {locationDenied ? <Body muted>{t('home.locationDenied')}</Body> : null}
      <ErrorBanner message={error} />
      {nearby?.length === 0 ? <Body muted>{t('home.noNearby')}</Body> : null}
      {nearby?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.carousel}>
            {nearby.map((s) => (
              <View
                key={s.code}
                style={[styles.scooter, { backgroundColor: c.surface, borderColor: c.border }]}
              >
                <Text style={[styles.code, { color: c.text, fontFamily: fonts.bold }]}>
                  {s.code}
                </Text>
                <Text style={{ color: c.muted, fontFamily: fonts.regular }}>
                  {formatDistance(s.distanceM)}
                </Text>
                {s.batteryPercent !== null ? <Battery percent={s.batteryPercent} /> : null}
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scanPanel: { borderRadius: 14, padding: 16, gap: 12 },
  carousel: { flexDirection: 'row', gap: 12, paddingBottom: 8 },
  scooter: {
    width: 150,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    gap: 6,
  },
  code: { fontSize: 16, fontWeight: '700' },
});
