import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { useMarketTheme } from './theme';

export function MarketText({ children, variant = 'body' }: { children: ReactNode; variant?: 'body' | 'muted' | 'eyebrow' | 'title' | 'heading' }) {
  const { colors } = useMarketTheme();
  const styles = {
    body: { fontSize: 16, lineHeight: 25, color: colors.ink },
    muted: { fontSize: 15, lineHeight: 23, color: colors.muted },
    eyebrow: { fontSize: 12, lineHeight: 18, color: colors.primary, fontWeight: '700' as const, letterSpacing: 1.5, textTransform: 'uppercase' as const },
    title: { fontSize: 38, lineHeight: 44, color: colors.ink, fontWeight: '700' as const, letterSpacing: -1 },
    heading: { fontSize: 22, lineHeight: 29, color: colors.ink, fontWeight: '700' as const },
  };
  return <Text style={styles[variant]}>{children}</Text>;
}

export function MarketButton({ label, onPress, variant = 'primary', disabled = false }: { label: string; onPress: () => void; variant?: 'primary' | 'secondary'; disabled?: boolean }) {
  const { colors } = useMarketTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.primary, backgroundColor: variant === 'primary' ? colors.primary : colors.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={{ color: variant === 'primary' ? colors.onPrimary : colors.primary, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{label}</Text>
  </Pressable>;
}

export function MarketCard({ children }: { children: ReactNode }) {
  const { colors } = useMarketTheme();
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 22, padding: 24, gap: 12 }}>{children}</View>;
}

export function MarketField({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const { colors } = useMarketTheme();
  return <View style={{ gap: 8 }}><Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>{label}</Text><TextInput {...props} accessibilityLabel={props.accessibilityLabel ?? label} accessibilityState={{ ...props.accessibilityState, disabled: props.editable === false }} placeholderTextColor={colors.muted} style={[{ minHeight: 48, borderWidth: 1, borderColor: error ? colors.danger : colors.border, borderRadius: 12, backgroundColor: colors.surface, color: colors.ink, paddingHorizontal: 14, fontSize: 16 }, props.style]} />{error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>{error}</Text> : null}</View>;
}

export function MarketStatus({ kind, title, message, action }: { kind: 'loading' | 'empty' | 'error'; title: string; message?: string; action?: ReactNode }) {
  const { colors } = useMarketTheme();
  return <View accessibilityRole={kind === 'error' ? 'alert' : undefined} style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
    {kind === 'loading' ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" /> : null}
    <Text style={{ color: colors.ink, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>{title}</Text>
    {message ? <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23, textAlign: 'center' }}>{message}</Text> : null}{action}
  </View>;
}

export function MarketHeader({ subtitle }: { subtitle?: string }) {
  const { name, colors } = useMarketTheme();
  return <View style={{ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <View accessible={false} style={{ width: 42, height: 42, borderRadius: 15, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 18, fontWeight: '700' }}>{name.charAt(0)}</Text></View>
    <View style={{ flex: 1 }}><Text style={{ color: colors.ink, fontSize: 17, fontWeight: '700' }}>{name}</Text>{subtitle ? <Text style={{ color: colors.muted, fontSize: 12, marginTop: 2 }}>{subtitle}</Text> : null}</View>
  </View>;
}

export function MarketNavigation({ items }: { items: { label: string; onPress: () => void; selected?: boolean }[] }) {
  const { colors } = useMarketTheme();
  return <View accessibilityRole="tablist" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{items.map(item => <Pressable key={item.label} accessibilityRole="tab" accessibilityState={{ selected: !!item.selected }} onPress={item.onPress} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12, backgroundColor: item.selected ? colors.tint : 'transparent' }}><Text style={{ color: item.selected ? colors.primary : colors.muted, fontWeight: '700' }}>{item.label}</Text></Pressable>)}</View>;
}
