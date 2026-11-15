import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { formatINRFromPaise, type Order, type OrderStatus } from '@market/core';
import type { MarketServices } from '@market/services';
import { MarketButton, MarketCard, MarketNavigation, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { AdminMenu } from './AdminMenu';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { applyOrderTransition, mergeOrderSnapshot, nextStatuses, ordersForFilter, queueFilters, statusLabel, type QueueFilter } from './admin-model';
import { OwnerScreen, OwnerTabBar } from './OwnerShell';
import { defaultOwnerTab, ownerTabLabel, selectOwnerTab, type OwnerTabId } from './owner-navigation';
import { useMarketTheme } from './theme';

const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
// Tabs render only after the server confirms owner access; the access states keep the account card (and sign out) available.
export function AdminArea({ services, banner, account }: { services: MarketServices; banner?: ReactNode; account?: ReactNode }) {
  const { name } = useMarketTheme();
  const [access, setAccess] = useState<'loading' | 'allowed' | 'denied' | 'error'>('loading');
  const [accessError, setAccessError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<OwnerTabId>(defaultOwnerTab);
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
  return <View style={{ flex: 1 }}>
    <OwnerScreen key={tab} title={ownerTabLabel(tab)}>
      {banner}
      {tab === 'orders' ? <OrderQueue services={services} /> : null}
      {tab === 'menu' ? <AdminMenu services={services} /> : null}
      {tab === 'today' ? <MarketStatus kind="empty" title="Today's summary is coming soon" message="A summary of today's orders will appear here in a later update. Use Orders to see current orders." /> : null}
      {tab === 'settings' ? <OwnerSettings account={account} /> : null}
    </OwnerScreen>
    <OwnerTabBar selected={tab} onSelect={id => setTab(selectOwnerTab(id))} />
  </View>;
}
// Real account controls first; restaurant settings (#60) and owner management (#59) are announced, not interactive.
function OwnerSettings({ account }: { account?: ReactNode }) {
  const { name } = useMarketTheme();
  return <View style={{ gap: 20 }}>
    {account ?? <MarketCard><MarketText variant="heading">Your account</MarketText><MarketText>Sign-in is not available in sample mode.</MarketText></MarketCard>}
    <MarketCard>
      <MarketText variant="eyebrow">Restaurant</MarketText>
      {[['Restaurant details', 'Phone numbers, delivery fee and minimum order'], ['Owners', `Who can manage ${name}`]].map(([title, detail]) => <View key={title} style={{ gap: 2 }}>
        <MarketText>{title}</MarketText>
        <MarketText variant="muted">{`${detail} · Coming soon`}</MarketText>
      </View>)}
    </MarketCard>
    <MarketText variant="muted">{`${name} owners' app`}</MarketText>
  </View>;
}
function OrderQueue({ services }: { services: MarketServices }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const ordersRef = useRef<Order[]>([]);
  const [filter, setFilter] = useState<QueueFilter>('placed');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(services.mode !== 'demo');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [subscriptionAttempt, setSubscriptionAttempt] = useState(0);
  const trigger = useRef<HTMLElement | null>(null);
  const closeCancel = () => { setCancelOrder(null); restorePanelFocus(trigger.current); };
  const [cancelOrder, setCancelOrder] = useState<Order | null>(null);
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    try { const result = await services.getOrders(); if (current === request.current) { ordersRef.current = mergeOrderSnapshot(ordersRef.current, result); setOrders(ordersRef.current); setError(''); } }
    catch (e) { if (current === request.current) setError(message(e)); } finally { if (current === request.current) setLoading(false); }
  }, [services]);
  useEffect(() => {
    if (services.mode === 'demo') return;
    let active = true; let unsubscribe: (() => void) | undefined;
    void load();
    services.subscribeOrders(() => { if (active) void load(); }, e => { if (active) setNotice(`Live updates unavailable: ${message(e)} Refresh to retry.`); }).then(stop => { if (active) unsubscribe = stop; else stop(); }).catch(e => { if (active) setNotice(`Live updates unavailable: ${message(e)} Refresh to retry.`); });
    return () => { active = false; request.current++; unsubscribe?.(); };
  }, [services, load, subscriptionAttempt]);
  const transition = async (order: Order, status: OrderStatus) => {
    setBusy(true); setNotice(''); setSuccess(''); closeCancel(); request.current++;
    try {
      const updated = await services.transitionOrder(order.id, status, order.version);
      const result = applyOrderTransition(ordersRef.current, updated);
      ordersRef.current = result.orders; setOrders(result.orders);
      if (result.observed) {
        setSuccess(result.observed.version > updated.version ? `Order is now ${statusLabel(result.observed.status)}.` : `Order updated to ${statusLabel(result.observed.status)}.`);
        setFilter(result.observed.status === 'delivered' || result.observed.status === 'cancelled' ? 'complete' : result.observed.status);
      } else setNotice('Order updated, but it is no longer in the current queue.');
    }
    catch (e) { setNotice(`Order was not confirmed as updated: ${message(e)}. Refreshing the latest order state.`); await load(); }
    finally { setBusy(false); }
  };
  const chosen = orders.find(order => order.id === selected);
  return <View style={{ gap: 16 }}>
    <MarketText variant="heading">Order queue</MarketText>
    {services.mode === 'demo' ? <MarketStatus kind="empty" title="Sample mode" message="There are no live orders in sample mode. Connect the backend and sign in as an administrator to manage orders." /> : null}
    {success ? <View role="status" aria-live="polite"><MarketText>{success}</MarketText></View> : null}
    {notice ? <MarketStatus kind="error" title="Order update notice" message={notice} action={<MarketButton label="Refresh and reconnect" variant="secondary" onPress={() => { setNotice(''); setSubscriptionAttempt(n => n + 1); }} />} /> : null}
    {error ? <MarketStatus kind="error" title="Could not load orders" message={error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void load()} />} /> : null}
    <MarketNavigation items={queueFilters.map(value => ({ label: statusLabel(value), selected: filter === value, onPress: () => setFilter(value) }))} />
    {loading ? <MarketStatus kind="loading" title="Loading orders" /> : null}
    {!loading && !error && services.mode !== 'demo' && !ordersForFilter(orders, filter).length ? <MarketStatus kind="empty" title={`No ${statusLabel(filter).toLowerCase()} orders`} message="New orders and updates will appear here." /> : null}
    {cancelOrder ? <AccessiblePanel title={`Cancel order ${cancelOrder.id}?`} onClose={closeCancel}><MarketText>Confirm that this order should be cancelled.</MarketText><MarketButton label="Confirm cancellation" disabled={busy} onPress={() => void transition(cancelOrder, 'cancelled')} /><MarketButton label="Keep order" variant="secondary" disabled={busy} onPress={closeCancel} /></AccessiblePanel> : null}
    {ordersForFilter(orders, filter).map(order => <MarketCard key={order.id}><MarketText variant="heading">Order {order.id}</MarketText><MarketText>{statusLabel(order.status)} · {formatINRFromPaise(order.totalPaise)}</MarketText><MarketText variant="muted">{new Date(order.createdAtISO).toLocaleString()}</MarketText><MarketButton label={selected === order.id ? 'Hide details' : 'View details'} variant="secondary" onPress={() => setSelected(selected === order.id ? null : order.id)} />
      {chosen?.id === order.id ? <View style={{ gap: 10 }}><MarketText variant="heading">Order details</MarketText>{order.lines.map((line, index) => <View key={`${line.menuItemId}-${index}`} style={{ gap: 4 }}><MarketText>{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText><DietMark diet={line.diet} /></View>)}<MarketText>Subtotal: {formatINRFromPaise(order.subtotalPaise)}</MarketText><MarketText>Delivery: {formatINRFromPaise(order.deliveryFeePaise)}</MarketText><MarketText>Total: {formatINRFromPaise(order.totalPaise)}</MarketText><MarketText>Contact: {order.delivery.name} · {order.delivery.phone}</MarketText><MarketText>Address: {order.delivery.addressLine}</MarketText><MarketText variant="heading">Status history</MarketText>{order.history?.length ? order.history.map((entry, index) => <MarketText key={index}>{statusLabel(entry.status)} · {new Date(entry.createdAtISO).toLocaleString()}</MarketText>) : <MarketText variant="muted">No history available.</MarketText>}{nextStatuses(order.status).map(status => <MarketButton key={status} label={status === 'cancelled' ? 'Cancel order' : `Mark ${statusLabel(status).toLowerCase()}`} variant={status === 'cancelled' ? 'secondary' : 'primary'} disabled={busy || services.mode === 'demo'} onPress={() => status === 'cancelled' ? (trigger.current = capturePanelFocus(), setCancelOrder(order)) : void transition(order, status)} />)}</View> : null}
    </MarketCard>)}
  </View>;
}
