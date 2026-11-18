import { Pressable, Text, View } from 'react-native';
import { useMarketFonts, useMarketTheme } from './theme';

// Shared owner chips and pills (#116). Colours come from theme tokens only; the
// contrast of every text/background pair is checked in theme-tokens.test.ts.

/** A selectable filter or day chip: 48px pill button, filled when selected, optional count. */
export function MarketChip({ label, selected, onPress, accessibilityLabel, count, radio = false, onDark = false }: {
  label: string; selected: boolean; onPress: () => void; accessibilityLabel?: string; count?: number;
  /** One choice of a group: a radio with aria-checked, for use inside a labelled radiogroup, instead of a pressed toggle button. */
  radio?: boolean;
  /** On the deep-green owners' header (#53): gold fill when selected, gold outline and light text otherwise. */
  onDark?: boolean;
}) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Pressable accessibilityRole={radio ? 'radio' : 'button'} accessibilityLabel={accessibilityLabel ?? label} {...(radio ? { 'aria-checked': selected } : { 'aria-pressed': selected })} accessibilityState={radio ? { checked: selected } : { selected }} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: 24, borderWidth: 1, borderColor: onDark ? colors.accent : selected ? colors.ink : colors.border, backgroundColor: onDark ? selected ? colors.accent : 'transparent' : selected ? colors.ink : colors.surface, opacity: pressed ? 0.85 : 1 })}>
    <Text numberOfLines={1} style={{ color: onDark ? selected ? colors.ownerHeader : colors.onOwnerHeader : selected ? colors.surface : colors.ink, fontSize: 14, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{label}</Text>
    {count ? <View aria-hidden style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: onDark ? selected ? colors.ownerHeader : colors.accent : selected ? colors.primary : colors.tint }}>
      <Text style={{ color: onDark ? selected ? colors.onOwnerHeader : colors.ownerHeader : selected ? colors.onPrimary : colors.primary, fontSize: 12, lineHeight: 16, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{count}</Text>
    </View> : null}
  </Pressable>;
}

export type PillTone = 'brand' | 'positive' | 'neutral' | 'quiet' | 'outline' | 'danger' | 'onDark' | 'info';

/**
 * A small status or label pill. Tones: brand (featured, order status), positive (Live),
 * neutral (currently unavailable), quiet (Paused, Connecting), outline (Sample), danger (Cancelled).
 * Pass `status` to make it a live status region with its own accessible name.
 * Place it in a row or content-sized parent: it sizes to its content and lets the parent align it.
 */
export function MarketPill({ label, tone, dot = false, star = false, status }: {
  label: string; tone: PillTone; dot?: boolean; star?: boolean; status?: string;
}) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const look = {
    brand: { bg: colors.tint, text: colors.primary, border: undefined, dot: colors.primary },
    positive: { bg: colors.positiveTint, text: colors.positive, border: undefined, dot: colors.switchOn },
    neutral: { bg: colors.neutralTint, text: colors.ink, border: undefined, dot: colors.ink },
    quiet: { bg: colors.neutralTint, text: colors.muted, border: undefined, dot: colors.muted },
    outline: { bg: colors.surface, text: colors.muted, border: colors.inputBorder, dot: colors.muted },
    onDark: { bg: 'transparent', text: colors.onOwnerHeader, border: colors.accent, dot: colors.liveDot },
    info: { bg: colors.infoTint, text: colors.info, border: undefined, dot: colors.info },
    danger: { bg: colors.background, text: colors.danger, border: colors.border, dot: colors.danger },
  }[tone];
  return <View {...(status ? { role: 'status' as const, 'aria-label': status } : {})}
    style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, minHeight: 24, borderRadius: 12, backgroundColor: look.bg, borderWidth: look.border ? 1 : 0, borderColor: look.border }}>
    {dot ? <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: look.dot }} /> : null}
    {star ? <Text accessible={false} aria-hidden style={{ fontSize: 11, color: look.text }}>★</Text> : null}
    <Text style={{ color: look.text, fontSize: 12, lineHeight: 18, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </View>;
}
