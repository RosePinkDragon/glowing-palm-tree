import { useCallback, useState } from 'react';
import type { createMarketServices } from '@market/services';
import type { MenuItem } from '@market/core';
export function useMarketCatalog(services: ReturnType<typeof createMarketServices>, setError: (error: string) => void) {
  const [business, setBusiness] = useState<Awaited<ReturnType<typeof services.getBusiness>> | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const [b, m] = await Promise.all([services.getBusiness(), services.getMenu()]); setBusiness(b); setMenu(m); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load the menu. Please try again.'); } finally { setLoading(false); }
  }, [services, setError]);
  return { business, menu, loading, load };
}
