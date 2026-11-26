import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError } from './index.ts';

test('checkout budget refusal has a friendly, specific error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ code: 'PT429', details: 'ORDER_RATE_LIMITED', message: 'order submission limit reached', hint: null }, { status: 429 });
  const service = createMarketServices({ businessSlug: 'ammu-sammu', audience: 'customer', config: { url: 'https://budget.example.test', anonKey: 'sb_publishable_test' }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
  try {
    await assert.rejects(service.placeOrder({ lines: [], delivery: { name: 'Test', phone: '9876543210' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 1 }, location: null, idempotencyKey: 'key', pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 } }),
      (e: unknown) => e instanceof ServiceError && e.code === 'ORDER_RATE_LIMITED' && /wait/i.test(e.message));
  } finally { service.dispose(); globalThis.fetch = originalFetch; }
});
