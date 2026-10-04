import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, ErrorBanner, Field, Screen, Title } from '../components/ui';
import { t } from '../i18n';
import { useSession } from '../session/SessionContext';
import { messageFor } from '../useApi';

/** Passwordless sign-in: phone (SMS) or email one-time code. */
export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const { client, markSignedIn } = useSession();
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [destination, setDestination] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const challenge = await client.requestCode(channel, destination.trim());
      setChallengeId(challenge.challengeId);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await client.verifyCode(challengeId, code.trim());
      markSignedIn();
      onSignedIn();
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>{t('signIn.title')}</Title>
      {challengeId === null ? (
        <>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button
                label={t('signIn.phone')}
                variant={channel === 'sms' ? 'primary' : 'secondary'}
                onPress={() => setChannel('sms')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label={t('signIn.email')}
                variant={channel === 'email' ? 'primary' : 'secondary'}
                onPress={() => setChannel('email')}
              />
            </View>
          </View>
          <Field
            label={channel === 'sms' ? t('signIn.phone') : t('signIn.email')}
            placeholder={
              channel === 'sms' ? t('signIn.phonePlaceholder') : t('signIn.emailPlaceholder')
            }
            value={destination}
            onChangeText={setDestination}
            keyboardType={channel === 'sms' ? 'phone-pad' : 'email-address'}
            autoCapitalize="none"
            autoComplete={channel === 'sms' ? 'tel' : 'email'}
            testID="destination"
          />
          <ErrorBanner message={error} />
          <Button
            testID="send-code"
            label={t('signIn.sendCode')}
            onPress={send}
            busy={busy}
            disabled={destination.trim().length < 3}
          />
        </>
      ) : (
        <>
          <Body>{t('signIn.codeSent', { destination: destination.trim() })}</Body>
          <Field
            label={t('signIn.code')}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            testID="code"
          />
          <ErrorBanner message={error} />
          <Button
            testID="verify"
            label={t('signIn.verify')}
            onPress={verify}
            busy={busy}
            disabled={code.length !== 6}
          />
          <Button
            label={t('signIn.changeDestination')}
            variant="secondary"
            onPress={() => {
              setChallengeId(null);
              setCode('');
            }}
          />
        </>
      )}
    </Screen>
  );
}
