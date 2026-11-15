import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { formatINRFromPaise, type Order, type OrderStatus } from '@market/core';
import type { MarketServices } from '@market/services';
import { MarketButton, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { applyOrderTransition, elapsedLabel, filterCounts, filterForStatus, filterLabel, mergeOrderSnapshot, newOrderCount, nextStatuses, orderReference, ordersForFilter, queueFilters, shortAddress, statusLabel, type QueueFilter } from './admin-model';
import { useMarketFonts, useMarketTheme } from './theme';

const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const tickMs = 30000;
export type OrdersConnection = 'connecting' | 'live' | 'paused' | 'sample';

/**
 * The owner's order list and its single realtime subscription. Call once, above the tabs, so new orders
 * keep arriving (and the tab badge keeps counting) while another tab is open. `onNewOrders` is the seam for
 * #54's new-order alert: it receives orders first seen after the initial load.
 */
export function useOwnerOrders(services: MarketServices, enabled: boolean, onNewOrders?: (orders: Order[]) => void) {
  const demo = services.mode === 'demo';
  const [orders, setOrders] = useState<Order[]>([]);
  const ordersRef = useRef<Order[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('placed');
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [connection, setConnection] = useState<OrdersConnection>(demo ? 'sample' : 'connecting');
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(new Set<string>());
  const request = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const alertRef = useRef(onNewOrders);
  alertRef.current = onNewOrders;
  const load = useCallback(async () => {
    const current = ++request.current;
    try {
      const result = await services.getOrders();
      if (current !== request.current) return;
      const merged = mergeOrderSnapshot(ordersRef.current, result);
      ordersRef.current = merged; setOrders(merged); setError('');
      if (!seen.current) seen.current = new Set(merged.map(order => order.id));
      else {
        const fresh = merged.filter(order => order.status === 'placed' && !seen.current!.has(order.id));
        merged.forEach(order => seen.current!.add(order.id));
        if (fresh.length) alertRef.current?.(fresh);
      }
    } catch (e) { if (current === request.current) setError(message(e)); }
    finally { setLoading(false); }
  }, [services]);
  useEffect(() => {
    if (!enabled) return;
    if (demo) { setConnection('sample'); setLoading(false); return; }
    let active = true; let unsubscribe: (() => void) | undefined;
    setConnection('connecting');
    void load();
    // The service refreshes after every (re)subscription and change, so a refresh means the channel is live.
    services.subscribeOrders(() => { if (active) { setConnection('live'); void load(); } }, () => { if (active) setConnection('paused'); })
      .then(stop => { if (active) unsubscribe = stop; else stop(); })
      .catch(() => { if (active) setConnection('paused'); });
    return () => { active = false; request.current++; unsubscribe?.(); };
  }, [services, enabled, demo, load, attempt]);
  const reconnect = useCallback(() => { setNotice(''); setAttempt(n => n + 1); }, []);
  const transition = useCallback(async (order: Order, status: OrderStatus): Promise<Order | undefined> => {
    if (inFlight.current.has(order.id)) return undefined;
    inFlight.current.add(order.id); setBusyIds(new Set(inFlight.current));
    setNotice(''); setSuccess(''); request.current++;
    const reference = orderReference(order.id);
    try {
      // The server confirms the change only when the version still matches.
      const updated = await services.transitionOrder(order.id, status, order.version);
      const result = applyOrderTransition(ordersRef.current, updated);
      ordersRef.current = result.orders; setOrders(result.orders);
      if (result.observed) { setSuccess(result.observed.version > updated.version ? `Order ${reference} is now ${statusLabel(result.observed.status)}.` : `Order ${reference} updated to ${statusLabel(result.observed.status)}.`); return result.observed; }
      setNotice(`Order ${reference} was updated, but it is no longer in the current queue.`);
    } catch (e) {
      setNotice(`Order ${reference} was not updated: ${message(e)} We are showing the latest orders; check its status before trying again.`);
      await load();
    } finally { inFlight.current.delete(order.id); setBusyIds(new Set(inFlight.current)); }
  }, [services, load]);
  return { orders, filter, setFilter, loading, error, notice, dismissNotice: () => setNotice(''), success, connection, busyIds, newCount: newOrderCount(orders), reload: load, reconnect, transition, demo };
}
export type OwnerOrdersState = ReturnType<typeof useOwnerOrders>;

const pillColors = { live: { bg: '#E3F1E7', dot: '#2E7D4F', text: '#1F5B37' }, other: { bg: '#EDEAE6', dot: '#6B6B6B', text: '#4A4A4A' } };
/** Live / Paused indicator for the Orders header. */
export function OrdersConnectionPill({ connection }: { connection: OrdersConnection }) {
  const fonts = useMarketFonts();
  const label = { live: 'Live', paused: 'Paused', connecting: 'Connecting', sample: 'Sample' }[connection];
  const colors = connection === 'live' ? pillColors.live : pillColors.other;
  return <View role="status" aria-label={`Live updates: ${label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 28, borderRadius: 14, backgroundColor: colors.bg }}>
    <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.dot }} />
    <Text style={{ color: colors.text, fontSize: 12, lineHeight: 16, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </View>;
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), tickMs); return () => clearInterval(timer); }, []);
  return now;
}

const emptyCopy: Record<QueueFilter, [string, string]> = {
  placed: ['No new orders', 'Keep this app open. New orders appear here.'],
  accepted: ['No accepted orders', 'Orders you accept appear here.'],
  preparing: ['No orders being prepared', 'Orders you start preparing appear here.'],
  out_for_delivery: ['No orders out for delivery', 'Orders on their way appear here.'],
  complete: ['No finished orders', 'Delivered and cancelled orders appear here.'],
};

function Strong({ children, size = 16, color, align }: { children: ReactNode; size?: number; color?: string; align?: 'right' }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Text style={{ color: color ?? colors.ink, fontSize: size, lineHeight: Math.round(size * 1.4), textAlign: align, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{children}</Text>;
}
function CardAction({ label, name, primary, disabled, onPress }: { label: string; name: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Pressable accessibilityRole="button" accessibilityLabel={name} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flex: primary ? 1 : undefined, minHeight: 48, minWidth: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: primary ? colors.primary : colors.border, backgroundColor: primary ? colors.primary : colors.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={{ color: primary ? colors.onPrimary : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </Pressable>;
}

function OrderCard({ order, now, busy, expanded, demo, onAccept, onToggle, onTransition, onCancel }: { order: Order; now: number; busy: boolean; expanded: boolean; demo: boolean; onAccept: () => void; onToggle: () => void; onTransition: (status: OrderStatus) => void; onCancel: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const reference = orderReference(order.id);
  const isNew = order.status === 'placed';
  return <View role="group" aria-label={`Order ${reference}, ${isNew ? 'New' : statusLabel(order.status)}`} style={{ backgroundColor: colors.surface, borderRadius: 20, borderWidth: isNew ? 2 : 1, borderColor: isNew ? colors.primary : colors.border, overflow: 'hidden' }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: isNew ? colors.tint : colors.background }}>
      <Strong size={14} color={isNew ? colors.primary : colors.muted}>{`${isNew ? 'New' : statusLabel(order.status)} · ${elapsedLabel(order.createdAtISO, now)}`}</Strong>
      <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 20, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{reference}</Text>
    </View>
    <View style={{ padding: 16, gap: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" aria-level={3} style={{ color: colors.ink, fontSize: 19, lineHeight: 26, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{order.delivery.name}</Text>
          <MarketText variant="muted">{shortAddress(order.delivery.addressLine)}</MarketText>
        </View>
        <View style={{ alignItems: 'flex-end' }}><Strong size={20} align="right">{formatINRFromPaise(order.totalPaise)}</Strong><Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>Cash</Text></View>
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, borderStyle: 'dashed', paddingTop: 12, gap: 4 }}>
        {order.lines.map((line, index) => <MarketText key={`${line.menuItemId}-${index}`}>{`${line.quantity} × ${line.name}`}</MarketText>)}
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        {isNew ? <CardAction primary label={busy ? 'Accepting…' : 'Accept order'} name={`Accept order ${reference}`} disabled={busy || demo} onPress={onAccept} /> : null}
        <CardAction label={expanded ? 'Hide details' : 'Details'} name={`${expanded ? 'Hide details' : 'Details'} for ${reference}`} disabled={busy} onPress={onToggle} />
      </View>
      {expanded ? <View style={{ gap: 10 }}>
        <MarketText variant="heading">Order details</MarketText>
        {order.lines.map((line, index) => <View key={`${line.menuItemId}-${index}`} style={{ gap: 4 }}><MarketText>{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText><DietMark diet={line.diet} /></View>)}
        <MarketText>Subtotal: {formatINRFromPaise(order.subtotalPaise)}</MarketText>
        <MarketText>Delivery: {formatINRFromPaise(order.deliveryFeePaise)}</MarketText>
        <MarketText>Total: {formatINRFromPaise(order.totalPaise)}</MarketText>
        <MarketText>Contact: {order.delivery.name} · {order.delivery.phone}</MarketText>
        <MarketText>Address: {order.delivery.addressLine}</MarketText>
        <MarketText variant="heading">Status history</MarketText>
        {order.history?.length ? order.history.map((entry, index) => <MarketText key={index}>{statusLabel(entry.status)} · {new Date(entry.createdAtISO).toLocaleString()}</MarketText>) : <MarketText variant="muted">No history available.</MarketText>}
        {nextStatuses(order.status).map(status => <MarketButton key={status} label={status === 'cancelled' ? 'Cancel order' : `Mark ${statusLabel(status).toLowerCase()}`} variant={status === 'cancelled' ? 'secondary' : 'primary'} disabled={busy || demo} onPress={() => status === 'cancelled' ? onCancel() : onTransition(status)} />)}
      </View> : null}
    </View>
  </View>;
}

/** Orders tab: status filters, live status, and order cards. `topSlot` sits above the list for #58's open/closed switch. */
export function OwnerOrders({ queue, topSlot }: { queue: OwnerOrdersState; topSlot?: ReactNode }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const closeCancel = () => { setCancelOrder(null); restorePanelFocus(trigger.current); };
  const { orders, filter, loading, error, notice, success, connection, busyIds, demo } = queue;
  const counts = filterCounts(orders);
  const visible = ordersForFilter(orders, filter);
  return <View style={{ gap: 16 }}>
    <View role="status" aria-live="polite">{success ? <MarketText>{success}</MarketText> : null}</View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
      <View role="group" aria-label="Order status filters" style={{ flexDirection: 'row', gap: 8 }}>
        {queueFilters.map(value => {
          const active = filter === value; const count = value === 'complete' ? 0 : counts[value];
          return <Pressable key={value} accessibilityRole="button" accessibilityLabel={count ? `${filterLabel(value)}, ${count}` : filterLabel(value)} aria-pressed={active} onPress={() => queue.setFilter(value)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, borderColor: active ? colors.ink : colors.border, backgroundColor: active ? colors.ink : colors.surface }}>
            <Text style={{ color: active ? colors.surface : colors.ink, fontSize: 15, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{filterLabel(value)}</Text>
            {count ? <View aria-hidden style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? colors.primary : colors.tint }}><Text style={{ color: active ? colors.onPrimary : colors.primary, fontSize: 12, lineHeight: 16, fontWeight: '700' }}>{count}</Text></View> : null}
          </Pressable>;
        })}
      </View>
    </ScrollView>
    {topSlot}
    {connection === 'paused' ? <View accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: colors.tint }}>
      <View style={{ flex: 1 }}><MarketText><Text style={{ fontWeight: '700' }}>Live updates paused.</Text> New orders may not show until you reconnect.</MarketText></View>
      <MarketButton label="Reconnect" onPress={queue.reconnect} />
    </View> : null}
    {demo ? <MarketStatus kind="empty" title="Sample mode" message="There are no live orders in sample mode. Connect the backend and sign in as an administrator to manage orders." /> : null}
    {notice ? <MarketStatus kind="error" title="Order update notice" message={notice} action={<MarketButton label="Dismiss" variant="secondary" onPress={queue.dismissNotice} />} /> : null}
    {error ? <MarketStatus kind="error" title="Could not load orders" message={error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void queue.reload()} />} /> : null}
    {loading ? <MarketStatus kind="loading" title="Loading orders" /> : null}
    {!loading && !error && !demo && !visible.length ? <MarketStatus kind="empty" title={emptyCopy[filter][0]} message={emptyCopy[filter][1]} /> : null}
    {cancelOrder ? <AccessiblePanel title={`Cancel order ${orderReference(cancelOrder.id)}?`} onClose={closeCancel}><MarketText>Confirm that this order should be cancelled.</MarketText><MarketButton label="Confirm cancellation" disabled={busyIds.has(cancelOrder.id)} onPress={() => { const order = cancelOrder; closeCancel(); void queue.transition(order, 'cancelled').then(updated => { if (updated) queue.setFilter(filterForStatus(updated.status)); }); }} /><MarketButton label="Keep order" variant="secondary" disabled={busyIds.has(cancelOrder.id)} onPress={closeCancel} /></AccessiblePanel> : null}
    {visible.map(order => <OrderCard key={order.id} order={order} now={now} demo={demo} busy={busyIds.has(order.id)} expanded={selected === order.id}
      onAccept={() => void queue.transition(order, 'accepted')} onToggle={() => setSelected(selected === order.id ? null : order.id)}
      onTransition={status => void queue.transition(order, status).then(updated => { if (updated) queue.setFilter(filterForStatus(updated.status)); })} onCancel={() => { trigger.current = capturePanelFocus(); setCancelOrder(order); }} />)}
  </View>;
}
