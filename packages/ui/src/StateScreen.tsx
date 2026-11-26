import { Text, View } from 'react-native';
import { MarketButton } from './components';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { offlineBarText } from './states-model';
import { useMarketFonts, useMarketTheme } from './theme';

/**
 * A "nothing here" or "can't load" screen (customer pp. 12, 13, 15, 16): a round icon (filled tint for Ammu Sammu, a gold ring for Kokani Dine Inn),
 * a heading in the brand's heading font, a short plain message and one button. `card` is the dashed box used inside the account drawer and address lists.
 */
export function StateScreen({ icon, title, message, action, onAction, card = false, level = 2 }: { icon: MarketIconName; title: string; message: string; action?: string; onAction?: () => void; card?: boolean; level?: 1 | 2 | 3 }) {
  const { colors, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const ring = statusHeader === 'band';
  const size = card ? 64 : 92;
  const box = card ? { borderWidth: 1, borderStyle: 'dashed' as const, borderColor: ring ? colors.accent : colors.inputBorder, borderRadius: 16, padding: 24, backgroundColor: colors.surface } : { paddingVertical: 40, paddingHorizontal: 12 };
  return <View style={{ alignItems: 'center', gap: 14, width: '100%', maxWidth: 460, alignSelf: 'center', ...box }}>
    <View accessible={false} aria-hidden style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: ring ? 'transparent' : colors.tint, borderWidth: ring ? 1 : 0, borderColor: colors.accent }}>
      <MarketIcon name={icon} color={colors.primary} size={card ? 30 : 42} />
    </View>
    <Text accessibilityRole="header" aria-level={level} style={{ color: colors.ink, fontSize: card ? 22 : 26, lineHeight: card ? 29 : 34, textAlign: 'center', ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>
    <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23, textAlign: 'center', ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{message}</Text>
    {action && onAction ? <MarketButton label={action} onPress={onAction} /> : null}
  </View>;
}

/**
 * The "You're offline" bar. The status region is always mounted, so a screen reader announces the bar when it appears and when it goes;
 * it holds no height while online. Colours are the brand's notice colours (dark brown for Ammu Sammu, gold for Kokani Dine Inn).
 */
export function OfflineBar({ offline }: { offline: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <View role="status" accessibilityLiveRegion="polite" nativeID="offline-bar">
    {offline ? <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: colors.notice }}>
      <MarketIcon name="offline" color={colors.onNotice} size={20} />
      <Text style={{ color: colors.onNotice, fontSize: 16, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{offlineBarText}</Text>
    </View> : null}
  </View>;
}
