import { createWebAnalytics, createWebMessaging } from '@market/notifications/web';

/** Public configuration only; the stream verification flag requires operator verification. */
export function preferenceAdapters() {
  const config = {
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };
  const configuredBase = process.env.EXPO_PUBLIC_WEB_BASE_PATH || '/';
  // Invalid bases fail same-origin validation in the messaging adapter.
  const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`;
  return {
    analytics: createWebAnalytics(config, { enhancedMeasurementDisabled: process.env.EXPO_PUBLIC_FIREBASE_ANALYTICS_STREAM_VERIFIED === 'true' }),
    messaging: createWebMessaging(config, { vapidKey: process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY, workerUrl: `${base}firebase-messaging-worker.js`, scope: base }),
  };
}
