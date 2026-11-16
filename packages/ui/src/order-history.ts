import type { Order } from '@market/core';
import type { OrderPage, OrderPageOptions } from '@market/services';

/** Keep server page order and prefer the newest observed status version. */
export function mergeHistory(current: readonly Order[], incoming: readonly Order[], append: boolean): Order[] {
  const versions = new Map<string, Order>();
  for (const order of [...current, ...incoming]) {
    const known = versions.get(order.id);
    if (!known || order.version >= known.version) versions.set(order.id, order);
  }
  const ids = [...new Set((append ? [...current, ...incoming] : incoming).map(order => order.id))];
  return ids.map(id => versions.get(id)!);
}

/** Refresh the pages already loaded, rather than dropping back to page one. */
export async function readHistoryPages(read: (options?: OrderPageOptions) => Promise<OrderPage>, depth: number, previousTail?: Order) {
  let orders: Order[] = [], nextCursor: OrderPage['nextCursor'] = null, pages = 0;
  const micros = (timestamp: string) => BigInt(Date.parse(timestamp)) * 1000n + BigInt((timestamp.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6) || '0');
  const coversTail = () => !previousTail || !nextCursor || micros(nextCursor.createdAtISO) < micros(previousTail.createdAtISO) ||
    (micros(nextCursor.createdAtISO) === micros(previousTail.createdAtISO) && nextCursor.id <= previousTail.id);
  do {
    const page = await read({ cursor: nextCursor });
    orders = mergeHistory(orders, page.orders, true);
    nextCursor = page.nextCursor; pages++;
  } while (nextCursor && (pages < depth || !coversTail()));
  return { orders, nextCursor, pages };
}

/** Customer timeline deliberately consumes only public status/timestamp history. */
export const trackingStages = [
  { status: 'placed', label: 'Order placed' },
  { status: 'accepted', label: 'Accepted by the restaurant' },
  { status: 'preparing', label: 'Being prepared' },
  { status: 'out_for_delivery', label: 'Out for delivery' },
  { status: 'delivered', label: 'Delivered' },
] as const;
export function trackingTimeline(order: Order) {
  const current = trackingStages.findIndex(stage => stage.status === order.status);
  return trackingStages.map((stage, index) => ({ ...stage,
    time: order.history?.find(event => event.status === stage.status)?.createdAtISO ?? (stage.status === 'placed' ? order.createdAtISO : null),
    state: order.status === 'cancelled' ? 'stopped' : index < current ? 'complete' : index === current ? 'current' : 'pending',
  }));
}
export function terminalTime(order: Order): string | null {
  return order.history?.find(event => event.status === order.status)?.createdAtISO ?? null;
}
export function deliveryMinutes(order: Order): number | null {
  const arrival = terminalTime(order);
  const elapsed = arrival ? Date.parse(arrival) - Date.parse(order.createdAtISO) : NaN;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 60000) : null;
}
export const trackingHeadlines: Record<Order['status'], string> = {
  placed: 'Your order is with the restaurant', accepted: 'The restaurant accepted your order',
  preparing: 'Your food is being prepared', out_for_delivery: 'Your food is on its way',
  delivered: 'Your food has arrived', cancelled: 'The restaurant cancelled your order',
};
