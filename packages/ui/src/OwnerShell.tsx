import type { ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';
import type { BusinessSlug } from '@market/core';
import { useBrandFonts } from './brand-fonts';
import { BrandLogo } from './BrandLogo';
import { formatBadgeCount, ownerTabAccessibilityLabel, ownerTabs, type OwnerTabId } from './owner-navigation';
import { MarketFontsProvider, useMarketFonts, useMarketTheme } from './theme';

const contentWidth = 960;
const hidden = { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

/** Root of an owners' app: active brand fonts, safe areas and the brand background. */
export function OwnerFrame({ children }: { children: ReactNode }) {
  const { businessId, colors } = useMarketTheme();
  const fonts = useBrandFonts(businessId);
  return <SafeAreaProvider><MarketFontsProvider value={fonts}><View style={{ flex: 1, backgroundColor: colors.background }}>{children}</View></MarketFontsProvider></SafeAreaProvider>;
}

export function useOwnerHorizontalPadding() { return useWindowDimensions().width >= 760 ? 40 : 20; }

/** Owner screen container for #58–#61: compact branded header, optional right slot and scrollable content. */
export function OwnerScreen({ title, headerRight, children }: { title: string; headerRight?: ReactNode; children: ReactNode }) {
  const { colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const padding = useOwnerHorizontalPadding();
  return <View style={{ flex: 1 }}>
    <View style={{ backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border, paddingTop: insets.top }}>
      <View style={{ width: '100%', maxWidth: contentWidth, alignSelf: 'center', minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: padding, paddingVertical: 10 }}>
        <BrandLogo height={38} label={title === name ? undefined : name} />
        <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 26, lineHeight: 34, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>
        {headerRight ? <View>{headerRight}</View> : null}
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: contentWidth, alignSelf: 'center', paddingHorizontal: padding, paddingVertical: 24, gap: 20 }}>{children}</ScrollView>
  </View>;
}

function TabIcon({ id, color }: { id: OwnerTabId; color: string }) {
  const stroke = { stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return <View {...hidden}><Svg width={24} height={24} viewBox="0 0 24 24">
    {id === 'orders' ? <Path {...stroke} d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" /> : null}
    {id === 'menu' ? <Path {...stroke} d="M5 4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5zM8.5 8h7M8.5 12h7M8.5 16h4" /> : null}
    {id === 'today' ? <Path {...stroke} d="M4 20h16M7 16v-4M12 16V6M17 16V9" /> : null}
    {id === 'settings' ? <><Path {...stroke} d="M4 7h9M17 7h3M4 17h3M11 17h9" /><Circle {...stroke} cx={15} cy={7} r={2} /><Circle {...stroke} cx={9} cy={17} r={2} /></> : null}
  </Svg></View>;
}

/**
 * Fixed bottom navigation for the owners' apps. `badges` is the count seam for later issues (#100):
 * zero or missing counts are hidden and large counts show 99+.
 */
export function OwnerTabBar({ selected, onSelect, badges }: { selected: OwnerTabId; onSelect: (id: OwnerTabId) => void; badges?: Partial<Record<OwnerTabId, number>> }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const web = Platform.OS === 'web';
  return <View style={{ backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: insets.bottom }}>
    <View accessibilityRole={web ? 'navigation' : 'tablist'} aria-label="Owner sections" style={{ width: '100%', maxWidth: 600, alignSelf: 'center', flexDirection: 'row' }}>
      {ownerTabs.map(tab => {
        const active = tab.id === selected;
        const badge = formatBadgeCount(badges?.[tab.id]);
        const color = active ? colors.primary : colors.muted;
        return <Pressable key={tab.id} accessibilityRole={web ? 'button' : 'tab'} accessibilityLabel={ownerTabAccessibilityLabel(tab.id, badges?.[tab.id])} accessibilityState={web ? undefined : { selected: active }} aria-current={web && active ? 'page' : undefined} onPress={() => onSelect(tab.id)} style={({ pressed }) => ({ flex: 1, minHeight: 64, alignItems: 'center', justifyContent: 'center', gap: 3, paddingTop: 4, paddingBottom: 8, opacity: pressed ? 0.7 : 1 })}>
          <View {...hidden} style={{ width: 28, height: 3, borderRadius: 2, marginBottom: 3, backgroundColor: active ? colors.primary : 'transparent' }} />
          <View>
            <TabIcon id={tab.id} color={color} />
            {badge ? <View {...hidden} style={{ position: 'absolute', top: -6, left: 14, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.primary, borderWidth: 1.5, borderColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 10, lineHeight: 13, fontWeight: '700' }}>{badge}</Text></View> : null}
          </View>
          <Text style={{ color, fontSize: 12, lineHeight: 16, ...(fonts.bodySemiBold ? { fontFamily: active ? fonts.bodyBold : fonts.bodySemiBold } : { fontWeight: active ? '700' as const : '600' as const }) }}>{tab.label}</Text>
        </Pressable>;
      })}
    </View>
  </View>;
}
