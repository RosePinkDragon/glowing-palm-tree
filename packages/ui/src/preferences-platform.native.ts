import { unavailableNativeMessaging, type AnalyticsPort, type MonitoringPort } from '@market/notifications';
const analytics: AnalyticsPort = {
  async enable() { throw new Error('Analytics is not available on this device.'); },
  async disable() {},
  send() {},
};
const performance: MonitoringPort = { async enable() {}, async disable() {} };
export function preferenceAdapters() { return { analytics, performance, errors: performance, messaging: unavailableNativeMessaging() }; }
