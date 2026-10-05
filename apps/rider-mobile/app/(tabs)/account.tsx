import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Body, Brand, Button, Screen, fonts, useTheme } from '../../src/components/ui';
import { appConfig } from '../../src/config';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionContext';

function MenuItem({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.item,
        { borderBottomColor: c.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.itemText, { color: c.text, fontFamily: fonts.medium }]}>{label}</Text>
      <Text style={{ color: c.muted }}>›</Text>
    </Pressable>
  );
}

export default function Account() {
  const { signOut } = useSession();
  return (
    <Screen>
      <Brand />
      <View>
        <MenuItem label={t('account.history')} onPress={() => router.navigate('/history')} />
        <MenuItem label={t('account.wallet')} onPress={() => router.navigate('/wallet')} />
      </View>
      <Body muted>{t('account.environment', { env: appConfig.appEnv })}</Body>
      <Button
        label={t('account.signOut')}
        variant="secondary"
        onPress={() => void signOut().then(() => router.replace('/sign-in'))}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemText: { fontSize: 16 },
});
