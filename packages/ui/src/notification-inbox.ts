import type { CustomerNotification } from '@market/services';

export const inboxPageSize = 20;

/** Merge a fetched page into the loaded list: one row per id, server order kept, a read mark is never undone by a stale page. */
export function mergeNotifications(current: readonly CustomerNotification[], incoming: readonly CustomerNotification[], append: boolean): CustomerNotification[] {
  const known = new Map<string, CustomerNotification>();
  for (const row of current) known.set(row.id.toLowerCase(), row);
  const merged = new Map<string, CustomerNotification>();
  for (const row of append ? [...current, ...incoming] : incoming) {
    const key = row.id.toLowerCase(), previous = known.get(key);
    merged.set(key, previous?.readAtISO && !row.readAtISO ? { ...row, readAtISO: previous.readAtISO } : row);
  }
  return [...merged.values()];
}

/** Mark rows read locally and reduce the unread count by the rows that really were unread. */
export function applyRead(items: readonly CustomerNotification[], unread: number | null, ids: readonly string[] | 'all', atISO: string): { items: CustomerNotification[]; unread: number | null } {
  const wanted = ids === 'all' ? null : new Set(ids.map(id => id.toLowerCase()));
  let changed = 0;
  const next = items.map(row => {
    if (row.readAtISO || (wanted && !wanted.has(row.id.toLowerCase()))) return row;
    changed++; return { ...row, readAtISO: atISO };
  });
  return { items: next, unread: ids === 'all' ? 0 : unread === null ? null : Math.max(0, unread - changed) };
}

/** Undo an optimistic read mark that the server did not accept. */
export function revertRead(items: readonly CustomerNotification[], id: string): CustomerNotification[] {
  return items.map(row => row.id.toLowerCase() === id.toLowerCase() ? { ...row, readAtISO: null } : row);
}

const zone = 'Asia/Kolkata';
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: zone });
export interface NotificationDay { key: string; label: string; items: CustomerNotification[] }
/** Group newest-first rows by India calendar day: Today, Yesterday, then "4 November". */
export function groupByDay(items: readonly CustomerNotification[], now: Date = new Date()): NotificationDay[] {
  const today = now.toLocaleDateString('en-CA', { timeZone: zone }), yesterday = new Date(now.getTime() - 86_400_000).toLocaleDateString('en-CA', { timeZone: zone });
  const days: NotificationDay[] = [];
  for (const item of items) {
    const key = dayKey(item.createdAtISO), last = days.at(-1);
    if (last?.key === key) { last.items.push(item); continue; }
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : new Date(item.createdAtISO).toLocaleDateString('en-IN', { timeZone: zone, day: 'numeric', month: 'long' });
    days.push({ key, label, items: [item] });
  }
  return days;
}

export const inboxTime = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).toLowerCase();
export const unreadLabel = (count: number | null) => count && count > 0 ? ` (${count > 99 ? '99+' : count} unread)` : '';
