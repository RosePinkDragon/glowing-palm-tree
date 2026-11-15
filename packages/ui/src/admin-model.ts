import { orderStatusTransitions, type Order, type OrderStatus } from '@market/core';

export type QueueFilter = 'placed' | 'accepted' | 'preparing' | 'out_for_delivery' | 'complete';
export const queueFilters: QueueFilter[] = ['placed', 'accepted', 'preparing', 'out_for_delivery', 'complete'];
export const statusLabel = (status: OrderStatus | QueueFilter) => ({ placed: 'Placed', accepted: 'Accepted', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', complete: 'Complete' })[status];
export function ordersForFilter(orders: readonly Order[], filter: QueueFilter): Order[] {
  return orders.filter(order => filter === 'complete' ? order.status === 'delivered' || order.status === 'cancelled' : order.status === filter);
}
export function nextStatuses(status: OrderStatus): readonly OrderStatus[] { return orderStatusTransitions[status]; }
// A snapshot determines which orders remain visible, while versions prevent an
// older response from replacing a newer observation of the same order.
export function mergeOrderSnapshot(current: readonly Order[], incoming: readonly Order[]): Order[] {
  const previous = new Map(current.map(order => [order.id, order]));
  return incoming.map(order => {
    const existing = previous.get(order.id);
    return existing && existing.version > order.version ? existing : order;
  });
}
export function applyOrderTransition(current: readonly Order[], incoming: Order): { orders: Order[]; observed: Order | undefined } {
  const existing = current.find(order => order.id === incoming.id);
  if (!existing) return { orders: [...current], observed: undefined };
  const observed = existing.version > incoming.version ? existing : incoming;
  return { orders: current.map(order => order.id === incoming.id ? observed : order), observed };
}
/** Parse decimal rupees without floating point arithmetic. */
export function parseRupees(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
}
export function rupeesInput(paise: number): string { return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`; }

// ---- Orders queue (#100) ----
/** Filter labels follow the owners' design; the New filter is the `placed` status. */
export const filterLabel = (filter: QueueFilter) => ({ placed: 'New', accepted: 'Accepted', preparing: 'Preparing', out_for_delivery: 'Out', complete: 'Done' })[filter];
export function filterForStatus(status: OrderStatus): QueueFilter { return status === 'delivered' || status === 'cancelled' ? 'complete' : status; }
export function filterCounts(orders: readonly Order[]): Record<QueueFilter, number> {
  const counts: Record<QueueFilter, number> = { placed: 0, accepted: 0, preparing: 0, out_for_delivery: 0, complete: 0 };
  for (const order of orders) counts[filterForStatus(order.status)]++;
  return counts;
}
/** Tab badge: orders waiting for acceptance. */
export const newOrderCount = (orders: readonly Order[]) => orders.filter(order => order.status === 'placed').length;
/** Short order reference from the id (last six hex digits). #47 replaces this with the restaurant order number. */
export function orderReference(id: string): string { return `#${id.replace(/[^0-9a-fA-F]/g, '').slice(-6).toUpperCase()}`; }
/** "just now", "N min ago", "N h ago" or "N d ago"; clock skew (future times) reads as "just now". */
export function elapsedLabel(createdAtISO: string, now: number): string {
  const created = Date.parse(createdAtISO);
  const minutes = Number.isNaN(created) ? 0 : Math.max(0, Math.floor((now - created) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}
/** One-line address summary for cards (#48 will supply the area). */
export function shortAddress(line: string, max = 40): string {
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
