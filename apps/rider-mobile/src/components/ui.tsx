import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  useColorScheme,
} from 'react-native';
import { t } from '../i18n';

// Provisional design tokens (brand is an open decision, D-UI).
export const palette = {
  light: {
    bg: '#ffffff',
    surface: '#f3f4f6',
    text: '#111827',
    muted: '#6b7280',
    primary: '#0f766e',
    danger: '#b91c1c',
    warn: '#92400e',
    onPrimary: '#ffffff',
    border: '#d1d5db',
  },
  dark: {
    bg: '#0b0f14',
    surface: '#1f2937',
    text: '#f9fafb',
    muted: '#9ca3af',
    primary: '#2dd4bf',
    danger: '#f87171',
    warn: '#fbbf24',
    onPrimary: '#04201d',
    border: '#374151',
  },
};

export function useTheme() {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  const c = useTheme();
  const content = <View style={styles.inner}>{children}</View>;
  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{content}</ScrollView> : content}
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  muted,
  tone,
}: {
  children: ReactNode;
  muted?: boolean;
  tone?: 'danger' | 'warn';
}) {
  const c = useTheme();
  const color = tone === 'danger' ? c.danger : tone === 'warn' ? c.warn : muted ? c.muted : c.text;
  return <Text style={[styles.body, { color }]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const c = useTheme();
  const bg = variant === 'primary' ? c.primary : variant === 'danger' ? c.danger : c.surface;
  const fg = variant === 'secondary' ? c.text : c.onPrimary;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        style={[
          styles.input,
          { color: c.text, borderColor: c.border, backgroundColor: c.surface },
          style,
        ]}
        {...rest}
      />
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const c = useTheme();
  return <View style={[styles.card, { backgroundColor: c.surface }]}>{children}</View>;
}

/** Visible label for anything running against simulated hardware or test pricing. */
export function SimulatedBadge({
  simulated,
  devPricing,
}: {
  simulated?: boolean;
  devPricing?: boolean;
}) {
  const c = useTheme();
  if (!simulated && !devPricing) return null;
  return (
    <View style={[styles.badge, { borderColor: c.warn }]} testID="simulated-badge">
      {simulated ? (
        <Text style={[styles.badgeText, { color: c.warn }]}>{t('common.simulated')}</Text>
      ) : null}
      {devPricing ? (
        <Text style={[styles.badgeText, { color: c.warn }]}>{t('common.devPricing')}</Text>
      ) : null}
    </View>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Body tone="danger">{message}</Body>
    </View>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  const c = useTheme();
  return (
    <View style={styles.row}>
      <Text style={{ color: c.muted }}>{label}</Text>
      <Text style={{ color: c.text, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  inner: { padding: 16, gap: 12 },
  title: { fontSize: 26, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 48,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 17, fontWeight: '600' },
  field: { gap: 4 },
  label: { fontSize: 14 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: 17 },
  card: { borderRadius: 12, padding: 14, gap: 8 },
  badge: { borderWidth: 1, borderRadius: 8, padding: 6, gap: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
});
