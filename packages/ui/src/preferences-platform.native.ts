import { unavailableNativeMessaging, type AnalyticsPort } from '@market/notifications';
const analytics: AnalyticsPort = {
  async enable() { throw new Error('Analytics is not available on this device.'); },
  async disable() {},
  send() {},
};
export function preferenceAdapters() { return { analytics, messaging: unavailableNativeMessaging() }; }
