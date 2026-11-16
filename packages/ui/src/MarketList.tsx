import { Children, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useMarketFonts, useMarketTheme } from './theme';

// Shared owner list building blocks (#116). Two section styles from the owners' screens:
// MarketGroup (heading above a card of divided rows, p. 10) and MarketSection (heading inside
// a padded card, p. 5 and p. 11). MarketSection is the owners' tighter card (16px padding,
// 20 radius, muted section heading); MarketCard stays the roomier general-purpose card.
// MarketGroup: pass rows as direct children (not fragments); each child becomes one divided row.

function SectionHeading({ title }: { title: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Text accessibilityRole="header" aria-level={2} style={{ color: colors.muted, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{title}</Text>;
}

/** Heading above a bordered card whose rows are separated by dividers. */
export function MarketGroup({ title, children }: { title?: string; children: ReactNode }) {
  const { colors } = useMarketTheme();
  const rows = Children.toArray(children).filter(Boolean);
  return <View style={{ gap: 8 }}>
    {title ? <SectionHeading title={title} /> : null}
    <View style={{ backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}>
      {rows.map((row, index) => <View key={index} style={{ borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>{row}</View>)}
    </View>
  </View>;
}

/** Title, optional grey detail line, and an optional trailing control (switch, text, button). */
export function MarketRow({ title, detail, end }: { title: string; detail?: ReactNode; end?: ReactNode }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 16, paddingVertical: 10 }}>
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{title}</Text>
      {detail ? <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{detail}</Text> : null}
    </View>
    {end}
  </View>;
}

/** Padded card with its heading inside. */
export function MarketSection({ title, children }: { title?: string; children: ReactNode }) {
  const { colors } = useMarketTheme();
  return <View style={{ backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 10 }}>
    {title ? <SectionHeading title={title} /> : null}
    {children}
  </View>;
}

/** A label on the left and a value on the right, e.g. "2 × Veg thali   ₹360". */
export function MarketLine({ left, right, bold = false }: { left: ReactNode; right?: ReactNode; bold?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const style = { color: colors.ink, fontSize: 15, lineHeight: 22, ...(bold && fonts.bodyBold ? { fontFamily: fonts.bodyBold } : bold ? { fontWeight: '700' as const } : fonts.body ? { fontFamily: fonts.body } : {}) };
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <Text style={[style, { flex: 1 }]}>{left}</Text>
    {right !== undefined ? typeof right === 'string' || typeof right === 'number' ? <Text style={style}>{right}</Text> : right : null}
  </View>;
}
