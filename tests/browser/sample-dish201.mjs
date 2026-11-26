import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #201: owners cannot mark dishes as samples; an existing sample shows a 'Sample' badge and can be made real, staying unavailable until switched on.
// Real built exports of both brands, installed SDK, synthetic HTTP only (nothing leaves the fixture host).
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W201_SHOTS || 'dist/browser';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const uuid = (prefix, n) => `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = ['owner', 'customer'].map((name, index) => ({ id: uuid('2', index + 1), email: `${name}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
const visible = locator => locator.filter({ visible: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];

async function newContext(slug, audience, user, server, handler) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:${audience}`, value: session(user) });
  await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const data = JSON.parse(String(message)), array = Array.isArray(data);
    const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
    if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
    const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
    socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
  }));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === server.url) return route.fallback();
    assert.equal(url.origin, api, 'no third-party requests');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
    if (url.pathname === '/auth/v1/token') return json(session(user));
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.startsWith('/storage/v1/object/public/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    return handler(request, url, json);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}
const eventually = async check => { for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Condition did not become true'); };

try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', businessId = uuid('1', brand + 1);
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
    const categories = [{ id: uuid('3', 1), name: 'Thalis', sort_order: 0 }];
    const base = { business_id: businessId, category_id: categories[0].id, description: 'Synthetic.', diet: 'veg', price_paise: 12000, is_featured: false, image_url: null };
    // A real dish and a seeded sample dish that is (worst case) available.
    let dishes = [{ ...base, id: uuid('4', 1), name: 'Fish thali', available: true, is_demo: false, sort_order: 0 }, { ...base, id: uuid('4', 2), name: 'Sample thali', available: true, is_demo: true, sort_order: 1 }];
    const patches = [], posts = [];
    const business = { id: businessId, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: null, settings_version: 3, order_prefix: brand ? 'KDI' : 'AMS', service_area_source: 'owner survey', service_area_version: 'radius-12000m', service_area_verified_at: '2026-11-10T00:00:00Z' };
    const rows = () => dishes.map(row => ({ ...row, menu_categories: { name: categories[0].name, sort_order: 0 } }));
    const owner = await newContext(slug, 'admin', users[0], admin, async (request, url, json) => {
      const method = request.method();
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
      if (url.pathname === '/rest/v1/orders') return json([]);
      if (url.pathname === '/rest/v1/menu_categories') return json(categories);
      if (url.pathname === '/rest/v1/menu_items') {
        if (method === 'GET') return json(rows());
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        if (method === 'PATCH') { const values = request.postDataJSON(); patches.push({ id, values }); dishes = dishes.map(row => row.id === id ? { ...row, ...values } : row); return json(rows().find(row => row.id === id)); }
        if (method === 'POST') { const values = request.postDataJSON(); posts.push(values); const row = { image_url: null, ...values, id: uuid('4', 9) }; dishes.push(row); return json(rows().find(entry => entry.id === row.id)); }
      }
      throw new Error(`Unexpected owner fixture ${method} ${url.pathname}`);
    });
    try {
      const { page } = owner;
      const button = name => visible(page.getByRole('button', { name, exact: true }));
      const heading = title => visible(page.getByRole('heading', { name: title, exact: true }));
      const dialog = () => visible(page.getByRole('dialog').last());
      const sampleSwitch = () => page.getByRole('switch', { name: 'Sample dish', exact: true });
      const badges = () => visible(page.getByText('Sample', { exact: true })).count();
      const discardAsked = () => visible(page.getByRole('heading', { name: 'Discard changes?', exact: true })).count();
      const make = () => button('Make this a real dish');
      await page.goto(admin.url, { waitUntil: 'networkidle' });
      await button('Menu').click(); await button('Edit Sample thali').waitFor();
      // List: only the seeded sample carries the badge.
      assert.equal(await badges(), 1, 'one Sample badge in the owner list');
      assert.equal(await visible(page.getByText('Currently unavailable', { exact: true })).count(), 0);

      // New dish: no switch, no sample action, saved as a real dish.
      await button('Add dish').click(); await heading('Add dish').waitFor();
      assert.equal(await sampleSwitch().count(), 0, 'no Sample dish switch on a new dish'); assert.equal(await make().count(), 0);
      await visible(page.getByLabel('Dish name', { exact: true })).fill('Sol kadhi'); await visible(page.getByLabel('Price in rupees', { exact: true })).fill('40');
      await button('Category: Thalis').or(button('Category: not chosen')).click(); await button('Thalis').click();
      await button('Vegetarian').click(); await button('Save dish').click(); await heading('Add dish').waitFor({ state: 'hidden' });
      assert.equal(posts.length, 1); assert.equal(posts[0].is_demo, false);

      // Real dish: no switch, no sample action.
      await button('Edit Fish thali').click(); await heading('Edit dish').waitFor();
      assert.equal(await sampleSwitch().count(), 0, 'no Sample dish switch on a real dish'); assert.equal(await make().count(), 0); assert.equal(await dialog().getByText('Sample', { exact: true }).count(), 0);
      await button('Close').click(); await heading('Edit dish').waitFor({ state: 'hidden' });

      // Sample dish: badge, helper and one-tap action in the editor; no switch; opening and closing is clean.
      await button('Edit Sample thali').click(); await heading('Edit dish').waitFor();
      assert.equal(await sampleSwitch().count(), 0, 'no Sample dish switch on a sample dish');
      await dialog().getByText('Sample', { exact: true }).waitFor();
      await dialog().getByText("Customers can't order sample dishes. Making it real keeps it hidden until you turn on 'Available to order'.", { exact: true }).waitFor();
      assert.ok((await make().boundingBox()).height >= 44, 'the action keeps a 44px target');
      await make().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/${slug}-sample-dish-editor.png` });
      await button('Close').click(); await heading('Edit dish').waitFor({ state: 'hidden' }); assert.equal(await discardAsked(), 0, 'opening a sample dish is not an unsaved change');
      assert.deepEqual(patches, []);

      // Make it real: one save, is_demo false and is_available false together.
      await button('Edit Sample thali').click(); await make().click();
      await visible(page.getByText('Dish saved.', { exact: true })).waitFor(); await heading('Edit dish').waitFor({ state: 'hidden' });
      assert.equal(patches.length, 1, 'exactly one save');
      assert.deepEqual(patches[0], { id: uuid('4', 2), values: { diet: 'veg', name: 'Sample thali', description: 'Synthetic.', category_id: categories[0].id, price_paise: 12000, available: false, is_demo: false, is_featured: false, sort_order: 1 } });
      assert.equal(await discardAsked(), 0, 'no discard prompt after converting');
      assert.equal(await badges(), 0, 'the Sample badge is gone');
      await visible(page.getByText('Currently unavailable', { exact: true })).first().waitFor();
      assert.equal(await visible(page.getByText('Currently unavailable', { exact: true })).count(), 1, 'only the converted dish is unavailable');
      await page.screenshot({ path: `${shots}/${slug}-sample-dish-converted-list.png` });
      await button('Edit Sample thali').click(); await heading('Edit dish').waitFor();
      assert.equal(await make().count(), 0, 'a real dish has no sample action'); assert.equal(await sampleSwitch().count(), 0);
      const available = dialog().getByRole('switch', { name: 'Available to order', exact: true });
      assert.equal(await available.isChecked(), false, 'still unavailable until the owner turns it on');
      await page.screenshot({ path: `${shots}/${slug}-sample-dish-converted-editor.png` });

      // Turning availability on afterwards works and keeps the dish real.
      await available.click(); await button('Save changes').click(); await heading('Edit dish').waitFor({ state: 'hidden' });
      assert.equal(patches.length, 2); assert.equal(patches[1].values.available, true); assert.equal(patches[1].values.is_demo, false);
      assert.equal(await visible(page.getByText('Currently unavailable', { exact: true })).count(), 0); assert.equal(await badges(), 0);
      console.log(`PASS ${slug} sample dishes (#201): no switch, badge, one-save "Make this a real dish" stays unavailable, availability can be turned on`);
      assert.deepEqual(errors, []);
    } finally { await owner.context.close(); await admin.close(); }
  }
} finally { await browser?.close(); }
