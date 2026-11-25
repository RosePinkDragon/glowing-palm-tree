import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketServices, ServiceError, type OfferInput } from './index.ts';

// #213 slice B. The database refuses an unexpired JWT whose Auth session is gone with 42501 + detail INVALID_SESSION, from
// the RPCs and now from the row-level-security write policies too. Every owner and customer write path must turn that into
// SIGN_IN_REQUIRED, while an ordinary 42501 keeps its existing meaning. Synthetic HTTP only; no Supabase project.
const slug = 'ammu-sammu';
const uuid = (n: number) => `21330000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = (sub: string) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
type Refusal = 'session' | 'rls' | 'none';
const refusals: Record<Refusal, Record<string, string | null> | null> = {
  session: { code: '42501', message: 'invalid session', details: 'INVALID_SESSION', hint: null },
  rls: { code: '42501', message: 'new row violates row-level security policy for table "menu_items"', details: null, hint: null },
  none: null,
};

/** Signed in as an owner or a customer; every write or RPC request is answered with the chosen refusal. */
async function withService(audience: 'admin' | 'customer', run: (service: ReturnType<typeof createMarketServices>, refuse: (kind: Refusal) => void, writes: () => string[]) => Promise<void>) {
  const original = globalThis.fetch, user = audience === 'admin' ? 'session-owner' : 'session-customer';
  let refusal: Refusal = 'none';
  const seen: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)), path = url.pathname;
    if (path.endsWith('/auth/v1/token')) return Response.json({ access_token: token(user), refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: user, aud: 'authenticated' } });
    if (path.endsWith('/auth/v1/user')) return Response.json({ id: user, aud: 'authenticated' });
    if (path.endsWith('/businesses')) return Response.json({ id: 'tenant-session', slug, name: 'Business', delivery_fee_paise: 0, min_order_paise: 0, is_demo: false, ordering_enabled: true });
    if (path.endsWith('/business_memberships')) return Response.json({ role: 'admin' });
    seen.push(`${init?.method ?? 'GET'} ${path}`);
    const body = refusals[refusal];
    if (body) return new Response(JSON.stringify(body), { status: 403, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected success path: ${path}`);
  };
  const memory = new Map<string, string>();
  const service = createMarketServices({ businessSlug: slug, audience, config: { url: 'https://session-writes.example.test', anonKey: 'sb_publishable_test' },
    storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value); }, removeItem: key => { memory.delete(key); } } });
  try {
    await service.auth.signIn('person@example.test', 'password');
    await run(service, kind => { refusal = kind; seen.length = 0; }, () => seen);
  } finally { service.dispose(); globalThis.fetch = original; }
}
const code = (expected: string) => (e: unknown) => e instanceof ServiceError && e.code === expected;
const offer: OfferInput = { name: 'Session offer', kind: 'percent', value: 10, maxDiscountPaise: null, minOrderPaise: 0, applyMode: 'automatic', code: null, firstOrderOnly: false, perCustomerLimit: null, totalLimit: null, startsAt: null, endsAt: null, window: null };
const dish = { name: 'Dish', categoryId: uuid(1), description: '', pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0, diet: 'veg' as const };
const address = { label: 'home' as const, house: '12', streetArea: 'Station Road', latitude: 17.7, longitude: 73.4, locationSource: 'pin' as const };

test('owner direct writes and reorders ask for sign-in when the session is inactive, and keep their other 42501 meaning', async () => {
  await withService('admin', async (service, refuse, writes) => {
    const operations: [string, () => Promise<unknown>][] = [
      ['create category', () => service.saveCategory({ name: 'New', sortOrder: 1 })],
      ['update category', () => service.saveCategory({ id: uuid(2), name: 'Edited', sortOrder: 1 })],
      ['delete category', () => service.deleteCategory(uuid(2))],
      ['create dish', () => service.saveMenuItem(dish)],
      ['update dish', () => service.saveMenuItem({ ...dish, id: uuid(3) })],
      ['delete dish', () => service.deleteMenuItem(uuid(3))],
      ['dish availability', () => service.setMenuItemAvailability(uuid(3), false)],
      ['create offer', () => service.createOffer(offer)],
      ['update offer', () => service.updateOffer(uuid(4), 1, offer)],
      ['pause offer', () => service.pauseOffer(uuid(4), 1)],
      ['reorder dishes', () => service.reorderMenuItems(uuid(1), [uuid(3)])],
      ['reorder categories', () => service.reorderCategories([uuid(2)])],
    ];
    refuse('session');
    for (const [name, operation] of operations) await assert.rejects(operation(), code('SIGN_IN_REQUIRED'), `${name}: an inactive session asks for sign-in`);
    assert.equal(writes().length, operations.length, 'each operation made exactly one refused request (no retry on a session refusal)');
    // An ordinary refusal (membership changed) is not mistaken for a dead session.
    refuse('rls');
    for (const [name, operation] of operations.filter(([name]) => ['create category', 'delete category', 'dish availability', 'create offer', 'pause offer', 'reorder dishes', 'reorder categories'].includes(name))) {
      await assert.rejects(operation(), code('ADMIN_REQUIRED'), `${name}: another 42501 still means the owner access changed`);
    }
  });
});

test('customer address writes and notification markers ask for sign-in when the session is inactive', async () => {
  await withService('customer', async (service, refuse) => {
    refuse('session');
    await assert.rejects(service.saveAddress(address), code('SIGN_IN_REQUIRED'), 'add address');
    await assert.rejects(service.saveAddress(address, { id: uuid(5), version: 1 }), code('SIGN_IN_REQUIRED'), 'edit address');
    await assert.rejects(service.deleteAddress(uuid(5)), code('SIGN_IN_REQUIRED'), 'delete address');
    await assert.rejects(service.markNotificationRead(uuid(6)), code('SIGN_IN_REQUIRED'), 'mark one notification read');
    await assert.rejects(service.markAllNotificationsRead(), code('SIGN_IN_REQUIRED'), 'mark all notifications read');
    // The session message is shown, not the generic notification failure.
    await assert.rejects(service.markNotificationRead(uuid(6)), (e: unknown) => e instanceof ServiceError && /sign in again/i.test(e.message));
    // Ordinary 42501 keeps its existing codes: the notification feed's generic denial, and the address "sign in" mapping.
    refuse('rls');
    await assert.rejects(service.markNotificationRead(uuid(6)), code('NOTIFICATION_ACCESS_DENIED'));
    await assert.rejects(service.markAllNotificationsRead(), code('NOTIFICATION_ACCESS_DENIED'));
    await assert.rejects(service.saveAddress(address), code('SIGN_IN_REQUIRED'));
  });
});
