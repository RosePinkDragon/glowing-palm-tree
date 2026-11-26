import { useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, Text, TextInput, View, type TextInputProps } from 'react-native';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';

// A brand family replaces the synthetic weight: each loaded family is already a specific weight.
const branded = <T extends object>(style: T, fontFamily?: string) => fontFamily ? { ...style, fontFamily, fontWeight: 'normal' as const } : style;

export function MarketText({ children, variant = 'body' }: { children: ReactNode; variant?: 'body' | 'muted' | 'eyebrow' | 'title' | 'heading' }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const styles = {
    body: { fontSize: 16, lineHeight: 25, color: colors.ink },
    muted: { fontSize: 15, lineHeight: 23, color: colors.muted },
    eyebrow: { fontSize: 12, lineHeight: 18, color: colors.primary, fontWeight: '700' as const, letterSpacing: 1.5, textTransform: 'uppercase' as const },
    title: { fontSize: 38, lineHeight: 44, color: colors.ink, fontWeight: '700' as const, letterSpacing: -1 },
    heading: { fontSize: 22, lineHeight: 29, color: colors.ink, fontWeight: '700' as const },
  };
  const family = variant === 'title' || variant === 'heading' ? fonts.heading : variant === 'eyebrow' ? fonts.bodyBold : fonts.body;
  return <Text style={branded(styles[variant], family)}>{children}</Text>;
}

export function MarketButton({ label, onPress, variant = 'primary', disabled = false, nativeID }: { label: string; onPress: () => void; variant?: 'primary' | 'secondary'; disabled?: boolean; nativeID?: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Pressable nativeID={nativeID} accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: colors.primary, backgroundColor: variant === 'primary' ? colors.primary : colors.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={branded({ color: variant === 'primary' ? colors.onPrimary : colors.primary, fontSize: 15, lineHeight: 22, fontWeight: '700' as const }, fonts.bodySemiBold)}>{label}</Text>
  </Pressable>;
}

export function MarketCard({ children }: { children: ReactNode }) {
  const { colors } = useMarketTheme();
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 22, padding: 24, gap: 12 }}>{children}</View>;
}

export function MarketField({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <View style={{ gap: 8 }}><Text style={branded({ color: colors.ink, fontSize: 15, fontWeight: '700' as const }, fonts.bodyBold)}>{label}</Text><TextInput {...props} accessibilityLabel={props.accessibilityLabel ?? label} accessibilityState={{ ...props.accessibilityState, disabled: props.editable === false }} placeholderTextColor={colors.muted} style={[{ minHeight: 48, borderWidth: 1, borderColor: error ? colors.danger : colors.inputBorder, borderRadius: 12, backgroundColor: colors.surface, color: colors.ink, paddingHorizontal: 14, fontSize: 16 }, props.style]} />{error ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>{error}</Text> : null}</View>;
}

export function MarketStatus({ kind, title, message, action }: { kind: 'loading' | 'empty' | 'error'; title: string; message?: string; action?: ReactNode }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <View accessibilityRole={kind === 'error' ? 'alert' : undefined} style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
    {kind === 'loading' ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading" /> : null}
    <Text style={branded({ color: colors.ink, fontSize: 18, fontWeight: '700' as const, textAlign: 'center' as const }, fonts.heading)}>{title}</Text>
    {message ? <Text style={branded({ color: colors.muted, fontSize: 15, lineHeight: 23, textAlign: 'center' as const }, fonts.body)}>{message}</Text> : null}{action}
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
  const fonts = useMarketFonts();
  return <View accessibilityRole="navigation" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{items.map(item => <Pressable key={item.label} accessibilityRole="button" accessibilityState={Platform.OS === 'web' ? undefined : { selected: !!item.selected }} aria-current={Platform.OS === 'web' && item.selected ? 'page' : undefined} onPress={item.onPress} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 12, backgroundColor: item.selected ? colors.tint : 'transparent' }}><Text style={branded({ color: item.selected ? colors.primary : colors.muted, fontWeight: '700' as const }, fonts.bodyBold)}>{item.label}</Text></Pressable>)}</View>;
}

/** A link styled as a 48px button. Web gets a real anchor (tel:/https:); native opens the URL through Linking. */
/** tone: primary (filled), secondary (ink on white), brand (brand-coloured text and border on white). */
export function MarketLinkButton({ label, name, href, tone = 'secondary', external, icon, compact = false }: { label: string; name?: string; href: string; tone?: 'primary' | 'secondary' | 'brand'; external?: boolean; icon?: MarketIconName; compact?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [failed, setFailed] = useState(false);
  const primary = tone === 'primary';
  const web = Platform.OS === 'web';
  return <View style={{ gap: 4 }}>
    <Text accessibilityRole="link" accessibilityLabel={name ?? label} {...(web ? ({ href, ...(external ? { hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {}) } as object) : { onPress: () => { setFailed(false); Linking.openURL(href).catch(() => setFailed(true)); } })}
      style={{ minHeight: 48, minWidth: 48, paddingHorizontal: compact ? 10 : 20, paddingVertical: 13, textAlign: 'center', borderRadius: 14, borderWidth: 1, borderColor: primary || tone === 'brand' ? colors.primary : colors.border, backgroundColor: primary ? colors.primary : colors.surface, overflow: 'hidden', color: primary ? colors.onPrimary : tone === 'brand' ? colors.primary : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{icon ? <><MarketIcon inline name={icon} color={primary ? colors.onPrimary : tone === 'brand' ? colors.primary : colors.ink} size={16} />{' '}</> : null}{label}</Text>
    {failed ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13 }}>Could not open this link on this device.</Text> : null}
  </View>;
}
