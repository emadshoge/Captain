import { Redirect } from 'expo-router';
import { Body, Screen } from '../src/components/ui';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionContext';

export default function Index() {
  const { status } = useSession();
  if (status === 'loading') {
    return (
      <Screen>
        <Body muted>{t('common.loading')}</Body>
      </Screen>
    );
  }
  return <Redirect href={status === 'signedIn' ? '/(tabs)' : '/sign-in'} />;
}
