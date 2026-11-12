import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStatuses, ordersForFilter, parseRupees, rupeesInput } from './admin-model.ts';
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
