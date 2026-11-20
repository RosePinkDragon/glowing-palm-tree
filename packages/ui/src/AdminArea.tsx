import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { Order } from '@market/core';
import type { MarketServices } from '@market/services';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { AddDishButton, AdminMenu, type AdminMenuAddDish } from './AdminMenu';
import { OrdersConnectionPill, OwnerOrderFilters, OwnerOrders, useOwnerOrders } from './OwnerOrders';
import { OwnerScreen, OwnerTabBar } from './OwnerShell';
import { OwnerToday, OwnerTodayFilters, useOwnerTodayDay } from './OwnerToday';
import { defaultOwnerTab, ownerTabLabel, selectOwnerTab, type OwnerTabId } from './owner-navigation';
import { useMarketTheme } from './theme';
import { OwnerOrderingSwitch } from './OwnerOrderingSwitch';
import { OwnerSettings } from './OwnerSettings';
import { OwnerRestaurantDetails } from './OwnerRestaurantDetails';
import { OwnerOffers } from './OwnerOffers';
import type { useMarket } from './useMarket';

const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
// Tabs render only after the server confirms owner access; the access states keep the account card (and sign out) available.
/** `ordersSlot` (above the order list) is #58's open/closed switch seam; `onNewOrders` is #54's alert seam. */
export function AdminArea({ services, market, banner, account, ordersSlot, onNewOrders }: { services: MarketServices; market?: ReturnType<typeof useMarket>; banner?: ReactNode; account?: ReactNode; ordersSlot?: ReactNode; onNewOrders?: (orders: Order[]) => void }) {
  const { name } = useMarketTheme();
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied' | 'error'>('loading');
  const [accessError, setAccessError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<OwnerTabId>(defaultOwnerTab);
  const [addDish, setAddDish] = useState<AdminMenuAddDish | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [offersOpen, setOffersOpen] = useState(false);
  const todayDay = useOwnerTodayDay(tab === 'today');
  // One order list and realtime subscription for every tab, so the Orders badge stays current.
  const queue = useOwnerOrders(services, access === 'allowed', onNewOrders);
  useEffect(() => {
    let active = true;
    setAccess('loading');
    if (services.mode === 'demo') { setAccess('allowed'); return () => { active = false; }; }
    services.isAdmin().then(allowed => { if (active) setAccess(allowed ? 'allowed' : 'denied'); }).catch(error => { if (active) { setAccessError(message(error)); setAccess('error'); } });
    return () => { active = false; };
  }, [services, attempt]);
  if (access !== 'allowed') return <OwnerScreen title={name}>
    {banner}
    {access === 'loading' ? <MarketStatus kind="loading" title="Checking access" /> : null}
    {access === 'error' ? <MarketStatus kind="error" title="Could not check access" message={accessError} action={<MarketButton label="Retry" onPress={() => setAttempt(n => n + 1)} />} /> : null}
    {access === 'denied' ? <MarketStatus kind="error" title="Access denied" message="Your account is not an administrator for this business. Contact the business owner for access." /> : null}
    {account}
  </OwnerScreen>;
  // Restaurant details (#60) is a full screen reached from Settings; Back returns to the Settings tab.
  if (detailsOpen && tab === 'settings') return <OwnerRestaurantDetails services={services} onBack={() => setDetailsOpen(false)} />;
  // Offers (#182) is a full screen reached from Settings, like Restaurant details.
  if (offersOpen && tab === 'settings') return <OwnerOffers services={services} onBack={() => setOffersOpen(false)} />;
  return <View style={{ flex: 1 }}>
    <OwnerScreen key={tab} title={ownerTabLabel(tab)} headerRight={tab === 'orders' ? <OrdersConnectionPill connection={queue.connection} /> : tab === 'menu' && addDish ? <AddDishButton action={addDish} /> : undefined}
      headerExtra={tab === 'orders' ? <OwnerOrderFilters queue={queue} /> : tab === 'today' ? <OwnerTodayFilters day={todayDay} /> : undefined}
      band={tab === 'orders' ? ordersSlot ?? <OwnerOrderingSwitch services={services} /> : undefined}>
      {banner}
      {tab === 'orders' ? <OwnerOrders queue={queue} /> : null}
      {tab === 'menu' ? <AdminMenu services={services} showHeader={false} onAddDishChange={setAddDish} /> : null}
      {tab === 'today' ? <OwnerToday services={services} day={todayDay} /> : null}
      {tab === 'settings' ? <OwnerSettings market={market} onOpenRestaurantDetails={() => setDetailsOpen(true)} onOpenOffers={() => setOffersOpen(true)} /> : null}
    </OwnerScreen>
    <OwnerTabBar selected={tab} onSelect={id => setTab(selectOwnerTab(id))} badges={{ orders: queue.newCount }} />
  </View>;
}
