import assert from 'node:assert/strict';
import test from 'node:test';
import type { CustomerNotification } from '@market/services';
import { applyRead, groupByDay, mergeNotifications, revertRead, unreadLabel } from './notification-inbox.ts';

const row = (n: number, createdAtISO: string, readAtISO: string | null = null): CustomerNotification => ({
  id: `55000000-0000-4000-8000-${String(n).padStart(12, '0')}`, businessId: 'ammu-sammu', orderId: `56000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  eventStatus: 'placed', title: `T${n}`, body: `B${n}`, readAtISO, createdAtISO,
});

test('merging a next page appends, drops duplicates and keeps server order', () => {
  const a = row(3, '2026-11-17T10:00:00Z'), b = row(2, '2026-11-17T09:00:00Z'), c = row(1, '2026-11-16T09:00:00Z');
  const merged = mergeNotifications([a, b], [b, c], true);
  assert.deepEqual(merged.map(r => r.title), ['T3', 'T2', 'T1']);
});

test('a refresh replaces the list but a stale page cannot make a read row unread again', () => {
  const read = row(2, '2026-11-17T09:00:00Z', '2026-11-17T11:00:00Z');
  const merged = mergeNotifications([read], [row(4, '2026-11-17T12:00:00Z'), row(2, '2026-11-17T09:00:00Z')], false);
  assert.deepEqual(merged.map(r => r.title), ['T4', 'T2']);
  assert.equal(merged[1]!.readAtISO, '2026-11-17T11:00:00Z');
  assert.equal(mergeNotifications([row(1, '2026-11-16T09:00:00Z')], [], false).length, 0, 'a refresh is not an append');
});

test('marking one read lowers the unread count once, and never below zero', () => {
  const items = [row(2, '2026-11-17T10:00:00Z'), row(1, '2026-11-17T09:00:00Z', '2026-11-17T09:30:00Z')];
  const first = applyRead(items, 3, [items[0]!.id], '2026-11-17T12:00:00Z');
  assert.equal(first.unread, 2); assert.equal(first.items[0]!.readAtISO, '2026-11-17T12:00:00Z');
  assert.equal(applyRead(first.items, first.unread, [items[0]!.id], '2026-11-17T12:05:00Z').unread, 2, 'already read');
  assert.equal(applyRead(items, 0, [items[0]!.id], 'x').unread, 0);
  assert.equal(applyRead(items, null, [items[0]!.id], 'x').unread, null, 'unknown stays unknown');
  assert.equal(applyRead(items, 3, ['55000000-0000-4000-8000-000000000099'], 'x').unread, 3, 'unloaded ids change nothing');
});

test('mark all read zeroes the count and reverting restores one row', () => {
  const items = [row(2, '2026-11-17T10:00:00Z'), row(1, '2026-11-17T09:00:00Z')];
  const all = applyRead(items, 7, 'all', '2026-11-17T12:00:00Z');
  assert.equal(all.unread, 0); assert.ok(all.items.every(r => r.readAtISO));
  assert.equal(revertRead(all.items, items[0]!.id)[0]!.readAtISO, null);
  assert.ok(revertRead(all.items, items[0]!.id)[1]!.readAtISO);
});

test('days are grouped in India time, newest first', () => {
  const now = new Date('2026-11-17T08:00:00Z');
  const groups = groupByDay([row(5, '2026-11-17T07:00:00Z'), row(4, '2026-11-16T20:00:00Z'), row(3, '2026-11-16T10:00:00Z'), row(2, '2026-11-04T08:20:00Z')], now);
  // 20:00Z on the 16th is 1:30 am on the 17th in India.
  assert.deepEqual(groups.map(g => [g.label, g.items.length]), [['Today', 2], ['Yesterday', 1], ['4 November', 1]]);
});

test('the unread label is empty for none and caps at 99+', () => {
  assert.equal(unreadLabel(0), ''); assert.equal(unreadLabel(null), ''); assert.equal(unreadLabel(2), ' (2 unread)'); assert.equal(unreadLabel(150), ' (99+ unread)');
});
