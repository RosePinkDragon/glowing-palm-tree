import { View } from 'react-native';
import type { BusinessSlug } from '@market/core';
import type { Business } from '@market/services';
import { MarketButton, MarketCard, MarketText } from './components';

export const closedMessage = (slug: BusinessSlug) => slug === 'ammu-sammu'
  ? 'Not taking orders right now. You can still look at the menu. Check back a little later.'
  : "The kitchen isn't taking orders right now. Browse the menu and check back a little later.";

export function RestaurantNotice({ businessId, business, ready, error, retry, refused = false }: {
  businessId: BusinessSlug; business: Business | null; ready: boolean; error: string; retry: () => void; refused?: boolean;
}) {
  if (refused || (ready && business && !business.acceptingOrders)) return <MarketCard><View role="status" accessibilityLiveRegion="polite"><MarketText variant="heading">{closedMessage(businessId)}</MarketText><MarketText>Your saved cart is kept for later.</MarketText></View>{error ? <MarketButton label="Refresh restaurant status" variant="secondary" onPress={retry} /> : null}</MarketCard>;
  if (error) return <MarketCard><View role="status" accessibilityLiveRegion="polite"><MarketText variant="heading">Could not confirm whether the restaurant is taking orders</MarketText><MarketText>{error}</MarketText><MarketText>You can browse the menu. Your saved cart is kept.</MarketText></View><MarketButton label="Refresh restaurant status" variant="secondary" onPress={retry} /></MarketCard>;
  if (!ready) return <View role="status" accessibilityLiveRegion="polite"><MarketText>Checking whether the restaurant is taking orders…</MarketText></View>;
  if (!business?.orderingEnabled) return <MarketCard><MarketText>Ordering is currently unavailable. You can still browse the menu.</MarketText></MarketCard>;
  return null;
}
