const orderId = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Never interpret payload URLs, names or other private content. */
export function notificationPath(data: unknown): string {
  const value = data as { kind?: unknown; order_id?: unknown } | null;
  return value?.kind === 'order_changed' && typeof value.order_id === 'string' && orderId.test(value.order_id) ? `orders/${value.order_id}` : '';
}
type Window = { url: string; postMessage(message: unknown, transfer: Transferable[]): void; focus(): Promise<unknown> };
type Clients = { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<Window[]>; openWindow(url: string): Promise<unknown> };
/** A cooperating mounted app accepts a tap without reloading its in-memory drafts. */
function acceptTap(window: Window, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = (accepted: boolean) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(accepted); };
    const timer = setTimeout(() => finish(false), 500);
    channel.port1.onmessage = event => finish(event.data?.accepted === true);
    try { window.postMessage({ type: 'market:notification-tap', path }, [channel.port2]); }
    catch { finish(false); }
  });
}
/** Only a user notification tap calls this. Uncooperative tabs remain intact. */
export async function openNotification(data: unknown, scope: string, clients: Clients) {
  const base = new URL(scope); const target = new URL(notificationPath(data), base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return;
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const window of windows) {
    const url = new URL(window.url);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) continue;
    try { if (await acceptTap(window, `/${notificationPath(data)}`)) { await window.focus(); return; } } catch { /* A closing tab can fail; open a new one. */ }
  }
  await clients.openWindow(target.href);
}
