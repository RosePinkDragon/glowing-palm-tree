import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BusinessSlug } from '@market/core';
import { addDeliveryAddressPrompt } from './address-model';
import { brandLogos } from './brand-logos';
import { MarketIcon } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';

const hidden = { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;
// Short brand lines come from the owner's design (pages 1-3); nothing here promises ratings, times, offers or food.
/** Where both restaurants are; shown on the welcome screen and the Help footer. */
export const brandPlace = 'Khed, Ratnagiri';
const welcomeCopy: Record<BusinessSlug, { eyebrow: string; line: string }> = {
  'ammu-sammu': { eyebrow: brandPlace, line: 'Home-style food delivered around Khed. Pay cash when it arrives.' },
  'kokani-dine-inn': { eyebrow: 'Taste of Kokan', line: 'Seafood and Malvani classics, delivered across Khed.' },
};
const welcomeTimeoutMs = 1500;
export const welcomeKey = (businessId: BusinessSlug) => `market:welcome:${businessId}`;

/** First launch only: `checking` until storage answers; a storage failure never blocks the app. */
export function useWelcome(businessId: BusinessSlug) {
  const [state, setState] = useState<'checking' | 'show' | 'done'>('checking');
  useEffect(() => {
    let active = true;
    setState('checking');
    // If storage hangs, stop waiting and show the menu (never a blank screen, and no welcome that could reappear every launch).
    const timer = setTimeout(() => { if (active) setState(current => current === 'checking' ? 'done' : current); }, welcomeTimeoutMs);
    AsyncStorage.getItem(welcomeKey(businessId)).then(value => { if (active) setState(current => current === 'checking' ? (value ? 'done' : 'show') : current); }).catch(() => { if (active) setState('done'); });
    return () => { active = false; clearTimeout(timer); };
  }, [businessId]);
  const dismiss = () => { setState('done'); void AsyncStorage.setItem(welcomeKey(businessId), '1').catch(() => {}); };
  return { state, dismiss };
}

/** The restaurant's original logo inside a round avatar, scaled to fit with its own aspect ratio. */
export function BrandAvatar({ size, label }: { size: number; label?: string }) {
  const { businessId, colors } = useMarketTheme();
  const logo = brandLogos[businessId];
  const box = businessId === 'ammu-sammu' ? size : Math.round(size * 0.78);
  const scale = box / Math.max(logo.width, logo.height);
  const art = <SvgXml xml={logo.xml} width={Math.round(logo.width * scale)} height={Math.round(logo.height * scale)} />;
  const circle = { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' as const, alignItems: 'center' as const, justifyContent: 'center' as const, backgroundColor: colors.background };
  return label ? <View accessible accessibilityRole="image" accessibilityLabel={label} style={circle}>{art}</View> : <View {...hidden} style={circle}>{art}</View>;
}

/** Menu top bar: logo avatar, the selected delivery address (or a prompt) and the account control. */
export function CustomerTopBar({ line, onAddress, account }: { line: string; onAddress: () => void; account: ReactNode }) {
  const { colors, name, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const dark = statusHeader === 'band';
  const ink = dark ? '#FFFFFF' : colors.ink, soft = dark ? colors.bandAccent : colors.muted;
  const prompt = line === addDeliveryAddressPrompt;
  return <View style={{ backgroundColor: dark ? colors.band : colors.background, borderBottomWidth: dark ? 0 : 1, borderBottomColor: colors.border, paddingTop: insets.top }}>
    <View style={{ width: '100%', maxWidth: 1120, alignSelf: 'center', minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
      <BrandAvatar size={44} label={name} />
      <Pressable accessibilityRole="button" accessibilityLabel={prompt ? addDeliveryAddressPrompt : `Delivery address: ${line}. Manage saved addresses`} onPress={onAddress} style={{ flex: 1, minHeight: 44, justifyContent: 'center' }}>
        <Text numberOfLines={1} style={{ color: soft, fontSize: 12, lineHeight: 16, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>Deliver to</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <MarketIcon name="pin" color={ink} size={16} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '600' as const }) }}>{line}</Text>
        </View>
      </Pressable>
      {account}
    </View>
  </View>;
}

/** First-launch welcome (design p. 1-3): brand hero, short honest copy and one action into the menu. */
export function BrandWelcome({ onContinue }: { onContinue: () => void }) {
  const { businessId, colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const { width } = useWindowDimensions();
  const copy = welcomeCopy[businessId];
  const wide = width >= 760;
  return <SafeAreaProvider><WelcomeBody onContinue={onContinue} copy={copy} wide={wide} name={name} colors={colors} fonts={fonts} /></SafeAreaProvider>;
}

function WelcomeBody({ onContinue, copy, wide, name, colors, fonts }: { onContinue: () => void; copy: { eyebrow: string; line: string }; wide: boolean; name: string; colors: ReturnType<typeof useMarketTheme>['colors']; fonts: ReturnType<typeof useMarketFonts> }) {
  const insets = useSafeAreaInsets();
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ backgroundColor: colors.band, paddingTop: insets.top + 32, paddingBottom: 56, paddingHorizontal: 24, alignItems: wide ? 'center' : 'flex-start', gap: 16 }}>
      <View style={{ width: '100%', maxWidth: 560, gap: 16 }}>
        <View style={{ alignSelf: wide ? 'center' : 'flex-end' }}><BrandAvatar size={wide ? 168 : 132} /></View>
        <Text style={{ color: colors.bandAccent, fontSize: 12, lineHeight: 18, letterSpacing: 2, textTransform: 'uppercase', textAlign: wide ? 'center' : 'left', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{copy.eyebrow}</Text>
        <Text accessibilityRole="header" style={{ color: '#FFFFFF', fontSize: wide ? 52 : 44, lineHeight: wide ? 62 : 52, textAlign: wide ? 'center' : 'left', ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{name}</Text>
        <Text style={{ color: '#FFFFFF', fontSize: 17, lineHeight: 26, textAlign: wide ? 'center' : 'left', ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{copy.line}</Text>
      </View>
    </View>
    <View style={{ flex: 1, backgroundColor: colors.background, borderTopLeftRadius: 28, borderTopRightRadius: 28, marginTop: -28, paddingHorizontal: 24, paddingTop: 32, paddingBottom: insets.bottom + 32, alignItems: 'center' }}>
      <View style={{ width: '100%', maxWidth: 560, gap: 16 }}>
        <Pressable accessibilityRole="button" onPress={onContinue} style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, opacity: pressed ? 0.85 : 1 })}>
          <Text style={{ color: colors.onPrimary, fontSize: 17, lineHeight: 24, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>Browse the menu</Text>
        </Pressable>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center', ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>You can sign in later, when you are ready to order.</Text>
      </View>
    </View>
  </ScrollView>;
}
