import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { AppState } from 'react-native';
import type { createMarketServices, CustomerNotification, OrderCursor } from '@market/services';
import { sameIdentity, type Identity } from './checkout-state';
import { applyRead, inboxPageSize, mergeNotifications, revertRead } from './notification-inbox';
type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
type Snapshot = { identity: Identity; items: CustomerNotification[]; cursor: OrderCursor | null; ready: boolean; loading: boolean; error: boolean; moreLoading: boolean; moreError: boolean; unread: number | null; actionError: boolean };
const empty = (identity: Identity): Snapshot => ({ identity, items: [], cursor: null, ready: false, loading: false, error: false, moreLoading: false, moreError: false, unread: null, actionError: false });

/**
 * The customer's notification inbox (#55). The feed table is deliberately not in Realtime, so it is
 * read on open, on focus and when the app returns to the foreground. Errors are fixed copy only.
 */
export function useMarketInbox(services: Services, session: Session, identity: RefObject<Identity>, identityVersion: number, customer = true) {
  const request = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(identity.current));
  const latest = useRef(snapshot); latest.current = snapshot;
  const publish = (next: Snapshot) => { latest.current = next; setSnapshot(next); };
  const patch = (started: Identity, change: Partial<Snapshot> | ((current: Snapshot) => Partial<Snapshot>)) => {
    if (!sameIdentity(started, identity.current)) return;
    // A new account starts from an empty inbox; a screen effect may begin loading before this hook's own effects run.
    const base = sameIdentity(latest.current.identity, started) ? latest.current : empty(started);
    publish({ ...base, ...(typeof change === 'function' ? change(base) : change) });
  };
  const refreshCount = useCallback(async () => {
    const started = identity.current;
    if (!started.userId || !customer) return;
    try { const unread = await services.getUnreadNotificationCount(); patch(started, { unread }); } catch { /* the badge simply stays as it was */ }
  }, [services, identity, customer]);
  const refresh = useCallback(async () => {
    const started = identity.current;
    if (!started.userId || !customer) return;
    const id = ++request.current;
    patch(started, { loading: true, error: false, moreError: false, actionError: false });
    try {
      const [page, unread] = await Promise.all([services.listNotifications({ limit: inboxPageSize }), services.getUnreadNotificationCount().catch(() => null)]);
      if (id !== request.current) return;
      patch(started, current => ({ items: mergeNotifications(current.items, page.notifications, false), cursor: page.nextCursor, ready: true, loading: false, error: false, moreLoading: false, ...(unread === null ? {} : { unread }) }));
    } catch {
      if (id === request.current) patch(started, { loading: false, error: true });
    }
  }, [services, identity, customer]);
  const loadMore = useCallback(async () => {
    const started = identity.current, current = latest.current;
    if (!started.userId || !current.ready || !current.cursor || current.loading || current.moreLoading) return;
    const id = ++request.current;
    patch(started, { moreLoading: true, moreError: false });
    try {
      const page = await services.listNotifications({ cursor: current.cursor, limit: inboxPageSize });
      if (id !== request.current) return;
      patch(started, now => ({ items: mergeNotifications(now.items, page.notifications, true), cursor: page.nextCursor, moreLoading: false }));
    } catch { if (id === request.current) patch(started, { moreLoading: false, moreError: true }); }
  }, [services, identity]);
  /** Optimistically mark one row read; the server's count then reconciles the badge. */
  const markRead = useCallback(async (notificationId: string) => {
    const started = identity.current, row = latest.current.items.find(item => item.id === notificationId);
    if (!started.userId || !row || row.readAtISO) return;
    patch(started, current => applyRead(current.items, current.unread, [notificationId], new Date().toISOString()));
    try { await services.markNotificationRead(notificationId); }
    catch { patch(started, current => ({ items: revertRead(current.items, notificationId), actionError: true })); }
    void refreshCount();
  }, [services, identity, refreshCount]);
  const markAllRead = useCallback(async () => {
    const started = identity.current;
    if (!started.userId || latest.current.loading) return;
    patch(started, { actionError: false });
    try { await services.markAllNotificationsRead(); patch(started, current => applyRead(current.items, current.unread, 'all', new Date().toISOString())); }
    catch { patch(started, { actionError: true }); }
    void refreshCount();
  }, [services, identity, refreshCount]);
  // Nothing is requested until the drawer or the inbox is opened; a new account starts empty (see patch).
  useEffect(() => {
    if (!session || !customer || snapshot.unread === null) return;
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refreshCount(); });
    return () => subscription.remove();
  }, [session?.user.id, customer, refreshCount, snapshot.unread === null]);
  const current = !!session && sameIdentity(snapshot.identity, identity.current);
  const view = current ? snapshot : empty(identity.current);
  return { inbox: { ...view, hasMore: !!view.cursor, refresh, loadMore, markRead, markAllRead, refreshCount } };
}
