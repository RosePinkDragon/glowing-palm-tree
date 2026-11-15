import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Order } from '@market/core';
import type { createMarketServices, OrderCursor } from '@market/services';
import { sameIdentity, type Identity } from './checkout-state';
import { mergeHistory, readHistoryPages } from './order-history';
type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
type Snapshot = { identity: Identity; orders: Order[]; loading: boolean; ready: boolean; error: string; moreError: string; moreLoading: boolean; cursor: OrderCursor | null; pages: number; revision: number };
const empty = (identity: Identity): Snapshot => ({ identity, orders: [], loading: false, ready: false, error: '', moreError: '', moreLoading: false, cursor: null, pages: 1, revision: 0 });
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not load your orders. Please try again.';
export function useMarketOrders(services: Services, session: Session, identity: RefObject<Identity>, identityVersion: number, customer = true) {
  const requestId = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(identity.current));
  const latest = useRef(snapshot); latest.current = snapshot;
  const publish = (next: Snapshot) => { latest.current = next; setSnapshot(next); };
  const refreshOrders = useCallback(async () => {
    const started = identity.current;
    if (!started.userId) return;
    const request = ++requestId.current;
    const previous = sameIdentity(latest.current.identity, started) ? latest.current : empty(started);
    publish({ ...previous, loading: !previous.ready, error: '', moreError: '', moreLoading: false });
    try {
      const result = customer ? await readHistoryPages(services.getOrderHistory, previous.pages, previous.orders.at(-1)) : { orders: await services.getOrders(), nextCursor: null, pages: 1 };
      if (request !== requestId.current || !sameIdentity(started, identity.current)) return;
      publish({ ...latest.current, identity: started, orders: mergeHistory(previous.orders, result.orders, false), cursor: result.nextCursor, pages: result.pages, loading: false, ready: true, error: '', revision: latest.current.revision + 1 });
    } catch (error) {
      if (request === requestId.current && sameIdentity(started, identity.current)) publish({ ...latest.current, loading: false, error: message(error) });
    }
  }, [services, identity, customer]);
  const loadOlderOrders = useCallback(async () => {
    const previous = latest.current, started = identity.current;
    if (!started.userId || !sameIdentity(previous.identity, started) || !previous.ready || !previous.cursor || previous.loading || previous.moreLoading) return;
    const request = ++requestId.current;
    publish({ ...previous, moreLoading: true, moreError: '' });
    try {
      const page = await services.getOrderHistory({ cursor: previous.cursor });
      if (request !== requestId.current || !sameIdentity(started, identity.current)) return;
      publish({ ...latest.current, orders: mergeHistory(previous.orders, page.orders, true), cursor: page.nextCursor, pages: previous.pages + 1, moreLoading: false, moreError: '' });
    } catch (error) {
      if (request === requestId.current && sameIdentity(started, identity.current)) publish({ ...latest.current, moreLoading: false, moreError: message(error) });
    }
  }, [services, identity, customer]);
  useEffect(() => {
    ++requestId.current; publish(empty(identity.current));
    if (!session) return;
    let active = true; let stop: (() => void) | undefined;
    void refreshOrders();
    void services.subscribeOrders(() => { if (active) void refreshOrders(); }, error => { if (active) publish({ ...latest.current, error: message(error) }); }).then(fn => { if (active) stop = fn; else fn(); }).catch(error => { if (active) publish({ ...latest.current, error: message(error) }); });
    return () => { active = false; ++requestId.current; stop?.(); };
  }, [session?.user.id, identityVersion, services, identity, refreshOrders]);
  const current = !!session && sameIdentity(snapshot.identity, identity.current);
  return { orders: current ? snapshot.orders : [], ordersLoading: current && snapshot.loading, ordersReady: current && snapshot.ready, ordersError: current ? snapshot.error : '', olderOrdersError: current ? snapshot.moreError : '', olderOrdersLoading: current && snapshot.moreLoading, hasOlderOrders: current && !!snapshot.cursor, ordersRevision: current ? snapshot.revision : 0, refreshOrders, loadOlderOrders };
}
