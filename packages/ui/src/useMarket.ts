import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createMarketServices } from '@market/services';
import type { AppAudience, BusinessSlug } from '@market/core';
import { useNotificationPreferences } from './useNotificationPreferences';
import { attemptKey, readAttempt, type CheckoutAttempt, type Identity } from './checkout-state';
import { useMarketAuth } from './useMarketAuth';
import { useMarketCatalog } from './useMarketCatalog';
import { useMarketOrders } from './useMarketOrders';
export function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function useMarket(businessId: BusinessSlug, audience: AppAudience = 'customer') {
  const services = useMemo(() => createMarketServices({ businessSlug: businessId, audience }), [businessId, audience]);
  const identity = useRef<Identity>({ userId: null, generation: 0 });
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const auth = useMarketAuth(services, identity, setError);
  const catalog = useMarketCatalog(services, setError);
  const orders = useMarketOrders(services, auth.session, identity, auth.identityVersion);
  const preferences = useNotificationPreferences(businessId, audience, auth.session, services, orders.refreshOrders);
  useEffect(() => {
    let active = true;
    void catalog.load();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) { setStorageError('Saved checkout state was cleared in another window. Check your orders before placing another order.'); return; }
      if (event.key !== attemptKey(businessId)) return;
      try { setAttempt(readAttempt(event.newValue, businessId)); } catch (e) { setStorageError(messageOf(e)); }
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    const stopStorage = () => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
    void AsyncStorage.getItem(attemptKey(businessId)).then(value => { if (active) setAttempt(readAttempt(value, businessId)); }).catch(e => { if (active) setStorageError(messageOf(e)); }).finally(() => { if (active) setAttemptReady(true); });

    return () => { active = false; stopStorage(); };
  }, [businessId, catalog.load]);
  return { services, preferences, identity, error: error || orders.ordersError, setError, attempt, setAttempt, attemptReady, storageError, ...auth, ...catalog, ...orders };
}
