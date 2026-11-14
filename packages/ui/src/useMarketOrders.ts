import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { Order } from '@market/core';
import type { createMarketServices } from '@market/services';
import { sameIdentity, type Identity } from './checkout-state';
type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
type Snapshot = { identity: Identity; orders: Order[]; loading: boolean; ready: boolean; error: string };
export function useMarketOrders(services: Services, session: Session, identity: RefObject<Identity>, identityVersion: number) {
  const requestId = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>({ identity: identity.current, orders: [], loading: false, ready: false, error: '' });
  const refreshOrders = useCallback(async () => {
    const started = identity.current; const request = ++requestId.current;
    if (!started.userId) return;
    setSnapshot(previous => ({ identity: started, orders: sameIdentity(previous.identity, started) ? previous.orders : [], loading: true, ready: false, error: '' }));
    try {
      const orders = await services.getOrders();
      if (request === requestId.current && sameIdentity(started, identity.current)) setSnapshot({ identity: started, orders, loading: false, ready: true, error: '' });
    } catch (e) {
      if (request === requestId.current && sameIdentity(started, identity.current)) setSnapshot(previous => ({ ...previous, loading: false, ready: false, error: e instanceof Error ? e.message : 'Could not load your orders. Please try again.' }));
    }
  }, [services, identity]);
  useEffect(() => {
    if (!session) { ++requestId.current; setSnapshot({ identity: identity.current, orders: [], loading: false, ready: false, error: '' }); return; }
    let active = true; let stop: (() => void) | undefined;
    void refreshOrders();
    void services.subscribeOrders(() => { if (active) void refreshOrders(); }, e => { if (active) setSnapshot(previous => ({ ...previous, error: e instanceof Error ? e.message : 'Live updates are unavailable. Refresh your orders.' })); }).then(fn => { if (active) stop = fn; else fn(); }).catch(e => { if (active) setSnapshot(previous => ({ ...previous, error: e instanceof Error ? e.message : 'Live updates are unavailable. Refresh your orders.' })); });
    return () => { active = false; ++requestId.current; stop?.(); };
  }, [session?.user.id, identityVersion, services, identity, refreshOrders]);
  const current = !!session && sameIdentity(snapshot.identity, identity.current);
  return { orders: current ? snapshot.orders : [], ordersLoading: current && snapshot.loading, ordersReady: current && snapshot.ready, ordersError: current ? snapshot.error : '', refreshOrders };
}
