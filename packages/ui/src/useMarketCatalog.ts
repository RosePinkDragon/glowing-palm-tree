import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { createMarketServices } from '@market/services';
import type { MenuItem } from '@market/core';
import { classifyFailure, offlineRetryMs, type FailureKind } from './states-model';
type Services = ReturnType<typeof createMarketServices>;
type Catalog = { services: Services; business: Awaited<ReturnType<Services['getBusiness']>> | null; menu: MenuItem[]; refreshing: boolean; error: string; kind: FailureKind | null };
const empty = (services: Services): Catalog => ({ services, business: null, menu: [], refreshing: true, error: '', kind: null });
const web = () => Platform.OS === 'web' && typeof window !== 'undefined';
/** What the browser knows about the connection (true when it cannot tell, as on a phone app: a failed request says so instead). */
const browserOnline = () => !web() || typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * The restaurant and its menu. A failed load says why (`errorKind`: offline, server or auth, #57). While offline the menu is
 * fetched again by itself when the connection returns (the browser's "online" event) and, with no such event, every few
 * seconds in the background; that only reads the menu. It never places or resends an order.
 */
export function useMarketCatalog(services: Services, live: boolean) {
  const [catalog, setCatalog] = useState(() => empty(services));
  const [attempt, setAttempt] = useState(0);
  const [online, setOnline] = useState(browserOnline);
  const quiet = useRef(false);
  const load = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!web()) return;
    const up = () => { setOnline(true); setAttempt(value => value + 1); }, down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  useEffect(() => {
    let active = true, request = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const started = ++request;
      const background = quiet.current; quiet.current = false;
      if (!background) setCatalog(previous => ({ ...(previous.services === services ? previous : empty(services)), refreshing: true, error: '', kind: null }));
      try {
        const [business, menu] = await Promise.all([services.getBusiness(), services.getMenu()]);
        if (active && started === request) setCatalog({ services, business, menu, refreshing: false, error: '', kind: null });
      } catch (error) {
        if (active && started === request) setCatalog(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : 'Could not refresh the menu. Please try again.', kind: classifyFailure(error, browserOnline()) }));
      }
    };
    void refresh();
    if (live && services.mode === 'backend') {
      const failed = (error: unknown) => {
        if (!active) return;
        // A pre-disconnection response cannot restore ordering after the channel failed.
        request++;
        setCatalog(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : 'Live menu updates disconnected. Refresh to retry.', kind: previous.kind === 'offline' ? 'offline' : classifyFailure(error, browserOnline()) }));
      };
      void services.subscribeBusinessState(() => { if (active) void refresh(); }, failed)
        .then(unsubscribe => { if (active) stop = unsubscribe; else unsubscribe(); }).catch(failed);
    }
    return () => { active = false; request++; stop?.(); };
  }, [services, live, attempt]);
  // Never expose a previous restaurant's state during a service change.
  const current = catalog.services === services ? catalog : empty(services);
  const offline = !online || (!!current.error && current.kind === 'offline');
  // While offline, look again every few seconds without flicker (the offline screen stays until a load succeeds).
  useEffect(() => {
    if (!offline) return;
    const timer = setInterval(() => { quiet.current = true; setAttempt(value => value + 1); }, offlineRetryMs);
    return () => clearInterval(timer);
  }, [offline]);
  return { business: current.business, menu: current.menu, loading: !current.business && current.refreshing,
    businessReady: !!current.business && !current.refreshing && !current.error, catalogError: current.error, catalogErrorKind: current.error ? current.kind ?? classifyFailure(current.error, online) : null, offline, load };
}
