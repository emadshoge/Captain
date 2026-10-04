import * as Location from 'expo-location';
import { useState } from 'react';
import type { Ride } from '../api/types';
import { Body, Button, ErrorBanner, Screen } from '../components/ui';
import { t } from '../i18n';
import type { RideAction } from '../ride/model';
import { shouldPoll } from '../ride/model';
import { RideCard } from '../ride/RideCard';
import { useSession } from '../session/SessionContext';
import { messageFor, useApi } from '../useApi';

async function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  try {
    const { granted } = await Location.getForegroundPermissionsAsync();
    if (!granted) return null;
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: position.coords.latitude, lng: position.coords.longitude };
  } catch {
    return null;
  }
}

/** Current ride, polled while the server or device may change its state. */
export function RideScreen({ rideId, onClose }: { rideId: string; onClose: () => void }) {
  const { client } = useSession();
  const [busy, setBusy] = useState<RideAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data: ride, error, setData } = useApi<Ride>(() => client.ride(rideId), [rideId], 3_000);

  async function act(action: RideAction) {
    if (!ride) return;
    setBusy(action);
    setActionError(null);
    try {
      const next =
        action === 'pause'
          ? await client.pause(ride.id)
          : action === 'resume'
            ? await client.resume(ride.id)
            : await client.endRide(ride.id, await currentPosition());
      setData(next);
    } catch (e) {
      setActionError(messageFor(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ride) {
    return (
      <Screen>
        {error ? <ErrorBanner message={error} /> : <Body muted>{t('common.loading')}</Body>}
      </Screen>
    );
  }
  return (
    <Screen>
      <RideCard ride={ride} onAction={(a) => void act(a)} busy={busy} />
      <ErrorBanner message={actionError ?? error} />
      {!shouldPoll(ride.status) ? <Button label={t('ride.done')} onPress={onClose} /> : null}
    </Screen>
  );
}
