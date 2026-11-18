import type { ReactNode } from 'react';
import type { BusinessSlug } from '@market/core';
import { ScrollView, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AdminArea } from './AdminArea';
import { AuthPanel } from './AuthPanel';
import { MarketButton, MarketStatus, MarketText } from './components';
import { OwnerFrame, useOwnerHorizontalPadding } from './OwnerShell';
import { BrandLogo } from './BrandLogo';
import { useMarketFonts, useMarketTheme } from './theme';
import { useMarket } from './useMarket';

export function AdminShell({ businessId }: { businessId: BusinessSlug }) {
  const market = useMarket(businessId, 'admin');
  const demo = market.services.mode === 'demo';
  const signedIn = demo || (market.session && !market.recovery);
  const banner = <>
    {market.notice ? <MarketText>{market.notice}</MarketText> : null}
    {market.error ? <MarketStatus kind="error" title="Could not load management" message={market.error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void market.load()} />} /> : null}
  </>;
  const account = !demo ? <AuthPanel key={market.identityVersion} market={market} /> : null;
  return <OwnerFrame>
    {signedIn
      ? <AdminArea key={`${market.session?.user.id ?? 'demo'}:${market.identityVersion}`} services={market.services} market={demo ? undefined : market} banner={banner} account={account} />
      : <SignedOut banner={banner} account={account} />}
  </OwnerFrame>;
}

// Signed-out owners see only the branded sign-in; navigation appears after sign-in and server access check.
// Phone/WhatsApp login (#50) replaces the email form here once it exists.
function SignedOut({ banner, account }: { banner: ReactNode; account: ReactNode }) {
  const { colors, name, ownerHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const padding = useOwnerHorizontalPadding();
  const column = { width: '100%' as const, maxWidth: 560, alignSelf: 'center' as const, paddingHorizontal: padding };
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ backgroundColor: colors.loginHero, paddingTop: insets.top + 56, paddingBottom: 72 }}>
      <View style={[column, { gap: 16, alignItems: 'flex-start' }]}>
        <BrandLogo height={72} />
        <View style={{ borderWidth: 1, borderColor: ownerHeader === 'dark' ? colors.accent : colors.primary, backgroundColor: ownerHeader === 'dark' ? 'transparent' : colors.primary, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 3 }}><Text style={{ color: ownerHeader === 'dark' ? colors.accent : colors.onPrimary, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>OWNERS</Text></View>
        <Text accessibilityRole="header" style={{ color: colors.background, fontSize: 34, lineHeight: 42, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{name} kitchen</Text>
      </View>
    </View>
    <View style={{ flexGrow: 1, marginTop: -24, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: colors.background, paddingTop: 24, paddingBottom: insets.bottom + 24 }}>
      <View style={[column, { gap: 20, flexGrow: 1 }]}>
        {banner}
        {account}
        <View style={{ flexGrow: 1, minHeight: 24 }} />
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderRadius: 14, backgroundColor: colors.tint, padding: 16 }}>
          <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ paddingTop: 2 }}><Svg width={18} height={18} viewBox="0 0 24 24"><Rect x={5} y={11} width={14} height={10} rx={2} stroke={colors.primary} strokeWidth={2} fill="none" /><Path d="M8 11V8a4 4 0 0 1 8 0v3" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" fill="none" /></Svg></View>
          <View style={{ flex: 1 }}><MarketText variant="muted">{`This app is for ${name}'s owners. Customers order from the ${name} app.`}</MarketText></View>
        </View>
      </View>
    </View>
  </ScrollView>;
}
