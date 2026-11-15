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
