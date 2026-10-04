import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { newIdempotencyKey } from '../api/client';
import type { Pricing, ScooterLookup } from '../api/types';
import {
  Body,
  Button,
  Card,
  ErrorBanner,
  Field,
  Screen,
  SimulatedBadge,
  Title,
} from '../components/ui';
import { formatEtb, parseScooterQr } from '../format';
import { type MessageKey, t } from '../i18n';
import { useSession } from '../session/SessionContext';
import { messageFor } from '../useApi';

type Target = {
  by: { code: string } | { qr: string };
  scooter: ScooterLookup;
  pricing: Pricing | null;
};

/** QR scan (or manual code), availability check, price confirmation, start. */
export function ScanScreen({
  onStarted,
  showCamera = true,
}: {
  onStarted: (rideId: string) => void;
  showCamera?: boolean;
}) {
  const { client } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [code, setCode] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per confirmed start so a retry never starts a second ride.
  const startKey = useRef<string | null>(null);
  const scanning = useRef(false);

  async function find(by: { code: string } | { qr: string }) {
    setBusy(true);
    setError(null);
    try {
      const [scooter, pricing] = await Promise.all([
        client.lookup(by),
        client.pricing().catch(() => null),
      ]);
      setTarget({ by, scooter, pricing });
      startKey.current = newIdempotencyKey();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
      scanning.current = false;
    }
  }

  async function start() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const ride = await client.startRide(target.by, startKey.current ?? newIdempotencyKey());
      onStarted(ride.id);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>{t('scan.title')}</Title>
      {showCamera && !target ? (
        permission?.granted ? (
          <View style={{ height: 280, borderRadius: 12, overflow: 'hidden' }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (scanning.current) return;
                const qr = parseScooterQr(data);
                if (!qr) return;
                scanning.current = true;
                void find({ qr });
              }}
            />
          </View>
        ) : (
          <Card>
            <Body>{t('scan.permission')}</Body>
            <Button
              label={t('scan.allowCamera')}
              variant="secondary"
              onPress={() => void requestPermission()}
            />
          </Card>
        )
      ) : null}

      {!target ? (
        <>
          <Field
            label={t('scan.manual')}
            placeholder={t('scan.codePlaceholder')}
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            testID="scooter-code"
          />
          <ErrorBanner message={error} />
          <Button
            testID="find"
            label={t('scan.find')}
            onPress={() => void find({ code: code.trim() })}
            busy={busy}
            disabled={!code.trim()}
          />
        </>
      ) : (
        <Card>
          <Title>{t('scan.confirm', { code: target.scooter.code })}</Title>
          {target.pricing ? (
            <>
              <Body>
                {t('scan.priceLine', {
                  unlock: formatEtb(target.pricing.unlockFeeSantim),
                  perMinute: formatEtb(target.pricing.perMinuteSantim),
                })}
              </Body>
              <SimulatedBadge devPricing={target.pricing.isDevFixture} />
            </>
          ) : null}
          {target.scooter.batteryPercent !== null ? (
            <Body muted>{t('home.battery', { percent: target.scooter.batteryPercent })}</Body>
          ) : null}
          {target.scooter.available ? null : (
            <Body tone="warn">
              {t(
                `scan.unavailable.${target.scooter.unavailableReason ?? 'not_in_service'}` as MessageKey,
              )}
            </Body>
          )}
          <ErrorBanner message={error} />
          <Button
            testID="start-ride"
            label={t('scan.start')}
            onPress={() => void start()}
            busy={busy}
            disabled={!target.scooter.available}
          />
          <Button label={t('common.cancel')} variant="secondary" onPress={() => setTarget(null)} />
        </Card>
      )}
    </Screen>
  );
}
