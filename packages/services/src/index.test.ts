import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, mapMenu, mapOrder, sessionStorageKey, ServiceError } from './index.ts';

const slug = 'ammu-sammu' as const;
test('sessions are separated by business, audience, and backend', () => {
  const key = sessionStorageKey('https://one.example/', slug, 'customer');
  assert.equal(key, sessionStorageKey('https://one.example', slug, 'customer'));
  assert.notEqual(key, sessionStorageKey('https://one.example', slug, 'admin'));
  assert.notEqual(key, sessionStorageKey('https://one.example', 'konkan-fine-dine', 'customer'));
  assert.notEqual(key, sessionStorageKey('https://two.example', slug, 'customer'));
});
test('demo browsing is labelled and checkout fails closed', async () => {
  const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: {} });
  assert.equal(service.mode, 'demo');
  assert.equal((await service.getBusiness()).orderingEnabled, false);
  assert.equal((await service.getMenu())[0].isDemo, true);
  await assert.rejects(service.placeOrder({ lines: [], delivery: { name: '', phone: '', addressLine: '' }, location: { latitude: 0, longitude: 0, accuracy: 0, capturedAtISO: '' }, idempotencyKey: 'key' }), (e: unknown) => e instanceof ServiceError && e.code === 'DEMO_MODE');
  assert.throws(() => createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://one.example' } }), /both EXPO_PUBLIC/);
});
test('maps database menu and complete order into domain values', () => {
  assert.deepEqual(mapMenu({ id: 'm', name: 'Dish', description: null, category: 'Main', price_paise: 1200, available: true, is_demo: false, image_url: null }, slug), { id: 'm', businessId: slug, name: 'Dish', description: '', category: 'Main', pricePaise: 1200, isAvailable: true, isDemo: false });
  const order = mapOrder({ id: 'o', status: 'placed', version: 1, subtotal_paise: 1200, delivery_fee_paise: 100, total_paise: 1300, customer_name: 'Name', customer_phone: 'Phone', delivery_address_line: 'Address', created_at: '2026-01-01', order_items: [{ menu_item_id: 'm', name: 'Dish', quantity: 1, unit_price_paise: 1200, line_total_paise: 1200 }], order_status_history: [{ status: 'accepted', created_at: '2026-01-02' }, { status: 'placed', created_at: '2026-01-01' }] }, slug);
  assert.equal(order.lines[0].unitPricePaise, 1200);
  assert.equal(order.delivery.addressLine, 'Address');
  assert.deepEqual(order.history?.map(entry => entry.status), ['placed', 'accepted']);
});
test('configured backend errors do not fall back to sample data', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'database unavailable', code: 'BAD' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  try {
    const service = createMarketServices({ businessSlug: slug, audience: 'customer', config: { url: 'https://example.test', anonKey: 'public-key' } });
    await assert.rejects(service.getMenu(), /database unavailable/);
  } finally { globalThis.fetch = original; }
});

test('realtime invalidates on events and reconnect and cleans up', async () => {
  const { subscribeToOrderChanges } = await import('./index.ts');
  let event: (() => void) | undefined;
  let status: ((value: string) => void) | undefined;
  let filter = '';
  let removed = false;
  let refreshes = 0;
  let errors = 0;
  const channel = {
    on(_kind: string, spec: { filter: string }, callback: () => void) { filter = spec.filter; event = callback; return this; },
    subscribe(callback: (value: string) => void) { status = callback; return this; },
  };
  const client = { channel: () => channel, removeChannel: async (value: unknown) => { assert.equal(value, channel); removed = true; } };
  const cleanup = subscribeToOrderChanges(client as never, 'tenant-id', slug, 'customer', () => { refreshes++; }, () => { errors++; });
  assert.equal(filter, 'business_id=eq.tenant-id');
  status?.('SUBSCRIBED'); event?.(); status?.('TIMED_OUT'); status?.('SUBSCRIBED');
  assert.equal(refreshes, 3); assert.equal(errors, 1);
  cleanup(); event?.(); status?.('SUBSCRIBED');
  assert.equal(removed, true); assert.equal(refreshes, 3);
});
