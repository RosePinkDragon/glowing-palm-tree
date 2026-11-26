import { formatDistance, orderStatusTransitions, type Order, type OrderStatus } from '@market/core';
import { indianPhone } from './support-model.ts';

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
/** Price field text: whole rupees ("320") unless the price has paise ("1.01"). */
export function rupeesInput(paise: number): string { return paise % 100 === 0 ? String(paise / 100) : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`; }

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
/** Queue-card location line (#100): "Station Road · 2.4 km" for saved-address orders (distance omitted when unknown), the shortened typed line for legacy orders. */
export function cardArea(order: Pick<Order, 'address' | 'delivery' | 'kitchenDistanceM'>): string {
  if (!order.address) return shortAddress(order.delivery.addressLine);
  const distance = formatDistance(order.kitchenDistanceM);
  return distance ? `${order.address.streetArea} · ${distance}` : order.address.streetArea;
}

/** Order-details line (#100): the kitchen distance plus the guarantee that the server only accepts in-area pins; empty for legacy orders or an unknown distance. */
export function pinCheckLine(order: Pick<Order, 'address' | 'kitchenDistanceM'>): string {
  const distance = order.address ? formatDistance(order.kitchenDistanceM) : '';
  return distance ? `${distance} · pin checked inside delivery area` : '';
}

/** One-line address summary for cards. */
export function shortAddress(line: string | null | undefined, max = 40): string {
  const text = (line ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// ---- Order details (#101) ----
const nextActionLabels: Partial<Record<OrderStatus, string>> = { placed: 'Accept order', accepted: 'Start preparing', preparing: 'Out for delivery', out_for_delivery: 'Mark delivered' };
/** The forward step for the details footer; the first non-cancel transition of the state machine. Terminal orders have none. */
export function nextAction(status: OrderStatus): { status: OrderStatus; label: string } | null {
  const next = nextStatuses(status).find(candidate => candidate !== 'cancelled');
  return next ? { status: next, label: nextActionLabels[status] ?? `Mark ${statusLabel(next).toLowerCase()}` } : null;
}
export const canCancel = (status: OrderStatus) => nextStatuses(status).includes('cancelled');
/** Dialer link from the customer's phone, or null when it is not a valid Indian number. */
export function callLink(phone: string | null | undefined): string | null { const number = indianPhone(phone ?? ''); return number ? `tel:+${number}` : null; }
/** Google Maps search link for the delivery pin; null when there is no valid pin (#48 adds a structured address). */
export function mapsUrl(location: Order['location']): string | null {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return null;
  if (Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180) return null;
  return `https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
}
/** "12:40 pm" in the device's locale clock. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}
/** "Placed today, 12:40 pm", or "Placed 14 Nov, 12:40 pm" for an earlier day. */
export function placedLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Placed';
  const today = new Date(now);
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return `Placed ${sameDay ? 'today' : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${clockTime(iso)}`;
}
/** History text for one step: "Accepted by Suresh", or just "Placed" when no owner name was snapshotted. */
export function historyLine(entry: NonNullable<Order['history']>[number]): string {
  const name = entry.actorName?.trim();
  return name ? `${statusLabel(entry.status)} by ${name}` : statusLabel(entry.status);
}
/** Newest step first, as in the design. */
export const historyNewestFirst = (history: Order['history']) => [...(history ?? [])].sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
