import type { AppAudience, BusinessSlug } from '@market/core';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { MarketCard, MarketHeader, MarketText } from './components';
import { useMarketTheme } from './theme';
import { CustomerArea } from './CustomerArea';

export function MarketApplication({ businessId, audience }: { businessId: BusinessSlug; audience: AppAudience }) {
  const { colors } = useMarketTheme();
  const { width } = useWindowDimensions();
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
    <View style={{ width: '100%', maxWidth: 1120, alignSelf: 'center', paddingHorizontal: width >= 760 ? 40 : 20, flex: 1 }}>
      <MarketHeader subtitle={audience === 'admin' ? 'Management' : 'Welcome'} />
      {audience === 'customer' ? <CustomerArea key={businessId} businessId={businessId} /> : <View style={{ paddingVertical: 40 }}><MarketCard><MarketText variant="heading">Management</MarketText><MarketText variant="muted">Management tools will be available here as they’re ready.</MarketText></MarketCard></View>}
    </View>
  </ScrollView>;
}
