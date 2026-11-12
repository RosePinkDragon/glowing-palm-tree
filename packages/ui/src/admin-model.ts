import { orderStatusTransitions, type Order, type OrderStatus } from '@market/core';

export type QueueFilter = 'placed' | 'accepted' | 'preparing' | 'out_for_delivery' | 'complete';
export const queueFilters: QueueFilter[] = ['placed', 'accepted', 'preparing', 'out_for_delivery', 'complete'];
export const statusLabel = (status: OrderStatus | QueueFilter) => ({ placed: 'Placed', accepted: 'Accepted', preparing: 'Preparing', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled', complete: 'Complete' })[status];
export function ordersForFilter(orders: readonly Order[], filter: QueueFilter): Order[] {
  return orders.filter(order => filter === 'complete' ? order.status === 'delivered' || order.status === 'cancelled' : order.status === filter);
}
export function nextStatuses(status: OrderStatus): readonly OrderStatus[] { return orderStatusTransitions[status]; }
/** Parse decimal rupees without floating point arithmetic. */
export function parseRupees(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return paise <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(paise) : null;
}
export function rupeesInput(paise: number): string { return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`; }
