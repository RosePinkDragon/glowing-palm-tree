import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createMarketServices } from '@market/services';
import type { AppAudience, BusinessSlug, MenuItem, Order } from '@market/core';
import { parseAuthCallback } from './auth-callback';
import { attemptKey, nextIdentity, readAttempt, sameIdentity, type CheckoutAttempt, type Identity } from './checkout-state';

type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
export function messageOf(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

export function useMarket(businessId: BusinessSlug, audience: AppAudience = 'customer') {
  const services = useMemo(() => createMarketServices({ businessSlug: businessId, audience }), [businessId, audience]);
  const identity = useRef<Identity>({ userId: null, generation: 0 });
  const orderRequest = useRef(0);
  const [identityVersion, setIdentityVersion] = useState(0);
  const [business, setBusiness] = useState<Awaited<ReturnType<Services['getBusiness']>> | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [session, setSession] = useState<Session>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null);
  const [attemptReady, setAttemptReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const [b, m] = await Promise.all([services.getBusiness(), services.getMenu()]); setBusiness(b); setMenu(m); }
    catch (e) { setError(messageOf(e)); } finally { setLoading(false); }
  }, [services]);
  const refreshOrders = useCallback(async () => { const started = identity.current; const request = ++orderRequest.current; try { const result = await services.getOrders(); if (request === orderRequest.current && sameIdentity(started, identity.current)) setOrders(result); } catch (e) { if (request === orderRequest.current && sameIdentity(started, identity.current)) setError(messageOf(e)); } }, [services]);
  useEffect(() => {
    let active = true;
    void load();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null) { setStorageError('Saved checkout state was cleared in another window. Check your orders before placing another order.'); return; }
      if (event.key !== attemptKey(businessId)) return;
      try { setAttempt(readAttempt(event.newValue, businessId)); } catch (e) { setStorageError(messageOf(e)); }
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    const stopStorage = () => { if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('storage', onStorage); };
    void AsyncStorage.getItem(attemptKey(businessId)).then(value => { if (active) setAttempt(readAttempt(value, businessId)); }).catch(e => { if (active) setStorageError(messageOf(e)); }).finally(() => { if (active) setAttemptReady(true); });
    if (services.mode === 'backend') {
      const started = identity.current; let authEventSeen = false;
      const applySession = (s: Session) => { const next = nextIdentity(identity.current, s?.user.id ?? null); if (next !== identity.current) { identity.current = next; setIdentityVersion(next.generation); setOrders([]); } setSession(s); };
      void services.auth.session().then(s => { if (active && !authEventSeen && sameIdentity(started, identity.current)) applySession(s); }).catch(e => { if (active && !authEventSeen && sameIdentity(started, identity.current)) setError(messageOf(e)); });
      const unsubscribe = services.auth.onChange(async (event, s) => { if (active) { authEventSeen = true; applySession(s); if (event === 'PASSWORD_RECOVERY') setRecovery(true); } });
      const handledUrls = new Set<string>();
      const handleUrl = async (url: string) => {
        if (handledUrls.has(url)) return;
        handledUrls.add(url);
        let callback: ReturnType<typeof parseAuthCallback> | undefined;
        try {
          callback = parseAuthCallback(url);
          if (callback.error) throw new Error(`Email link could not be completed: ${callback.error}. Request a new link and try again.`);
          if (!callback.code) { if (callback.hasAuth) throw new Error('This email link is incomplete or expired. Request a new link and try again.'); return; }
          await services.auth.exchangeCodeForSession(callback.code);
          if (active) setNotice('Email link confirmed.');
        } catch (e) { if (active) setError(messageOf(e)); }
        finally {
          if (callback?.hasAuth && Platform.OS === 'web' && typeof window !== 'undefined') window.history.replaceState({}, '', callback.cleanUrl);
        }
      };
      if (Platform.OS === 'web' && typeof window !== 'undefined') void handleUrl(window.location.href);
      else void Linking.getInitialURL().then(url => { if (url) void handleUrl(url); });
      const link = Linking.addEventListener('url', ({ url }) => { void handleUrl(url); });
      return () => { active = false; stopStorage(); link.remove(); unsubscribe(); services.dispose(); };
    }
    return () => { active = false; stopStorage(); services.dispose(); };
  }, [businessId, load, services]);
  useEffect(() => {
    if (!session) { setOrders([]); return; }
    let active = true; let stop: (() => void) | undefined;
    void refreshOrders();
    void services.subscribeOrders(() => { if (active) void refreshOrders(); }, e => { if (active) setError(messageOf(e)); }).then(fn => { if (active) stop = fn; else fn(); }).catch(e => { if (active) setError(messageOf(e)); });
    return () => { active = false; stop?.(); };
  }, [session?.user.id, identityVersion, services, refreshOrders]);
  return { services, business, menu, session, identity, identityVersion, orders, error, setError, loading, load, refreshOrders, attempt, setAttempt, attemptReady, storageError, recovery, setRecovery, notice, setNotice };
}
