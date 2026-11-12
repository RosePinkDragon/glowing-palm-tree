// Bundle this module as a same-origin service worker; never put private data in pushes.
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
const params = new URL(self.location.href).searchParams;
const apiKey = params.get('apiKey');
const projectId = params.get('projectId');
const appId = params.get('appId');
const messagingSenderId = params.get('messagingSenderId');
if (apiKey && projectId && appId && messagingSenderId) {
  const messaging = getMessaging(initializeApp({ apiKey, projectId, appId, messagingSenderId }));
  // A generic hint only: ignore all provider payload data and notification content.
  onBackgroundMessage(messaging, () => {
    void (self as unknown as { registration: { showNotification(title: string, options: { body: string }): Promise<void> } }).registration.showNotification('Updates available', { body: 'Open the app to see the latest updates.' });
  });
}
