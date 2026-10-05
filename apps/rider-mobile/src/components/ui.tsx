import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
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

// Design tokens from the owner-supplied reference UI (R-93): navy, green,
// teal and coral palette; Avenir Next where the platform ships it. Text on
// green/coral is navy (white on #38ca89 is 2.1:1, below WCAG AA).
export const palette = {
  light: {
    bg: '#f6f8fa',
    surface: '#ffffff',
    text: '#1a2232',
    muted: '#626b7b',
    primary: '#38ca89',
    accent: '#2ec4c8',
    dark: '#1a2232',
    danger: '#ff5a64',
    dangerText: '#c8303d',
    warn: '#a35c00',
    onPrimary: '#1a2232',
    border: '#e3e8ee',
    tint: '#e8f8f0',
  },
  dark: {
    bg: '#121926',
    surface: '#1a2232',
    text: '#f5f7fa',
    muted: '#a0a9b8',
    primary: '#38ca89',
    accent: '#2ec4c8',
    dark: '#f5f7fa',
    danger: '#ff6b74',
    dangerText: '#ff8a91',
    warn: '#fbbf24',
    onPrimary: '#1a2232',
    border: '#2c3649',
    tint: '#163a2c',
  },
};

export type Theme = (typeof palette)['light'];

/** Avenir Next ships with iOS; elsewhere the system font is used. */
export const fonts = {
  regular: Platform.select({ ios: 'AvenirNext-Regular', default: undefined }),
  medium: Platform.select({ ios: 'AvenirNext-Medium', default: undefined }),
  bold: Platform.select({ ios: 'AvenirNext-Bold', default: undefined }),
};

export function useTheme(): Theme {
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
    <Text
      accessibilityRole="header"
      style={[styles.title, { color: c.text, fontFamily: fonts.bold }]}
    >
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
  const color =
    tone === 'danger' ? c.dangerText : tone === 'warn' ? c.warn : muted ? c.muted : c.text;
  return <Text style={[styles.body, { color, fontFamily: fonts.regular }]}>{children}</Text>;
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
  variant?: 'primary' | 'secondary' | 'dark' | 'outline' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
}) {
  const c = useTheme();
  const bg = {
    primary: c.primary,
    danger: c.danger,
    dark: c.dark,
    secondary: c.surface,
    outline: 'transparent',
  }[variant];
  const fg = {
    primary: c.onPrimary,
    danger: c.onPrimary,
    dark: c.bg,
    secondary: c.text,
    outline: c.text,
  }[variant];
  const borderColor = variant === 'outline' ? c.primary : variant === 'secondary' ? c.border : bg;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, borderColor, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg, fontFamily: fonts.bold }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const c = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: c.muted, fontFamily: fonts.medium }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        style={[
          styles.input,
          {
            color: c.text,
            borderColor: c.border,
            backgroundColor: c.surface,
            fontFamily: fonts.regular,
          },
          style,
        ]}
        {...rest}
      />
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      {children}
    </View>
  );
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
      <Text style={{ color: c.muted, fontFamily: fonts.regular }}>{label}</Text>
      <Text style={{ color: c.text, fontWeight: '600', fontFamily: fonts.medium }}>{value}</Text>
    </View>
  );
}

/** Small label/value column, as in the trip summary ("Distance · Spend · Power"). */
export function Stat({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const c = useTheme();
  return (
    <View style={styles.stat} testID={testID}>
      <Text style={[styles.statLabel, { color: c.muted, fontFamily: fonts.regular }]}>{label}</Text>
      <Text style={[styles.statValue, { color: c.text, fontFamily: fonts.bold }]}>{value}</Text>
    </View>
  );
}

/** Battery level in the brand green, amber below 30 %, coral below 15 %. */
export function Battery({ percent }: { percent: number }) {
  const c = useTheme();
  const color = percent < 15 ? c.danger : percent < 30 ? c.warn : c.primary;
  return (
    <View style={styles.batteryRow} accessibilityLabel={t('home.battery', { percent })}>
      <View style={[styles.batteryShell, { borderColor: c.border }]}>
        <View
          style={[
            styles.batteryFill,
            { backgroundColor: color, width: `${Math.max(4, Math.min(100, percent))}%` },
          ]}
        />
      </View>
      <Text style={{ color: c.muted, fontSize: 13, fontFamily: fonts.medium }}>{percent}%</Text>
    </View>
  );
}

/** Captain wordmark: green rounded square with the initial, then the name. */
export function Brand() {
  const c = useTheme();
  return (
    <View style={styles.brand}>
      <View style={[styles.brandMark, { backgroundColor: c.primary }]}>
        <Text style={[styles.brandInitial, { color: c.onPrimary, fontFamily: fonts.bold }]}>C</Text>
      </View>
      <Text style={[styles.brandName, { color: c.text, fontFamily: fonts.bold }]}>
        {t('app.name')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  inner: { padding: 16, gap: 14 },
  title: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  button: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 16, fontWeight: '700' },
  field: { gap: 6 },
  label: { fontSize: 14 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 17 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 10,
    shadowColor: '#1a2232',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  badge: { borderWidth: 1, borderRadius: 8, padding: 6, gap: 2, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { flex: 1, gap: 2 },
  statLabel: { fontSize: 12 },
  statValue: { fontSize: 16, fontWeight: '700' },
  batteryRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  batteryShell: { width: 28, height: 12, borderWidth: 1, borderRadius: 3, padding: 1 },
  batteryFill: { height: '100%', borderRadius: 2 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandMark: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandInitial: { fontSize: 18, fontWeight: '800' },
  brandName: { fontSize: 22, fontWeight: '700' },
});
