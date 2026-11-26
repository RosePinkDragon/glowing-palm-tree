import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { createMarketServices } from '@market/services';
import type { MenuItem } from '@market/core';
import { classifyFailure, offlineRetrySteps, type FailureKind } from './states-model';
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
  const quiet = useRef(false), inFlight = useRef(0);
  const [checking, setChecking] = useState(false);
  const load = useCallback(() => setAttempt(value => value + 1), []);
  /** Reads the menu again without showing "loading": the screen on display stays, so ordering and focus are not disturbed. */
  const retry = useCallback(() => { quiet.current = true; setAttempt(value => value + 1); }, []);
  useEffect(() => {
    if (!web()) return;
    const up = () => { setOnline(true); retry(); }, down = () => setOnline(false);
    window.addEventListener('online', up); window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [retry]);
  useEffect(() => {
    let active = true, request = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const started = ++request;
      const background = quiet.current; quiet.current = false;
      inFlight.current++; setChecking(true);
      if (!background) setCatalog(previous => ({ ...(previous.services === services ? previous : empty(services)), refreshing: true, error: '', kind: null }));
      try {
        const [business, menu] = await Promise.all([services.getBusiness(), services.getMenu()]);
        if (active && started === request) { setCatalog({ services, business, menu, refreshing: false, error: '', kind: null }); setOnline(true); } // a load that worked proves the connection, whatever the browser said
      } catch (error) {
        if (active && started === request) setCatalog(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : 'Could not refresh the menu. Please try again.', kind: classifyFailure(error, browserOnline()) }));
      } finally { inFlight.current--; if (active && inFlight.current === 0) setChecking(false); }
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
  // While offline, look again in the background: after 6, 12, then every 30 seconds, never while a load is already running (it would be cancelled) and never while the tab is hidden.
  useEffect(() => {
    if (!offline) return;
    let step = 0, timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        const hidden = web() && typeof document !== 'undefined' && document.hidden;
        if (!hidden && inFlight.current === 0) { retry(); step++; }
        schedule();
      }, offlineRetrySteps[Math.min(step, offlineRetrySteps.length - 1)]);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [offline, retry]);
  return { business: current.business, menu: current.menu, loading: !current.business && current.refreshing,
    businessReady: !!current.business && !current.refreshing && !current.error, catalogError: current.error, catalogErrorKind: current.error ? current.kind ?? classifyFailure(current.error, online) : null, offline, checking, load, retry };
}
