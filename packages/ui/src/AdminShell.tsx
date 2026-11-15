import type { ReactNode } from 'react';
import type { BusinessSlug } from '@market/core';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AdminArea } from './AdminArea';
import { AuthPanel } from './AuthPanel';
import { MarketButton, MarketStatus, MarketText } from './components';
import { BrandLogo, OwnerFrame, useOwnerHorizontalPadding } from './OwnerShell';
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
      ? <AdminArea key={`${market.session?.user.id ?? 'demo'}:${market.identityVersion}`} services={market.services} banner={banner} account={account} />
      : <SignedOut banner={banner} account={account} />}
  </OwnerFrame>;
}

// Signed-out owners see only the branded sign-in; navigation appears after sign-in and server access check.
// Phone/WhatsApp login (#50) replaces the email form here once it exists.
function SignedOut({ banner, account }: { banner: ReactNode; account: ReactNode }) {
  const { colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const padding = useOwnerHorizontalPadding();
  const column = { width: '100%' as const, maxWidth: 560, alignSelf: 'center' as const, paddingHorizontal: padding };
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ backgroundColor: colors.ink, paddingTop: insets.top + 32, paddingBottom: 56 }}>
      <View style={[column, { gap: 14, alignItems: 'flex-start' }]}>
        <BrandLogo height={64} />
        <View style={{ borderWidth: 1, borderColor: colors.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 3 }}><Text style={{ color: colors.accent, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>OWNERS</Text></View>
        <Text accessibilityRole="header" style={{ color: colors.background, fontSize: 34, lineHeight: 42, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{name} kitchen</Text>
      </View>
    </View>
    <View style={{ flexGrow: 1, marginTop: -24, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: colors.background, paddingTop: 24, paddingBottom: insets.bottom + 24 }}>
      <View style={[column, { gap: 20 }]}>
        {banner}
        {account}
        <View style={{ borderRadius: 14, backgroundColor: colors.tint, padding: 16 }}><MarketText variant="muted">{`This app is for ${name}'s owners. Customers order from the ${name} app.`}</MarketText></View>
      </View>
    </View>
  </ScrollView>;
}
