import type { AppAudience, BusinessSlug } from '@market/core';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { MarketHeader } from './components';
import { useMarketTheme } from './theme';
import { CustomerArea } from './CustomerArea';
import { AdminShell } from './AdminShell';

export function MarketApplication({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  const { colors } = useMarketTheme();
  const { width } = useWindowDimensions();
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ width: '100%', maxWidth: 1120, alignSelf: 'center', paddingHorizontal: width >= 760 ? 40 : 20, flex: 1 }}>
      <MarketHeader subtitle={audience === 'admin' ? 'Management' : 'Welcome'} />
      {audience === 'customer' ? <CustomerArea key={businessId} businessId={businessId} /> : <AdminShell key={businessId} businessId={businessId} />}
    </View>
  </ScrollView>;
}
