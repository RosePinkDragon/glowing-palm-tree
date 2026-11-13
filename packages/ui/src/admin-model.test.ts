import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderTransition, mergeOrderSnapshot, nextStatuses, ordersForFilter, parseRupees, rupeesInput } from './admin-model.ts';
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
