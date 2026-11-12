import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import { initializeAnalytics, isSupported as analyticsSupported, logEvent, setAnalyticsCollectionEnabled, type Analytics } from 'firebase/analytics';
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported, onMessage, type Messaging } from 'firebase/messaging';
import type { AnalyticsPort, MessagingPort, TokenResult } from './index';

export type WebConfig = FirebaseOptions & { apiKey: string; projectId: string; appId: string; messagingSenderId: string; measurementId?: string };
function configured(config: Partial<WebConfig>): config is WebConfig {
  return !!(config.apiKey && config.projectId && config.appId && config.messagingSenderId);
}
function appFor(config: WebConfig) {
  // An app is scoped to its public Firebase project; never silently reuse a different project.
  const name = `market-${config.appId}`;
  return getApps().find(app => app.name === name) ?? initializeApp(config, name);
}
function clearAnalyticsCookies() {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  const host = location.hostname.split('.');
  for (const item of document.cookie.split(';')) {
    const name = item.trim().split('=')[0];
    if (!/^_ga(?:_|$)/.test(name)) continue;
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
    for (let i = 0; i < host.length - 1; i++) document.cookie = `${name}=; Max-Age=0; path=/; domain=${host.slice(i).join('.')}; SameSite=Lax`;
  }
}
export function createWebAnalytics(config: Partial<WebConfig>): AnalyticsPort {
  let analytics: Analytics | undefined;
  const setDisabled = (disabled: boolean) => {
    if (typeof window !== 'undefined' && config.measurementId) (window as unknown as Record<string, unknown>)[`ga-disable-${config.measurementId}`] = disabled;
  };
  return {
    async enable() {
      if (!configured(config) || !config.measurementId) throw new Error('Google Analytics is not configured.');
      if (!(await analyticsSupported())) throw new Error('Google Analytics is unsupported in this browser.');
      setDisabled(false);
      analytics ??= initializeAnalytics(appFor(config), { config: { send_page_view: false, page_location: `${location.origin}/`, page_referrer: '', page_title: 'App', allow_google_signals: false, allow_ad_personalization_signals: false } });
      setAnalyticsCollectionEnabled(analytics, true);
    },
    async disable() {
      setDisabled(true);
      if (analytics) setAnalyticsCollectionEnabled(analytics, false);
      clearAnalyticsCookies();
    },
    send(name, context) { if (analytics) logEvent(analytics, name, context); }
  };
}

/** workerUrl and scope must both be same-origin, and worker must live within scope. */
export function createWebMessaging(config: Partial<WebConfig>, options: { vapidKey?: string; workerUrl: string; scope: string }): MessagingPort {
  let messaging: Messaging | undefined;
  let unsubscribe: (() => void) | undefined;
  let listener: (() => void) | undefined;
  return {
    requestToken(): Promise<TokenResult> {
      if (!configured(config) || !options.vapidKey) return Promise.resolve({ status: 'unconfigured', reason: 'Firebase messaging or the public VAPID key is not configured.' });
      if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator)) return Promise.resolve({ status: 'unsupported', reason: 'This browser does not support web notifications.' });
      let worker: URL;
      let scope: URL;
      try {
        worker = new URL(options.workerUrl, location.href);
        scope = new URL(options.scope, location.href);
        if (worker.origin !== location.origin || scope.origin !== location.origin || !scope.pathname.endsWith('/') || !worker.pathname.startsWith(scope.pathname)) throw new Error();
      } catch { return Promise.resolve({ status: 'error', reason: 'The notification worker and its scope must be on this app origin and path.' }); }
      // Request immediately inside the caller's click handler, before any async SDK work.
      const permission = Notification.requestPermission();
      return (async (): Promise<TokenResult> => {
        try {
          if (await permission !== 'granted') return { status: 'denied', reason: 'Notification permission was not granted.' };
          if (!(await messagingSupported())) return { status: 'unsupported', reason: 'Firebase messaging is unsupported in this browser.' };
          for (const key of ['apiKey', 'projectId', 'appId', 'messagingSenderId'] as const) worker.searchParams.set(key, config[key]);
          const registration = await navigator.serviceWorker.register(worker.href, { scope: scope.pathname });
          messaging = getMessaging(appFor(config));
          const token = await getToken(messaging, { vapidKey: options.vapidKey, serviceWorkerRegistration: registration });
          if (!token) return { status: 'error', reason: 'Firebase did not return a notification token.' };
          if (listener) { unsubscribe?.(); unsubscribe = onMessage(messaging, () => listener?.()); }
          return { status: 'ready', token };
        } catch { return { status: 'error', reason: 'Could not initialize notifications. Check the browser and Firebase configuration.' }; }
      })();
    },
    async deleteToken() { unsubscribe?.(); unsubscribe = undefined; if (messaging) await deleteToken(messaging); },
    onHint(refresh) {
      listener = refresh;
      if (messaging) { unsubscribe?.(); unsubscribe = onMessage(messaging, () => listener?.()); }
      return () => { if (listener === refresh) { unsubscribe?.(); unsubscribe = undefined; listener = undefined; } };
    }
  };
}
