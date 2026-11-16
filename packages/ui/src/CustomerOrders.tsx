import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type Order } from '@market/core';
import type { useMarket } from './useMarket';
import { sameIdentity, type Identity } from './checkout-state';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { callLink } from './admin-model';
import { OrderStatusView, orderName, shortTime, type ReorderAction } from './CustomerOrderStatus';
import { DietMark } from './DietMark';
import { useMarketTheme } from './theme';
import { restorePanelFocus } from './AccessiblePanel';

type Market = ReturnType<typeof useMarket>;
export type { ReorderAction } from './CustomerOrderStatus';
export const activeOrder = (order: Order) => order.status !== 'delivered' && order.status !== 'cancelled';
const label = (order: Order) => order.status.replaceAll('_', ' ');
/** A past or current order in the Orders list and account drawer; the order page is OrderStatusView. */
export function OrderCard({ order, onTrack, onReorder }: { order: Order; onTrack?: () => void; onReorder?: ReorderAction }) {
  const trigger = useRef<ComponentRef<typeof Pressable>>(null);
  const { colors } = useMarketTheme();
  const restoreFocus = () => {
    if (Platform.OS === 'web') restorePanelFocus(trigger.current as unknown as HTMLElement | null);
    else setTimeout(() => { const handle = findNodeHandle(trigger.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }, 0);
  };
  return <MarketCard>
    <MarketText variant="heading">{`Order ${orderName(order)}`}</MarketText>
    <MarketText>Status: {label(order)}</MarketText>
    <MarketText variant="muted">{shortTime(order.createdAtISO)}</MarketText>
    {order.lines.map((line, i) => <View key={`${line.menuItemId}-${i}`} style={{ gap: 4 }}><MarketText>{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText><DietMark diet={line.diet} /></View>)}
    <MarketText>Delivery: {formatINRFromPaise(order.deliveryFeePaise)} · Total: {formatINRFromPaise(order.totalPaise)}</MarketText>
    {onTrack ? <MarketButton label={`${activeOrder(order) ? 'Track order' : 'View order'} ${orderName(order)}`} variant={activeOrder(order) ? 'primary' : 'secondary'} onPress={onTrack} /> : null}
    {!activeOrder(order) && onReorder ? <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`Reorder order ${orderName(order)}`} onPress={() => onReorder(order, restoreFocus)} style={{ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 999, backgroundColor: colors.primary }}>
      <Text style={{ color: colors.onPrimary, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>Reorder</Text>
    </Pressable> : null}
  </MarketCard>;
}
export function CustomerHistory({ market, go, onReorder }: { market: Market; go: (path: string) => void; onReorder?: ReorderAction }) {
  const { name, colors } = useMarketTheme();
  return <View style={{ gap: 16 }}>
    <MarketText variant="eyebrow">Past orders</MarketText>
    <MarketButton label="Refresh orders" variant="secondary" onPress={() => void market.refreshOrders()} />
    {market.ordersLoading || (!market.ordersReady && !market.ordersError) ? <MarketStatus kind="loading" title="Loading your orders" /> : null}
    {market.ordersError ? <MarketStatus kind="error" title="Could not load your orders" message={market.ordersError} action={<MarketButton label="Retry orders" onPress={() => void market.refreshOrders()} />} /> : null}
    {market.orders.map(order => <OrderCard key={order.id} order={order} onTrack={() => go(`/orders/${order.id}`)} onReorder={onReorder} />)}
    {market.ordersReady && !market.orders.length ? <MarketStatus kind="empty" title="No orders yet" message={`Your orders from ${name} will appear here.`} action={<MarketButton label="Browse the menu" onPress={() => go('/')} />} /> : null}
    {market.olderOrdersError ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{market.olderOrdersError}</Text> : null}
    {market.hasOlderOrders ? <MarketButton label={market.olderOrdersLoading ? 'Loading older orders…' : market.olderOrdersError ? 'Retry older orders' : 'Load older orders'} variant="secondary" disabled={market.olderOrdersLoading || market.ordersLoading} onPress={() => void market.loadOlderOrders()} /> : null}
    <View role="status" accessibilityLiveRegion="polite"><MarketText variant="muted">{market.ordersReady ? `${market.orders.length} orders loaded` : ''}</MarketText></View>
  </View>;
}
export function CustomerOrderDetail({ market, id, receipt, onReorder, onHelp }: { market: Market; id: string; receipt: Order | null; onReorder?: ReorderAction; onHelp?: () => void }) {
  const { name } = useMarketTheme();
  const phone = callLink(market.business?.contactPhone ?? '');
  const request = useRef(0);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{ identity: Identity; id: string; order: Order | null; loading: boolean; resolved: boolean; error: string } | null>(null);
  useEffect(() => {
    const started = market.identity.current, current = ++request.current;
    setSnapshot(previous => previous?.id === id && sameIdentity(previous.identity, started) ? { ...previous, loading: true, error: '' } : { identity: started, id, order: null, loading: true, resolved: false, error: '' });
    if (!started.userId) return;
    void market.services.getCustomerOrder(id).then(order => {
      if (current === request.current && sameIdentity(started, market.identity.current)) setSnapshot(previous => ({ identity: started, id, order: previous?.id === id && sameIdentity(previous.identity, started) && previous.order && order && previous.order.version > order.version ? previous.order : order, loading: false, resolved: true, error: '' }));
    }).catch(error => {
      if (current === request.current && sameIdentity(started, market.identity.current)) setSnapshot(previous => ({ identity: started, id, order: previous?.id === id && sameIdentity(previous.identity, started) ? previous.order : null, loading: false, resolved: previous?.id === id && sameIdentity(previous.identity, started) ? previous.resolved : false, error: error instanceof Error ? error.message : 'Could not load this order.' }));
    });
    return () => { request.current++; };
  }, [id, market.services, market.identity, market.identityVersion, market.ordersRevision, retry]);
  const current = snapshot?.id === id && sameIdentity(snapshot.identity, market.identity.current) ? snapshot : null;
  const saved = receipt?.id === id ? receipt : null;
  const shown = current?.order ?? (!current?.resolved ? saved : null);
  // The consent offer appears only while the order is in progress and updates are off (existing consent flow).
  const offer = !!shown && activeOrder(shown) && market.preferences.ready && !market.preferences.prefs.push;
  const updates = { offer, on: market.preferences.prefs.push, busy: market.preferences.busy, turnOn: () => market.preferences.setPush(true), message: market.preferences.pushMessage };
  return <View style={{ gap: 16 }}>
    {shown ? <OrderStatusView key={shown.id} order={shown} restaurant={name} phone={market.businessReady ? phone : undefined} updates={updates} onReorder={onReorder} /> : null}
    {current?.error ? <MarketStatus kind="error" title="Could not load your orders" message={current.error} action={<MarketButton label="Retry orders" onPress={() => setRetry(n => n + 1)} />} /> : null}
    {(!current || current.loading) && !shown && !current?.resolved ? <MarketStatus kind="loading" title="Loading your orders" /> : null}
    {current?.loading && current.resolved ? <MarketText variant="muted">Refreshing order…</MarketText> : null}
    {current?.resolved && !shown && !current.error ? <MarketStatus kind="empty" title="We can't show this order" message="It may belong to another account or restaurant, or no longer be available." /> : null}
    <MarketButton label="Refresh orders" variant="secondary" onPress={() => { setRetry(n => n + 1); void market.refreshOrders(); }} />
    {onHelp ? <MarketButton label="Help & support" variant="secondary" onPress={onHelp} /> : null}
  </View>;
}
