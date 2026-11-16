import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Order } from '@market/core';
import { deliveryMinutes, terminalTime, trackingHeadlines, trackingTimeline, mergeHistory, readHistoryPages } from './order-history.ts';

const order = (id: string, version = 1) => ({ id, version } as Order);
test('append deduplicates boundaries and never regresses an observed order version', () => {
  assert.deepEqual(mergeHistory([order('a', 3), order('b')], [order('a', 2), order('c')], true), [order('a', 3), order('b'), order('c')]);
});
test('refresh follows server order and drops absent rows while keeping newer observed versions', () => {
  assert.deepEqual(mergeHistory([order('old'), order('a', 3)], [order('new'), order('a', 2)], false), [order('new'), order('a', 3)]);
});
test('realtime refresh retains the loaded depth, deduplicates pages, and stops at the end', async () => {
  const cursor = { createdAtISO: '2026-11-15T00:00:00.000001Z', id: 'cursor' };
  const calls: unknown[] = [];
  const result = await readHistoryPages(async options => {
    calls.push(options?.cursor);
    return options?.cursor ? { orders: [order('b'), order('c')], nextCursor: null } : { orders: [order('a'), order('b')], nextCursor: cursor };
  }, 4);
  assert.deepEqual(calls, [null, cursor]);
  assert.deepEqual(result.orders, [order('a'), order('b'), order('c')]);
  assert.equal(result.pages, 2); assert.equal(result.nextCursor, null);
});
test('a first-page refresh stays bounded even when older orders exist', async () => {
  let calls = 0;
  const cursor = { createdAtISO: '2026-11-15T00:00:00Z', id: 'cursor' };
  const result = await readHistoryPages(async () => { calls++; return { orders: [order('a')], nextCursor: cursor }; }, 1);
  assert.equal(calls, 1); assert.equal(result.nextCursor, cursor);
});
test('new leading orders cannot remove the previously loaded tail on refresh', async () => {
  const ids = ['new', 'a', 'b', 'c', 'd', 'e'];
  const rows = ids.map((id, index) => ({ ...order(id), createdAtISO: `2026-11-15T00:00:0${6-index}.000001Z` }));
  let calls = 0;
  const result = await readHistoryPages(async options => {
    calls++;
    const start = options?.cursor ? rows.findIndex(row => row.id === options.cursor?.id) + 1 : 0;
    const page = rows.slice(start, start + 2);
    return { orders: page, nextCursor: start + 2 < rows.length ? { id: page.at(-1)!.id, createdAtISO: page.at(-1)!.createdAtISO } : null };
  }, 2, rows[4]);
  assert.equal(calls, 3);
  assert.deepEqual(result.orders.map(row => row.id), ids);
  assert.equal(result.nextCursor, null);
});

test('tracking stages preserve public timestamps, mark current/future stages and handle terminal histories', () => {
  const placed = '2026-11-16T06:30:00Z', accepted = '2026-11-16T06:32:00Z', delivered = '2026-11-16T07:05:00Z';
  const live = { ...order('a', 3), createdAtISO: placed, status: 'preparing', history: [{ status: 'accepted', createdAtISO: accepted, actorName: 'Private owner' }] } as Order;
  const stages = trackingTimeline(live);
  assert.deepEqual(stages.map(s => s.state), ['complete', 'complete', 'current', 'pending', 'pending']);
  assert.deepEqual(stages.map(s => s.time), [placed, accepted, null, null, null]);
  assert.equal(JSON.stringify(stages).includes('Private owner'), false);
  const done = { ...live, status: 'delivered', history: [...live.history!, { status: 'delivered', createdAtISO: delivered }] } as Order;
  assert.equal(terminalTime(done), delivered); assert.equal(deliveryMinutes(done), 35);
  assert.equal(trackingHeadlines.delivered, 'Your food has arrived');
  assert.equal(deliveryMinutes({ ...done, history: [] }), null);
  const cancelled = { ...live, status: 'cancelled', history: [{ status: 'cancelled', createdAtISO: accepted }] } as Order;
  assert.equal(terminalTime(cancelled), accepted);
  assert.ok(trackingTimeline(cancelled).every(s => s.state === 'stopped'));
});
