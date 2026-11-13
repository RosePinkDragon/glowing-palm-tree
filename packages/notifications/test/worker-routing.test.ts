import assert from 'node:assert/strict';
import test from 'node:test';
import { notificationPath, openNotification } from '../src/worker-routing.ts';
const id = '40000000-0000-4000-8000-000000000001';
const data = { kind: 'order_changed', order_id: id };
test('only an allowlisted kind and UUID can select an order route', () => {
  assert.equal(notificationPath(data), `orders/${id}`);
  for (const value of [null, {}, { order_id: id }, { kind: 'order_changed', order_id: 'https://evil.test/x' }, { kind: 'order_changed', order_id: '../account' }, { kind: 'other', order_id: id }]) assert.equal(notificationPath(value), '');
});
test('notification tap navigates and focuses an existing same-origin scoped tab', async () => {
  const calls: string[] = [];
  const tab = { url: 'https://app.test/shop/cart', navigate: async (url: string) => { calls.push(url); return tab; }, focus: async () => { calls.push('focus'); } };
  await openNotification(data, 'https://app.test/shop/', { matchAll: async () => [tab], openWindow: async () => { throw Error('unexpected new window'); } });
  assert.deepEqual(calls, [`https://app.test/shop/orders/${id}`, 'focus']);
});
test('external tabs are ignored and malformed metadata opens only this app root', async () => {
  const calls: string[] = [];
  const other = { url: 'https://evil.test/shop/', navigate: async () => { throw Error('external tab used'); }, focus: async () => {} };
  await openNotification({ kind: 'order_changed', order_id: '//evil.test' }, 'https://app.test/shop/', { matchAll: async () => [other], openWindow: async url => { calls.push(url); } });
  assert.deepEqual(calls, ['https://app.test/shop/']);
});
