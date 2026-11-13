import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAnalytics, createMessaging, type Availability } from '@market/notifications';
import type { AppAudience, BusinessSlug } from '@market/core';
import type { MarketServices } from '@market/services';
import { preferenceAdapters } from './preferences-platform';

type Session = Awaited<ReturnType<MarketServices['auth']['session']>>;
type Preferences = { analytics: boolean; push: boolean };
const off: Preferences = { analytics: false, push: false };
export function preferenceKey(business: BusinessSlug, audience: AppAudience, userId: string) { return `market:preferences:${business}:${audience}:${encodeURIComponent(userId)}`; }
function explain(result: Availability): string {
  if (result.status === 'ready') return 'Notifications are on.';
  if (result.status === 'denied') return 'Notifications are blocked or not yet allowed in your device settings.';
  if (result.status === 'unconfigured') return 'Notifications are not available yet.';
  if (result.status === 'unsupported') return 'Notifications are not available on this device.';
  return 'Could not update notifications. Please try again.';
}

export function useNotificationPreferences(business: BusinessSlug, audience: AppAudience, session: Session, services: MarketServices, refreshOrders: () => Promise<void>) {
  const [prefs, setPrefs] = useState<Preferences>(off);
  const [ready, setReady] = useState(false);
  const [analyticsMessage, setAnalyticsMessage] = useState('');
  const [pushMessage, setPushMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const currentSession = useRef(session); currentSession.current = session;
  const active = useRef(0);
  const pushEnabled = useRef(false);
  const controllers = useMemo(() => {
    const adapters = preferenceAdapters();
    const tokenSessions = new Map<string, string>();
    return {
      analytics: createAnalytics(adapters.analytics, { brand: business.replace(/-/g, '_') as 'ammu_sammu' | 'konkan_fine_dine', audience }),
      messaging: createMessaging(adapters.messaging, {
        async register(userId, token) {
          const s = currentSession.current;
          if (!s || s.user.id !== userId) throw new Error('Session changed.');
          await services.registerDeviceToken(token, s.access_token);
          tokenSessions.set(`${userId}:${token}`, s.access_token);
        },
        async remove(userId, token) {
          const binding = `${userId}:${token}`;
          const accessToken = tokenSessions.get(binding);
          if (!accessToken) return;
          await services.unregisterDeviceToken(token, accessToken);
          tokenSessions.delete(binding);
        },
      }),
    };
  }, [business, audience, services]);
  const userId = session?.user.id;
  const key = userId ? preferenceKey(business, audience, userId) : '';
  const save = async (value: Preferences) => { await AsyncStorage.setItem(key, JSON.stringify(value)); };
  useEffect(() => {
    const generation = ++active.current;
    let subscribed = true;
    pushEnabled.current = false; setReady(false); setBusy(false); setPrefs(off); setAnalyticsMessage(''); setPushMessage('');
    if (!userId) { void controllers.analytics.setConsent(false); return () => { active.current++; }; }
    const stop = controllers.messaging.onHint(() => { if (subscribed && active.current === generation && currentSession.current?.user.id === userId) void refreshOrders(); });
    const resume = () => { if (subscribed && active.current === generation) void controllers.messaging.resume(userId).then(result => { if (subscribed && active.current === generation) setPushMessage(explain(result)); }).catch(() => { if (subscribed && active.current === generation) setPushMessage('Could not update notifications. Please try again.'); }); };
    void AsyncStorage.getItem(key).then(async raw => {
      let value = off;
      try { const parsed = raw ? JSON.parse(raw) : null; value = { analytics: parsed?.analytics === true, push: parsed?.push === true }; } catch { /* Invalid saved preferences default off. */ }
      if (!subscribed || active.current !== generation) return;
      setPrefs(value); pushEnabled.current = value.push; setReady(true);
      if (value.analytics) void controllers.analytics.setConsent(true).catch(() => { if (subscribed && active.current === generation) setAnalyticsMessage('Analytics is not available yet.'); });
      if (value.push) resume();
    }).catch(() => { if (subscribed && active.current === generation) { setReady(true); setAnalyticsMessage('Settings could not be restored on this device.'); } });
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      let next = off;
      try { const parsed = event.newValue ? JSON.parse(event.newValue) : null; next = { analytics: parsed?.analytics === true, push: parsed?.push === true }; } catch { /* Default off. */ }
      pushEnabled.current = next.push; setPrefs(next);
      void controllers.analytics.setConsent(next.analytics).catch(() => { if (subscribed) setAnalyticsMessage('Analytics is not available yet.'); });
      if (next.push) resume(); else { controllers.messaging.invalidate(); void controllers.messaging.disable().catch(() => {}); }
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    const appState = AppState.addEventListener('change', state => { if (state === 'active' && pushEnabled.current) resume(); });
    return () => { subscribed = false; active.current++; controllers.messaging.invalidate(); stop(); appState.remove(); if (Platform.OS === 'web' && typeof window !== 'undefined') window.removeEventListener('storage', onStorage); void controllers.analytics.setConsent(false); void controllers.messaging.disable().catch(() => {}); };
  }, [userId, key, controllers, refreshOrders, retryGeneration]);
  const setAnalytics = useCallback(async (enabled: boolean) => {
    const generation = active.current; setBusy(true); setAnalyticsMessage('');
    try {
      if (!enabled) await controllers.analytics.setConsent(false);
      const next = { ...prefs, analytics: enabled }; await save(next);
      if (generation !== active.current) return;
      setPrefs(next);
      if (enabled) await controllers.analytics.setConsent(true);
      if (generation === active.current) setAnalyticsMessage(enabled ? 'Analytics is on.' : 'Analytics is off.');
    } catch { if (generation === active.current) setAnalyticsMessage('Could not update analytics. Please try again.'); }
    finally { if (generation === active.current) setBusy(false); }
  }, [controllers, prefs, key]);
  const setPush = useCallback((enabled: boolean) => {
    if (!userId) return;
    const generation = active.current; setBusy(true); setPushMessage('');
    if (!enabled) {
      controllers.messaging.invalidate(); pushEnabled.current = false;
      const next = { ...prefs, push: false };
      setPrefs(next);
      void Promise.all([save(next), controllers.messaging.disable()]).then(() => {
        if (generation === active.current) setPushMessage('Notifications are off.');
      }).catch(() => { if (generation === active.current) setPushMessage('Could not fully update notifications. Please try again.'); })
        .finally(() => { if (generation === active.current) setBusy(false); });
      return;
    }
    // The call must begin here, within the click handler, before any await.
    void controllers.messaging.enable(userId).then(async result => {
      if (generation !== active.current) return;
      if (result.status === 'ready') { const next = { ...prefs, push: true }; await save(next); if (generation !== active.current) return; setPrefs(next); pushEnabled.current = true; }
      if (generation === active.current) setPushMessage(explain(result));
    }).catch(() => { void controllers.messaging.disable().catch(() => {}); if (generation === active.current) setPushMessage('Could not update notifications. Please try again.'); }).finally(() => { if (generation === active.current) setBusy(false); });
  }, [controllers, prefs, key, userId]);
  const signOut = useCallback(async () => { setBusy(true); active.current++; controllers.messaging.invalidate(); void controllers.analytics.setConsent(false); try { await controllers.messaging.disable().catch(() => {}); await services.auth.signOut(); } catch (error) { setRetryGeneration(value => value + 1); throw error; } finally { setBusy(false); } }, [controllers, services]);
  return { prefs, ready, busy, analyticsMessage, pushMessage, setAnalytics, setPush, signOut };
}
