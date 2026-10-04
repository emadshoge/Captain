import { router } from 'expo-router';
import { Body, Button, Screen } from '../../src/components/ui';
import { appConfig } from '../../src/config';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionContext';

export default function Account() {
  const { signOut } = useSession();
  return (
    <Screen>
      <Body muted>{t('account.environment', { env: appConfig.appEnv })}</Body>
      <Button
        label={t('account.signOut')}
        variant="secondary"
        onPress={() => void signOut().then(() => router.replace('/sign-in'))}
      />
    </Screen>
  );
}
