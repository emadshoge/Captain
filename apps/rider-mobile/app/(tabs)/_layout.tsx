import { Redirect, Tabs } from 'expo-router';
import { useTheme } from '../../src/components/ui';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionContext';

export default function TabsLayout() {
  const { status } = useSession();
  const c = useTheme();
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.muted,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
        headerStyle: { backgroundColor: c.surface },
        headerTintColor: c.text,
        sceneStyle: { backgroundColor: c.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabs.ride') }} />
      <Tabs.Screen name="wallet" options={{ title: t('tabs.wallet') }} />
      <Tabs.Screen name="history" options={{ title: t('tabs.history') }} />
      <Tabs.Screen name="account" options={{ title: t('tabs.account') }} />
    </Tabs>
  );
}
