import type { BusinessSlug } from '@market/core';
import { View } from 'react-native';
import { AdminArea } from './AdminArea';
import { AuthPanel } from './AuthPanel';
import { MarketButton, MarketStatus, MarketText } from './components';
import { useMarket } from './useMarket';

export function AdminShell({ businessId }: { businessId: BusinessSlug }) {
  const market = useMarket(businessId, 'admin');
  const demo = market.services.mode === 'demo';
  return <View style={{ paddingVertical: 28, gap: 20 }}>
    <MarketText variant="title">Management</MarketText>
    {market.notice ? <MarketText>{market.notice}</MarketText> : null}
    {market.error ? <MarketStatus kind="error" title="Could not load management" message={market.error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void market.load()} />} /> : null}
    {!demo ? <AuthPanel key={market.identityVersion} market={market} /> : null}
    {demo || (market.session && !market.recovery) ? <AdminArea key={`${market.session?.user.id ?? 'demo'}:${market.identityVersion}`} services={market.services} /> : null}
  </View>;
}
