import { useCallback, useEffect, useState } from 'react';
import type { createMarketServices } from '@market/services';
import type { MenuItem } from '@market/core';
type Services = ReturnType<typeof createMarketServices>;
type Catalog = { services: Services; business: Awaited<ReturnType<Services['getBusiness']>> | null; menu: MenuItem[]; refreshing: boolean; error: string };
const empty = (services: Services): Catalog => ({ services, business: null, menu: [], refreshing: true, error: '' });

export function useMarketCatalog(services: Services, live: boolean) {
  const [catalog, setCatalog] = useState(() => empty(services));
  const [attempt, setAttempt] = useState(0);
  const load = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    let active = true, request = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const started = ++request;
      setCatalog(previous => ({ ...(previous.services === services ? previous : empty(services)), refreshing: true, error: '' }));
      try {
        const [business, menu] = await Promise.all([services.getBusiness(), services.getMenu()]);
        if (active && started === request) setCatalog({ services, business, menu, refreshing: false, error: '' });
      } catch (error) {
        if (active && started === request) setCatalog(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : 'Could not refresh the menu. Please try again.' }));
      }
    };
    void refresh();
    if (live && services.mode === 'backend') {
      const failed = (error: unknown) => {
        if (!active) return;
        // A pre-disconnection response cannot restore ordering after the channel failed.
        request++;
        setCatalog(previous => ({ ...previous, refreshing: false, error: error instanceof Error ? error.message : 'Live menu updates disconnected. Refresh to retry.' }));
      };
      void services.subscribeBusinessState(() => { if (active) void refresh(); }, failed)
        .then(unsubscribe => { if (active) stop = unsubscribe; else unsubscribe(); }).catch(failed);
    }
    return () => { active = false; request++; stop?.(); };
  }, [services, live, attempt]);
  // Never expose a previous restaurant's state during a service change.
  const current = catalog.services === services ? catalog : empty(services);
  return { business: current.business, menu: current.menu, loading: !current.business && current.refreshing,
    businessReady: !!current.business && !current.refreshing && !current.error, catalogError: current.error, load };
}
