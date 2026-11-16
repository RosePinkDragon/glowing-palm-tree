import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type Order } from '@market/core';
import type { useMarket } from './useMarket';
import { sameIdentity, type Identity } from './checkout-state';
import { MarketButton, MarketCard, MarketLinkButton, MarketStatus, MarketText } from './components';
import { callLink } from './admin-model';
import { deliveryMinutes, terminalTime, trackingHeadlines, trackingTimeline } from './order-history';
import { DietMark } from './DietMark';
import { useMarketTheme } from './theme';
import { restorePanelFocus } from './AccessiblePanel';

type Market = ReturnType<typeof useMarket>;
export type ReorderAction = (order: Order, restoreFocus: () => void) => void;
export const activeOrder = (order: Order) => order.status !== 'delivered' && order.status !== 'cancelled';
const indiaTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const label = (order: Order) => order.status.replaceAll('_', ' ');
function TrackingState({ order }: { order: Order }) {
  const { colors } = useMarketTheme();
  const ended = terminalTime(order);
  const minutes = deliveryMinutes(order);
  return <>
    {order.status === 'cancelled' ? <>
      <MarketText>{ended ? `Cancelled ${indiaTime(ended)}` : 'Cancellation time unavailable'}</MarketText>
      <MarketText>You don’t need to pay anything. Nothing is owed.</MarketText>
    </> : order.status !== 'delivered' ? <MarketCard><View>{trackingTimeline(order).map((stage, index) => <View key={stage.status} style={{ flexDirection: 'row', gap: 14 }}>
      <View accessible={false} style={{ alignItems: 'center', width: 28 }}>
        <Text style={{ color: stage.state === 'pending' ? colors.muted : colors.primary, fontSize: 24 }}>{stage.state === 'complete' ? '✓' : stage.state === 'current' ? '●' : '○'}</Text>
        {index < 4 ? <View style={{ width: 2, flex: 1, backgroundColor: stage.state === 'complete' ? colors.primary : colors.border }} /> : null}
      </View>
      <View style={{ flex: 1, paddingBottom: 20 }}>
        <MarketText>{stage.label}{stage.state === 'current' ? ' · Current' : stage.state === 'complete' ? ' · Complete' : ' · Pending'}</MarketText>
        <MarketText variant="muted">{stage.time ? indiaTime(stage.time) : 'Awaiting update'}</MarketText>
      </View>
    </View>)}</View></MarketCard> : null}
    {order.status === 'delivered' ? <MarketText>{ended ? `Arrived ${indiaTime(ended)}` : 'Arrival time unavailable'}{minutes !== null ? ` · Took ${minutes} minutes` : ''}</MarketText> : null}
  </>;
}
export function OrderCard({ order, details = false, onTrack, onReorder }: { order: Order; details?: boolean; onTrack?: () => void; onReorder?: ReorderAction }) {
  const trigger = useRef<ComponentRef<typeof Pressable>>(null);
  const { colors } = useMarketTheme();
  const reorderLabel = details ? order.status === 'cancelled' ? 'Order again' : 'Order this again' : 'Reorder';
  const restoreFocus = () => {
    if (Platform.OS === 'web') restorePanelFocus(trigger.current as unknown as HTMLElement | null);
    else setTimeout(() => { const handle = findNodeHandle(trigger.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }, 0);
  };
  return <MarketCard>
    <MarketText variant="heading">{details ? 'Order details' : `Order ${order.orderNumber ?? `Reference ${order.id.slice(-6)}`}`}</MarketText>
    {!details ? <View role="status" accessibilityLiveRegion="polite"><MarketText>Status: {label(order)}</MarketText></View> : null}
    <MarketText variant="muted">{indiaTime(order.createdAtISO)}</MarketText>
    {order.lines.map((line, i) => <View key={`${line.menuItemId}-${i}`} style={{ gap: 4 }}>
      <MarketText>{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText><DietMark diet={line.diet} />
    </View>)}
    {order.status === 'cancelled' ? <Text style={{ textDecorationLine: 'line-through', color: colors.muted }}>Total: {formatINRFromPaise(order.totalPaise)}</Text>
      : order.status === 'delivered' ? <><MarketText>Delivery: {formatINRFromPaise(order.deliveryFeePaise)}</MarketText><MarketText>Paid in cash: {formatINRFromPaise(order.totalPaise)}</MarketText></>
      : <MarketText>Delivery: {formatINRFromPaise(order.deliveryFeePaise)} · Total: {formatINRFromPaise(order.totalPaise)}</MarketText>}
    {details ? <MarketText variant="muted">{order.delivery.name} · {order.delivery.addressLine}</MarketText> : null}
    {onTrack ? <MarketButton label={`${activeOrder(order) ? 'Track order' : 'View order'} ${order.id.slice(-6)}`} variant={activeOrder(order) ? 'primary' : 'secondary'} onPress={onTrack} /> : null}
    {!activeOrder(order) && onReorder ? <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${reorderLabel} for order ${order.id.slice(-6)}`} onPress={() => onReorder(order, restoreFocus)} style={{ minHeight: 48, paddingHorizontal: 22, paddingVertical: 12, justifyContent: 'center', alignItems: 'center', borderRadius: 14, backgroundColor: colors.primary }}>
      <Text style={{ color: colors.onPrimary, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{reorderLabel}</Text>
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
  const { name, colors, businessId } = useMarketTheme();
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
  return <View style={{ gap: 16 }}><MarketText variant="heading">Order status</MarketText><MarketButton label="Refresh orders" variant="secondary" onPress={() => { setRetry(n => n + 1); void market.refreshOrders(); }} />
    {shown ? <>
      <MarketText variant="heading">Order {shown.orderNumber ?? `Reference ${shown.id.slice(-6)}`}</MarketText>
      <View role="status" accessibilityLiveRegion="polite" style={{ gap: 12, padding: 24, borderRadius: 22, backgroundColor: businessId === 'kokani-dine-inn' ? colors.primary : colors.tint }}>
        <Text style={{ color: businessId === 'kokani-dine-inn' ? colors.onPrimary : colors.primary, fontSize: 14, lineHeight: 22 }}>Status: {label(shown)}</Text>
        <Text accessibilityRole="header" style={{ color: businessId === 'kokani-dine-inn' ? colors.onPrimary : colors.ink, fontSize: 32, lineHeight: 40, fontWeight: '700' }}>{trackingHeadlines[shown.status]}</Text>
      </View>
      <TrackingState order={shown} />
      {activeOrder(shown) && market.preferences.ready && !market.preferences.prefs.push ? <MarketCard><MarketText variant="heading">Get updates on this order</MarketText><MarketText>A notification at every step</MarketText><MarketButton label="Turn on order updates" disabled={market.preferences.busy} onPress={() => market.preferences.setPush(true)} /></MarketCard> : null}
      {market.preferences.pushMessage ? <View role="status" accessibilityLiveRegion="polite"><MarketText>{market.preferences.pushMessage}</MarketText></View> : null}
      <OrderCard order={shown} details onReorder={onReorder} />
      {phone ? <MarketLinkButton label={`Call ${name}`} href={phone} /> : <MarketText variant="muted">Restaurant phone is unavailable. Please try Help & support.</MarketText>}
    </> : null}
    {current?.error ? <MarketStatus kind="error" title="Could not load your orders" message={current.error} action={<MarketButton label="Retry orders" onPress={() => setRetry(n => n + 1)} />} /> : null}
    {(!current || current.loading) && !shown && !current?.resolved ? <MarketStatus kind="loading" title="Loading your orders" /> : null}
    {current?.loading && current.resolved ? <MarketText variant="muted">Refreshing order…</MarketText> : null}
    {current?.resolved && !shown && !current.error ? <MarketStatus kind="empty" title="We can't show this order" message="It may belong to another account or restaurant, or no longer be available." /> : null}
    {onHelp ? <MarketButton label="Help & support" variant="secondary" onPress={onHelp} /> : null}
  </View>;
}
