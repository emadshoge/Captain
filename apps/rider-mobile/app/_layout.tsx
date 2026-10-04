import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { appConfig } from '../src/config';
import { detectLocale, t } from '../src/i18n';
import { SessionProvider } from '../src/session/SessionContext';
import { secureTokenStore } from '../src/session/secure-store';

detectLocale();

export default function RootLayout() {
  return (
    <SessionProvider baseUrl={appConfig.apiUrl} store={secureTokenStore}>
      <Stack screenOptions={{ title: t('app.name') }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: t('signIn.title') }} />
        <Stack.Screen name="scan" options={{ title: t('scan.title'), presentation: 'modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </SessionProvider>
  );
}
