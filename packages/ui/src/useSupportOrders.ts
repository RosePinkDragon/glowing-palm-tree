import { useCallback, useEffect, useRef, useState } from 'react';
import type { Order } from '@market/core';
import type { OrderCursor } from '@market/services';
import type { useMarket } from './useMarket';
import { sameIdentity, type Identity } from './checkout-state';
import { mergeHistory, readHistoryPages } from './order-history';
import { isSupportOrder, selectedSupportOrder } from './support-model';

type Snapshot = { identity: Identity; orders: Order[]; selectedId: string | null; selectionNotice: string; loading: boolean; ready: boolean; error: string; moreError: string; moreLoading: boolean; cursor: OrderCursor | null; pages: number };
const empty = (identity: Identity): Snapshot => ({ identity, orders: [], selectedId: null, selectionNotice: '', loading: false, ready: false, error: '', moreError: '', moreLoading: false, cursor: null, pages: 1 });
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not load active orders. Please try again.';
export function useSupportOrders(market: ReturnType<typeof useMarket>, orderReference?: string) {
  const { services, session, authReady, identity, identityVersion } = market;
  const request = useRef(0);
  const [snapshot, setSnapshot] = useState(() => empty(identity.current));
  const latest = useRef(snapshot); latest.current = snapshot;
  const publish = (value: Snapshot) => { latest.current = value; setSnapshot(value); };
  const refresh = useCallback(async () => {
    const started = identity.current;
    if (!started.userId) return;
    const token = ++request.current;
    const previous = sameIdentity(started, latest.current.identity) ? latest.current : empty(started);
    publish({ ...previous, loading: true, error: '', moreError: '', moreLoading: false });
    try {
      const result = await readHistoryPages(services.getActiveOrders, previous.pages, previous.orders.at(-1));
      if (token !== request.current || !sameIdentity(started, identity.current)) return;
      const orders = mergeHistory(previous.orders, result.orders, false).filter(isSupportOrder);
      const selectedId = selectedSupportOrder(orders, previous.ready ? latest.current.selectedId : orderReference ?? null)?.id ?? null;
      const removed = previous.selectedId && !orders.some(order => order.id === previous.selectedId);
      publish({ ...latest.current, identity: started, orders, selectedId, selectionNotice: removed ? `The previously selected order is no longer active.${selectedId ? ' Showing another active order.' : ''}` : latest.current.selectionNotice, cursor: result.nextCursor, pages: result.pages, loading: false, ready: true, error: '' });
    } catch (error) {
      if (token === request.current && sameIdentity(started, identity.current)) publish({ ...latest.current, loading: false, error: message(error) });
    }
  }, [services, identity, orderReference]);
  const loadMore = useCallback(async () => {
    const previous = latest.current, started = identity.current;
    if (!started.userId || !sameIdentity(previous.identity, started) || !previous.ready || !previous.cursor || previous.loading || previous.moreLoading) return;
    const token = ++request.current;
    publish({ ...previous, moreLoading: true, moreError: '' });
    try {
      const page = await services.getActiveOrders({ cursor: previous.cursor });
      if (token !== request.current || !sameIdentity(started, identity.current)) return;
      const orders = mergeHistory(previous.orders, page.orders, true).filter(isSupportOrder);
      publish({ ...latest.current, orders, selectedId: selectedSupportOrder(orders, latest.current.selectedId)?.id ?? null, cursor: page.nextCursor, pages: previous.pages + 1, moreLoading: false });
    } catch (error) {
      if (token === request.current && sameIdentity(started, identity.current)) publish({ ...latest.current, moreLoading: false, moreError: message(error) });
    }
  }, [services, identity]);
  useEffect(() => {
    ++request.current; publish(empty(identity.current));
    if (!authReady || !session) return;
    let active = true, stop: (() => void) | undefined;
    const failed = (error: unknown) => { if (active) publish({ ...latest.current, error: message(error) }); };
    void refresh();
    void services.subscribeOrders(() => { if (active) void refresh(); }, failed).then(fn => { if (active) stop = fn; else fn(); }).catch(failed);
    return () => { active = false; ++request.current; stop?.(); };
  }, [authReady, session?.user.id, identityVersion, services, identity, refresh]);
  const current = authReady && !!session && sameIdentity(snapshot.identity, identity.current);
  const shown = current ? snapshot : empty(identity.current);
  return { ...shown, selected: selectedSupportOrder(shown.orders, shown.selectedId), refresh, loadMore,
    select: (id: string) => { if (sameIdentity(latest.current.identity, identity.current) && latest.current.orders.some(order => order.id === id && isSupportOrder(order))) publish({ ...latest.current, selectedId: id, selectionNotice: 'Active order selected.' }); } };
}
