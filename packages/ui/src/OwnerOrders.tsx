import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { formatINRFromPaise, type Order, type OrderStatus } from '@market/core';
import type { MarketServices } from '@market/services';
import { MarketButton, MarketStatus, MarketText } from './components';
import { capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { ActionButton, OwnerOrderDetails } from './OwnerOrderDetails';
import { applyOrderTransition, elapsedLabel, filterCounts, filterForStatus, filterLabel, mergeOrderSnapshot, newOrderCount, orderReference, ordersForFilter, queueFilters, shortAddress, statusLabel, type QueueFilter } from './admin-model';
import { useMarketFonts, useMarketTheme } from './theme';
import { MarketChip, MarketPill } from './MarketChips';

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
  return { orders, filter, setFilter, loading, error, notice, dismissNotice: () => setNotice(''), clearMessages: () => { setNotice(''); setSuccess(''); }, success, connection, busyIds, newCount: newOrderCount(orders), reload: load, reconnect, transition, demo };
}
export type OwnerOrdersState = ReturnType<typeof useOwnerOrders>;

/** Live / Paused indicator for the Orders header. */
export function OrdersConnectionPill({ connection }: { connection: OrdersConnection }) {
  const label = { live: 'Live', paused: 'Paused', connecting: 'Connecting', sample: 'Sample' }[connection];
  return <MarketPill dot tone={connection === 'live' ? 'positive' : 'quiet'} label={label} status={`Live updates: ${label}`} />;
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
function OrderCard({ order, now, busy, demo, onAccept, onDetails }: { order: Order; now: number; busy: boolean; demo: boolean; onAccept: () => void; onDetails: () => void }) {
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
        {isNew ? <ActionButton grow tone="primary" label={busy ? 'Accepting…' : 'Accept order'} name={`Accept order ${reference}`} disabled={busy || demo} onPress={onAccept} /> : null}
        <ActionButton label="Details" name={`Details for ${reference}`} disabled={busy} onPress={onDetails} />
      </View>
    </View>
  </View>;
}

/** Orders tab: status filters, live status, and order cards. `topSlot` sits above the list for #58's open/closed switch. */
export function OwnerOrders({ queue, topSlot }: { queue: OwnerOrdersState; topSlot?: ReactNode }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const selectedOrder = queue.orders.find(order => order.id === selected);
  // Closing returns to the list that holds the order (it may have moved on) and to its Details button.
  const refocus = useRef<string | null>(null);
  const closeDetails = () => { if (selectedOrder) { queue.setFilter(filterForStatus(selectedOrder.status)); refocus.current = orderReference(selectedOrder.id); } setSelected(null); restorePanelFocus(trigger.current); };
  // A status step moves the card to another filter list, so the captured button is gone: find it again.
  useEffect(() => {
    const reference = refocus.current;
    if (selected || !reference || typeof document === 'undefined') return;
    refocus.current = null;
    const target = document.querySelector<HTMLElement>(`[aria-label="Details for ${reference}"]`);
    if (target && document.activeElement !== target) target.focus();
  }, [selected, queue.filter, queue.orders]);
  const { orders, filter, loading, error, notice, success, connection, busyIds, demo } = queue;
  const counts = filterCounts(orders);
  const visible = ordersForFilter(orders, filter);
  return <View style={{ gap: 16 }}>
    <View role="status" aria-live="polite">{success && !selected ? <MarketText>{success}</MarketText> : null}</View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
      <View role="group" aria-label="Order status filters" style={{ flexDirection: 'row', gap: 8 }}>
        {queueFilters.map(value => {
          const active = filter === value; const count = value === 'complete' ? 0 : counts[value];
          return <MarketChip key={value} label={filterLabel(value)} accessibilityLabel={count ? `${filterLabel(value)}, ${count}` : filterLabel(value)} selected={active} count={count || undefined} onPress={() => queue.setFilter(value)} />;
        })}
      </View>
    </ScrollView>
    {topSlot}
    {connection === 'paused' ? <View accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: colors.tint }}>
      <View style={{ flex: 1 }}><MarketText><Text style={{ fontWeight: '700' }}>Live updates paused.</Text> New orders may not show until you reconnect.</MarketText></View>
      <MarketButton label="Reconnect" onPress={queue.reconnect} />
    </View> : null}
    {demo ? <MarketStatus kind="empty" title="Sample mode" message="There are no live orders in sample mode. Connect the backend and sign in as an administrator to manage orders." /> : null}
    {notice && !selected ? <MarketStatus kind="error" title="Order update notice" message={notice} action={<MarketButton label="Dismiss" variant="secondary" onPress={queue.dismissNotice} />} /> : null}
    {error ? <MarketStatus kind="error" title="Could not load orders" message={error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void queue.reload()} />} /> : null}
    {loading ? <MarketStatus kind="loading" title="Loading orders" /> : null}
    {!loading && !error && !demo && !visible.length ? <MarketStatus kind="empty" title={emptyCopy[filter][0]} message={emptyCopy[filter][1]} /> : null}
    {selected ? <OwnerOrderDetails queue={queue} orderId={selected} now={now} onClose={closeDetails} /> : null}
    {visible.map(order => <OrderCard key={order.id} order={order} now={now} demo={demo} busy={busyIds.has(order.id)}
      onAccept={() => void queue.transition(order, 'accepted')} onDetails={() => { trigger.current = capturePanelFocus(); queue.clearMessages(); setSelected(order.id); }} />)}
  </View>;
}
