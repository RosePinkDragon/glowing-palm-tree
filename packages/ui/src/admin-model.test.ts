import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOrderTransition, callLink, canCancel, historyLine, historyNewestFirst, mapsUrl, nextAction, placedLabel, elapsedLabel, filterCounts, filterForStatus, filterLabel, mergeOrderSnapshot, newOrderCount, nextStatuses, orderReference, ordersForFilter, parseRupees, queueFilters, rupeesInput, shortAddress, cardArea, pinCheckLine } from './admin-model.ts';
import type { Order } from '@market/core';

test('rupees are converted exactly and invalid or unsafe amounts rejected', () => {
  assert.equal(parseRupees(' 1.01 '), 101);
  assert.equal(parseRupees('0.1'), 10);
  assert.equal(parseRupees('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  for (const value of ['', '-1', '1.001', '1e2', '.5', '90071992547409.92']) assert.equal(parseRupees(value), null);
  assert.equal(rupeesInput(101), '1.01');
  assert.equal(rupeesInput(32000), '320', 'whole prices edit without paise');
  assert.equal(rupeesInput(0), '0');
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
  const saved = { address: { label: 'home' as const, house: '3', streetArea: 'Station Road', locationSource: 'pin' as const }, delivery: { name: 'N', phone: 'P', addressLine: '3, Station Road, Khed' } };
  assert.equal(cardArea({ ...saved, kitchenDistanceM: 2400 }), 'Station Road · 2.4 km');
  assert.equal(cardArea({ ...saved, kitchenDistanceM: 800 }), 'Station Road · 800 m');
  assert.equal(cardArea({ ...saved, kitchenDistanceM: null }), 'Station Road', 'unknown distance is omitted');
  assert.equal(cardArea({ delivery: saved.delivery, kitchenDistanceM: 2400 }), '3, Station Road, Khed', 'legacy orders keep the typed line');
  assert.equal(pinCheckLine({ ...saved, kitchenDistanceM: 1200 }), '1.2 km · pin checked inside delivery area');
  assert.equal(pinCheckLine({ ...saved, kitchenDistanceM: null }), '');
  assert.equal(pinCheckLine({ kitchenDistanceM: 1200 }), '', 'legacy orders make no in-area claim');
});

test('details next action follows the state machine and terminal orders have none', () => {
  assert.deepEqual(['placed', 'accepted', 'preparing', 'out_for_delivery'].map(status => nextAction(status as Order['status'])?.label), ['Accept order', 'Start preparing', 'Out for delivery', 'Mark delivered']);
  assert.deepEqual(['placed', 'accepted', 'preparing', 'out_for_delivery'].map(status => nextAction(status as Order['status'])?.status), ['accepted', 'preparing', 'out_for_delivery', 'delivered']);
  assert.equal(nextAction('delivered'), null);
  assert.equal(nextAction('cancelled'), null);
  assert.deepEqual(['placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'].map(status => canCancel(status as Order['status'])), [true, true, true, false, false, false]);
});
test('call and maps links are built only from valid data', () => {
  assert.equal(callLink('98765 43210'), 'tel:+919876543210');
  assert.equal(callLink('+91 98765 43210'), 'tel:+919876543210');
  assert.equal(callLink('12345'), null);
  assert.equal(callLink(''), null);
  assert.equal(mapsUrl({ latitude: 17.7, longitude: 73.4 }), 'https://www.google.com/maps/search/?api=1&query=17.7,73.4');
  assert.equal(mapsUrl(undefined), null);
  assert.equal(mapsUrl({ latitude: 91, longitude: 73 }), null);
  assert.equal(mapsUrl({ latitude: 17, longitude: Number.NaN }), null);
});
test('history lines show the owner snapshot only when present, newest first', () => {
  assert.equal(historyLine({ status: 'accepted', createdAtISO: '2026-01-01T07:12:00Z', actorName: ' Suresh ' }), 'Accepted by Suresh');
  assert.equal(historyLine({ status: 'placed', createdAtISO: '2026-01-01T07:10:00Z' }), 'Placed');
  assert.equal(historyLine({ status: 'out_for_delivery', createdAtISO: '2026-01-01T07:10:00Z', actorName: '  ' }), 'Out for delivery');
  assert.deepEqual(historyNewestFirst([{ status: 'placed', createdAtISO: '2026-01-01T07:10:00Z' }, { status: 'accepted', createdAtISO: '2026-01-01T07:12:00Z' }]).map(entry => entry.status), ['accepted', 'placed']);
  assert.deepEqual(historyNewestFirst(undefined), []);
});
test('placed label reads today or the date', () => {
  const now = Date.parse('2026-11-16T12:00:00');
  assert.match(placedLabel('2026-11-16T09:40:00', now), /^Placed today, \d{1,2}:40 (am|pm)$/);
  assert.match(placedLabel('2026-11-14T09:40:00', now), /^Placed 14 Nov, \d{1,2}:40 (am|pm)$/);
  assert.equal(placedLabel('bad', now), 'Placed');
});

test('an order whose customer details were removed after account deletion still renders (#51)', () => {
  assert.equal(shortAddress(null), '');
  assert.equal(shortAddress(undefined), '');
  assert.equal(callLink(null), null);
  assert.equal(callLink(undefined), null);
  const purged = { delivery: { name: 'Deleted customer', phone: '', addressLine: 'Address removed' }, kitchenDistanceM: null } as Pick<Order, 'address' | 'delivery' | 'kitchenDistanceM'>;
  assert.equal(cardArea(purged), 'Address removed');
  assert.equal(callLink(purged.delivery.phone), null);
  assert.equal(cardArea({ delivery: { name: 'x', phone: '', addressLine: null as unknown as string }, kitchenDistanceM: null } as Pick<Order, 'address' | 'delivery' | 'kitchenDistanceM'>), '', 'even a null line cannot throw');
});
