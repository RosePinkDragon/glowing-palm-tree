import { initializeApp, getApps, type FirebaseOptions } from 'firebase/app';
import { initializeAnalytics, isSupported as analyticsSupported, logEvent, setAnalyticsCollectionEnabled, type Analytics } from 'firebase/analytics';
import { getMessaging, getToken, deleteToken, isSupported as messagingSupported, onMessage, type Messaging } from 'firebase/messaging';
import { scrubBreadcrumb, scrubEvent, setErrorReporter, setTracer } from './index.ts';
import type { AnalyticsPort, MessagingPort, MonitoringPort, TokenResult } from './index';

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
/** Set this attestation only after verifying the GA4 stream in the Firebase/Google Analytics console. */
export function createWebAnalytics(config: Partial<WebConfig>, policy?: { enhancedMeasurementDisabled?: boolean }): AnalyticsPort {
  let analytics: Analytics | undefined;
  const setDisabled = (disabled: boolean) => {
    if (typeof window !== 'undefined' && config.measurementId) (window as unknown as Record<string, unknown>)[`ga-disable-${config.measurementId}`] = disabled;
  };
  return {
    async enable() {
      if (policy?.enhancedMeasurementDisabled !== true) throw new Error('Google Analytics is unavailable until Enhanced Measurement is disabled in the GA4 stream and explicitly verified.');
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

/** Firebase Performance, loaded with a dynamic import only after consent. Needs the same public config as analytics; without it enable() throws and nothing loads. */
export function createWebPerformance(config: Partial<WebConfig>): MonitoringPort {
  let perf: import('firebase/performance').FirebasePerformance | undefined;
  let consentVersion = 0;
  return {
    async enable() {
      if (!configured(config)) throw new Error('Firebase Performance is not configured.');
      const sdk = await import('firebase/performance');
      // Performance only supports the default app. initializeApp rejects a conflicting config.
      perf ??= sdk.initializePerformance(initializeApp(config), { instrumentationEnabled: false, dataCollectionEnabled: false });
      const current = perf;
      const enabled = ++consentVersion;
      setTracer(name => {
        const startedAt = Date.now();
        const start = performance.now();
        return () => {
          if (enabled !== consentVersion) return;
          // Firebase classifies observed browser User Timing measures as custom traces.
          // Open that gate only during the synchronous record of this app-owned trace.
          current.dataCollectionEnabled = true;
          try { sdk.trace(current, name).record(startedAt, Math.max(performance.now() - start, 0.001)); }
          finally { current.dataCollectionEnabled = false; }
        };
      });
    },
    async disable() {
      consentVersion++;
      setTracer(undefined);
      if (perf) perf.dataCollectionEnabled = false;
    }
  };
}

type SentryInit = Parameters<typeof import('@sentry/browser').init>[0];
/** Errors only. Sentry 11 replaced `sendDefaultPii` with `dataCollection`; everything personal is switched off here, and nothing for replay or tracing is configured. */
export function webSentryOptions(options: { dsn?: string; environment?: string; release?: string }, isActive: () => boolean = () => true): NonNullable<SentryInit> {
  return {
    dsn: options.dsn,
    environment: options.environment || undefined,
    release: options.release || undefined,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    maxBreadcrumbs: 20,
    integrations: defaults => defaults.filter(integration => integration.name !== 'BrowserSession'),
    beforeSend: event => isActive() ? scrubEvent(event as never) : null,
    beforeBreadcrumb: breadcrumb => isActive() ? scrubBreadcrumb(breadcrumb as never) : null,
  };
}
/** Sentry for web, loaded with a dynamic import only after consent and only when a DSN is configured. Withdrawal closes the client. */
export function createWebErrorReporting(options: { dsn?: string; environment?: string; release?: string }): MonitoringPort {
  let sentry: typeof import('@sentry/browser') | undefined;
  let active = false;
  return {
    async enable() {
      if (!options.dsn) throw new Error('Error reports are not configured.');
      sentry ??= await import('@sentry/browser');
      const sdk = sentry;
      active = true;
      sdk.init(webSentryOptions(options, () => active));
      setErrorReporter(error => { sdk.captureException(error); });
    },
    async disable() {
      setErrorReporter(undefined);
      active = false;
      // Not close(0): the SDK treats a falsy timeout as "wait until everything is sent". 1 ms stops the client without a send window.
      if (sentry) await sentry.close(1);
    }
  };
}

/** workerUrl and scope must both be same-origin, and worker must live within scope. */
export function createWebMessaging(config: Partial<WebConfig>, options: { vapidKey?: string; workerUrl: string; scope: string }): MessagingPort {
  let messaging: Messaging | undefined;
  let unsubscribe: (() => void) | undefined;
  let listener: (() => void) | undefined;
  return {
    requestToken(): Promise<TokenResult> { return token(true); },
    resumeToken(): Promise<TokenResult> { return token(false); },
    async deleteToken() { unsubscribe?.(); unsubscribe = undefined; if (messaging) await deleteToken(messaging); },
    onHint(refresh) {
      listener = refresh;
      if (messaging) { unsubscribe?.(); unsubscribe = onMessage(messaging, () => listener?.()); }
      return () => { if (listener === refresh) { unsubscribe?.(); unsubscribe = undefined; listener = undefined; } };
    }
  };
  function token(prompt: boolean): Promise<TokenResult> {
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
      const permission = prompt ? Notification.requestPermission() : Promise.resolve(Notification.permission);
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
    }
}
