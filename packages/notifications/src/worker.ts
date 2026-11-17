// Bundle this module as a same-origin service worker; never put private data in pushes.
import { notificationPath, openNotification } from './worker-routing';
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
type Worker = { registration: { scope: string; showNotification(title: string, options: { body: string; data?: unknown }): Promise<void> }; clients: Parameters<typeof openNotification>[2]; addEventListener(type: string, listener: (event: { notification: { data: unknown; close(): void }; waitUntil(value: Promise<unknown>): void }) => void): void };
const worker = self as unknown as Worker;
// Register before Firebase so only our fixed same-origin destination handles taps.
worker.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(openNotification(event.notification.data, worker.registration.scope, worker.clients)); });
const params = new URL(self.location.href).searchParams;
const apiKey = params.get('apiKey');
const projectId = params.get('projectId');
const appId = params.get('appId');
const messagingSenderId = params.get('messagingSenderId');
if (apiKey && projectId && appId && messagingSenderId) {
  const messaging = getMessaging(initializeApp({ apiKey, projectId, appId, messagingSenderId }));
  // Generic lock-screen copy; the opaque id is only a routing hint, never authorization.
  onBackgroundMessage(messaging, payload => {
    const path = notificationPath(payload.data);
    const data = path ? { kind: 'order_changed', order_id: path.slice(7) } : undefined;
    void worker.registration.showNotification('Updates available', { body: 'Open the app to see the latest updates.', data });
  });
}
