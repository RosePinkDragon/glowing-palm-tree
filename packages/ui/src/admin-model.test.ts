import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderTransition, elapsedLabel, filterCounts, filterForStatus, filterLabel, mergeOrderSnapshot, newOrderCount, nextStatuses, orderReference, ordersForFilter, parseRupees, queueFilters, rupeesInput, shortAddress } from './admin-model.ts';
import type { Order } from '@market/core';

test('rupees are converted exactly and invalid or unsafe amounts rejected', () => {
  assert.equal(parseRupees(' 1.01 '), 101);
  assert.equal(parseRupees('0.1'), 10);
  assert.equal(parseRupees('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  for (const value of ['', '-1', '1.001', '1e2', '.5', '90071992547409.92']) assert.equal(parseRupees(value), null);
  assert.equal(rupeesInput(101), '1.01');
});
test('queue groups final statuses and offers only legal transitions', () => {
  const orders = [{ status: 'delivered' }, { status: 'cancelled' }, { status: 'placed' }] as Order[];
  assert.equal(ordersForFilter(orders, 'complete').length, 2);
  assert.equal(ordersForFilter(orders, 'placed').length, 1);
  assert.deepEqual(nextStatuses('out_for_delivery'), ['delivered']);
  assert.deepEqual(nextStatuses('cancelled'), []);
});
test('late transition and snapshot responses cannot roll back a newer order or restore a removed one', () => {
  const order = (version: number, status: Order['status']) => ({ id: 'o', version, status }) as Order;
  const v2 = order(2, 'accepted');
  const v3 = order(3, 'preparing');
  const live = mergeOrderSnapshot([v2], [v3]);
  const lateTransition = applyOrderTransition(live, v2);
  assert.equal(lateTransition.observed?.status, 'preparing');
  assert.deepEqual(lateTransition.orders, [v3]);
  assert.deepEqual(mergeOrderSnapshot(lateTransition.orders, [v2]), [v3]);
  const removed = mergeOrderSnapshot(live, []);
  assert.deepEqual(applyOrderTransition(removed, v2), { orders: [], observed: undefined });
});
test('queue filters count each status, label the design filters and drive the New badge', () => {
  const orders = ['placed', 'placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'].map(status => ({ status }) as Order);
  assert.deepEqual(filterCounts(orders), { placed: 2, accepted: 1, preparing: 1, out_for_delivery: 1, complete: 2 });
  assert.equal(newOrderCount(orders), 2);
  assert.equal(newOrderCount([]), 0);
  assert.deepEqual(queueFilters.map(filterLabel), ['New', 'Accepted', 'Preparing', 'Out', 'Done']);
  assert.equal(filterForStatus('cancelled'), 'complete');
  assert.equal(filterForStatus('placed'), 'placed');
});
test('order reference, elapsed time and address summary', () => {
  assert.equal(orderReference('40000000-0000-4000-8000-0000000abc01'), '#0ABC01');
  assert.equal(orderReference('abc'), '#ABC');
  const now = Date.parse('2026-11-16T10:00:00Z');
  assert.equal(elapsedLabel('2026-11-16T09:59:30Z', now), 'just now');
  assert.equal(elapsedLabel('2026-11-16T10:05:00Z', now), 'just now');
  assert.equal(elapsedLabel('2026-11-16T09:58:00Z', now), '2 min ago');
  assert.equal(elapsedLabel('2026-11-16T08:30:00Z', now), '1 h ago');
  assert.equal(elapsedLabel('2026-11-14T10:00:00Z', now), '2 d ago');
  assert.equal(elapsedLabel('not a date', now), 'just now');
  assert.equal(shortAddress('  Station   Road '), 'Station Road');
  assert.equal(shortAddress('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
});
