import type { AppAudience, BusinessSlug } from '@market/core';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { MarketCard, MarketHeader, MarketText } from './components';
import { MarketThemeProvider, useMarketTheme } from './theme';

export * from './components';
export * from './theme';

function Welcome({ audience }: { audience: AppAudience }) {
  const { colors, name } = useMarketTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ flexGrow: 1 }}>
    <View style={{ width: '100%', maxWidth: 1120, alignSelf: 'center', paddingHorizontal: wide ? 40 : 24, flex: 1 }}>
      <MarketHeader subtitle={audience === 'admin' ? 'Management' : 'Welcome'} />
      <View style={{ flex: 1, justifyContent: 'center', paddingVertical: wide ? 72 : 40, gap: 32, flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch' }}>
        <View style={{ flex: wide ? 1 : undefined, gap: 20, maxWidth: 560 }}>
          <MarketText variant="eyebrow">{audience === 'admin' ? 'Your workspace' : 'A warm welcome'}</MarketText>
          <MarketText variant="title">{audience === 'admin' ? `Welcome to ${name}` : `Good food starts here.`}</MarketText>
          <MarketText variant="body">{audience === 'admin' ? 'A home for managing your business, coming together here.' : `Welcome to ${name}. We’re preparing a space for you to explore what’s on the menu.`}</MarketText>
          <View style={{ alignSelf: 'flex-start', borderRadius: 30, paddingHorizontal: 14, paddingVertical: 9, backgroundColor: colors.tint }}><Text style={{ color: colors.primary, fontSize: 13, fontWeight: '700' }}>Coming soon</Text></View>
        </View>
        <View style={{ flex: wide ? 1 : undefined, width: '100%', maxWidth: 440, alignSelf: 'center' }}>
          <View accessible={false} style={{ height: wide ? 280 : 210, backgroundColor: colors.tint, borderTopLeftRadius: 120, borderTopRightRadius: 120, borderBottomLeftRadius: 24, borderBottomRightRadius: 24, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            <View style={{ width: 164, height: 164, borderRadius: 82, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 12, borderColor: colors.accent }}><View style={{ width: 94, height: 94, borderRadius: 47, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: colors.onPrimary, fontSize: 38, fontWeight: '700' }}>{name.charAt(0)}</Text></View></View>
          </View>
          <View style={{ marginTop: 16 }}><MarketCard><MarketText variant="heading">{audience === 'admin' ? 'Your business, in one place' : 'Made for the table'}</MarketText><MarketText variant="muted">{audience === 'admin' ? 'Management tools will be available here as they’re ready.' : 'Our menu and ordering experience are being prepared. Please check back soon.'}</MarketText></MarketCard></View>
        </View>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 22 }}><MarketText variant="muted">{name}</MarketText></View>
    </View>
  </ScrollView>;
}

export function MarketApp({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  return <MarketThemeProvider businessId={businessId}><Welcome audience={audience} /></MarketThemeProvider>;
}
