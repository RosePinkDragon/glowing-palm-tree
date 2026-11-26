import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #200: "Discard changes?" before unsaved address (customer), dish and restaurant-setting (owner) edits are abandoned.
// Real built exports of both brands, installed SDK, synthetic HTTP only (nothing leaves the fixture host).
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W200_SHOTS || 'dist/browser';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const uuid = (prefix, n) => `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = ['owner', 'customer'].map((name, index) => ({ id: uuid('2', index + 1), email: `${name}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
const visible = locator => locator.filter({ visible: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];
// W200_CPU_RATE=4 repeats the journey on a slowed CPU (focus and history timing).
const cpuRate = Number(process.env.W200_CPU_RATE ?? 1);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

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
  if (cpuRate !== 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  return { context, page };
}
/** The three things a leave can hit while dirty or clean, shared by every screen below. */
const helpers = page => {
  const dialog = () => visible(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Discard changes?', exact: true }) }));
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  return {
    dialog, button,
    // The guard's history entry is added after React commits the dirty state: wait for it before pressing Back, as a person always does.
    guarded: () => eventually(async () => (await page.evaluate(() => !!history.state?.discardGuard))),
    history: () => page.evaluate(() => ({ length: history.length, guard: !!history.state?.discardGuard, path: location.pathname })),
    focusedName: () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent),
    // Whether the page would ask before unloading: the same event a reload or tab close fires.
    asksBeforeUnload: () => page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }),
    // Keep editing is the safe default: focus starts there, focus is kept inside, Escape keeps editing.
    async assertAsks() {
      await dialog().waitFor();
      // The modal's own mount handling may touch focus first; it settles on Keep editing and stays there.
      await eventually(async () => await page.evaluate(() => document.activeElement?.textContent) === 'Keep editing');
      await page.waitForTimeout(800); assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Keep editing', 'focus starts on Keep editing and stays');
      await page.getByText('You have unsaved changes. If you leave now they will be lost.', { exact: true }).waitFor();
      for (let index = 0; index < 4; index++) { await page.keyboard.press('Tab'); assert.ok(await dialog().evaluate(node => node.contains(document.activeElement)), 'Tab stays inside the confirmation'); }
      await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
      assert.ok(await dialog().evaluate(node => node.contains(document.activeElement)), 'Shift+Tab stays inside the confirmation');
    },
  };
};
const eventually = async check => { for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('Condition did not become true'); };

try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', businessId = uuid('1', brand + 1);
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`), customer = await serveWeb(`apps/${slug}-customer/dist/web`);
    const contexts = [];
    try {
      // ---- Owner: dish editor and restaurant settings ----
      const categories = [{ id: uuid('3', 1), name: 'Thalis', sort_order: 0 }, { id: uuid('3', 2), name: 'Snacks', sort_order: 1 }];
      let dishes = [{ id: uuid('4', 1), business_id: businessId, category_id: categories[0].id, name: 'Fish thali', description: 'Synthetic.', diet: 'non_veg', price_paise: 32000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null }];
      const patches = [], posts = [], saves = [];
      const business = { id: businessId, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: null, settings_version: 3, order_prefix: brand ? 'KDI' : 'AMS', service_area_source: 'owner survey', service_area_version: 'radius-12000m', service_area_verified_at: '2026-11-10T00:00:00Z' };
      const rows = () => dishes.map(row => { const category = categories.find(entry => entry.id === row.category_id); return { ...row, menu_categories: { name: category.name, sort_order: category.sort_order } }; });
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
        if (url.pathname === '/rest/v1/rpc/save_restaurant_settings') {
          const body = request.postDataJSON(); saves.push(body);
          Object.assign(business, { contact_phone: body.p_contact_phone, whatsapp_phone: body.p_whatsapp_phone, delivery_fee_paise: body.p_delivery_fee_paise, min_order_paise: body.p_min_order_paise, settings_version: business.settings_version + 1 });
          return json({ contact_phone: business.contact_phone, whatsapp_phone: business.whatsapp_phone, delivery_fee_paise: business.delivery_fee_paise, min_order_paise: business.min_order_paise, settings_version: business.settings_version });
        }
        throw new Error(`Unexpected owner fixture ${method} ${url.pathname}`);
      });
      contexts.push(owner.context);
      {
        const { page } = owner, h = helpers(page), { button, dialog } = h;
        const heading = title => visible(page.getByRole('heading', { name: title, exact: true }));
        const price = () => visible(page.getByLabel('Price in rupees', { exact: true }));
        await page.goto(admin.url, { waitUntil: 'networkidle' });
        await button('Menu').click(); await button('Edit Fish thali').click(); await heading('Edit dish').waitFor();
        assert.equal(await h.asksBeforeUnload(), false, 'an untouched dish editor never blocks reload');
        // Clean: closing is immediate.
        await button('Close').click(); await heading('Edit dish').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0, 'no prompt when nothing changed');
        // Typing and undoing, or a same-price spelling, is not a change.
        await button('Edit Fish thali').click(); await price().fill('320.00'); await visible(page.getByLabel('Dish name', { exact: true })).fill('  Fish thali ');
        assert.equal(await h.asksBeforeUnload(), false, 'the same values written differently are not changes');
        await button('Close').click(); await heading('Edit dish').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0);
        // Dirty + Close: Keep editing keeps the text and returns focus to the control that was used.
        await button('Edit Fish thali').click(); await price().fill('340');
        assert.equal(await h.asksBeforeUnload(), true, 'a dirty editor asks before reload or tab close');
        await button('Close').click(); await h.assertAsks(); await page.screenshot({ path: `${shots}/${slug}-discard-dish.png` });
        await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await price().inputValue(), '340', 'Keep editing keeps what was typed'); await eventually(async () => await h.focusedName() === 'Close');
        // Escape is Keep editing too.
        await button('Close').click(); await h.assertAsks(); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await price().inputValue(), '340');
        // Escape on the editor itself asks (the Android back button takes the same path).
        await price().focus(); await page.keyboard.press('Escape'); await h.assertAsks(); await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        // Dirty, clean again, dirty again: Back still asks (the removed guard entry must not swallow it).
        await price().fill('320'); assert.equal(await h.asksBeforeUnload(), false); await price().fill('341'); assert.equal(await h.asksBeforeUnload(), true); await h.guarded();
        await page.goBack(); await h.assertAsks(); await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' }); await price().fill('340');
        // Browser Back asks instead of leaving; asking again after Keep editing works.
        await page.goBack(); await h.assertAsks(); await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await price().inputValue(), '340');
        // A second Back while the confirmation is open does not leave: the confirmation and the form stay.
        await page.goBack(); await h.assertAsks(); await page.goBack(); await h.dialog().waitFor(); await heading('Edit dish').waitFor();
        assert.equal(await price().inputValue(), '340');
        // Discard leaves, sends nothing and the next open shows the saved price.
        await button('Discard changes').click(); await heading('Edit dish').waitFor({ state: 'hidden' });
        assert.deepEqual(patches, [], 'discarding writes nothing'); assert.equal(await h.asksBeforeUnload(), false, 'closed editor no longer blocks reload');
        await button('Edit Fish thali').click(); assert.equal(await price().inputValue(), '320');
        // Discard through the editor's own Close button.
        await price().fill('99'); await button('Close').click(); await h.assertAsks(); await button('Discard changes').click(); await heading('Edit dish').waitFor({ state: 'hidden' });
        // Saved: no prompt afterwards, and the write is unchanged.
        await button('Edit Fish thali').click(); await price().fill('350'); await button('Save changes').click();
        await heading('Edit dish').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0, 'no prompt after a save');
        assert.equal(patches.length, 1); assert.equal(patches[0].values.price_paise, 35000); assert.equal(await h.asksBeforeUnload(), false);
        // Add dish: empty is clean, typed is dirty.
        await button('Add dish').click(); await heading('Add dish').waitFor(); await button('Close').click(); await heading('Add dish').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0);
        await button('Add dish').click(); await visible(page.getByLabel('Dish name', { exact: true })).fill('Sol kadhi'); await button('Close').click(); await h.assertAsks();
        await button('Keep editing').click(); assert.equal(await visible(page.getByLabel('Dish name', { exact: true })).inputValue(), 'Sol kadhi');
        await button('Close').click(); await h.assertAsks(); await button('Discard changes').click(); await heading('Add dish').waitFor({ state: 'hidden' }); assert.deepEqual(posts, []);

        // Restaurant details.
        await button('Settings').click(); await button('Restaurant details').click();
        const field = label => visible(page.getByLabel(label, { exact: true }));
        await field('Delivery fee').waitFor(); assert.equal(await h.asksBeforeUnload(), false);
        await button('Back to Settings').click(); await button('Log out').waitFor(); assert.equal(await dialog().count(), 0, 'no prompt for an untouched screen');
        await button('Restaurant details').click(); await field('Delivery fee').fill('45');
        assert.equal(await h.asksBeforeUnload(), true);
        await button('Back to Settings').click(); await h.assertAsks(); await page.screenshot({ path: `${shots}/${slug}-discard-settings.png` });
        await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await field('Delivery fee').inputValue(), '45'); await eventually(async () => await h.focusedName() === 'Back to Settings');
        await page.goBack(); await h.assertAsks(); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
        await button('Back to Settings').click(); await h.assertAsks(); await button('Discard changes').click(); await button('Log out').waitFor();
        assert.deepEqual(saves, [], 'discarding writes nothing');
        await button('Restaurant details').click(); assert.equal(await field('Delivery fee').inputValue(), '30', 'the next visit starts from the saved value');
        // Saved: the screen stays, the new values are the baseline.
        await field('Delivery fee').fill('45'); await button('Save changes').click(); await visible(page.getByText('Restaurant details saved.', { exact: true })).waitFor();
        assert.equal(saves.length, 1); assert.equal(saves[0].p_delivery_fee_paise, 4500);
        assert.equal(await h.asksBeforeUnload(), false, 'saved values are not unsaved changes');
        // Edit again after a save: Back asks (the guard entry from the first dirty period was removed cleanly).
        await field('Delivery fee').fill('50'); await h.guarded(); await page.goBack(); await h.assertAsks(); await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await field('Delivery fee').inputValue(), '50');
        await field('Delivery fee').fill('45'); await button('Back to Settings').click(); await button('Log out').waitFor(); assert.equal(await dialog().count(), 0, 'no prompt once the values match the saved ones');
      }
      // ---- Customer: add and edit address ----
      const address = { id: uuid('5', 1), label: 'work', custom_label: null, house: 'Shop 12', street_area: 'Station Road', landmark: null, latitude: 17.73, longitude: 73.4, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 2800 };
      const writes = []; let gate = null, gateArrived = null;
      const buyer = await newContext(slug, 'customer', users[1], customer, async (request, url, json) => {
        const method = request.method();
        if (url.pathname === '/rest/v1/businesses') return json({ id: businessId, slug, name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
        if (['/rest/v1/menu_items', '/rest/v1/menu_categories', '/rest/v1/orders'].includes(url.pathname)) return json([]);
        if (url.pathname === '/rest/v1/rpc/list_addresses') return json([address]);
        if (url.pathname === '/rest/v1/customer_addresses' && method === 'POST') { const body = request.postDataJSON(); writes.push({ method, body }); if (gate) { gateArrived.resolve(); await gate.promise; } return json({ id: uuid('5', 2), version: 1 }, 201); }
        if (url.pathname === '/rest/v1/customer_addresses' && method === 'PATCH') { writes.push({ method, body: request.postDataJSON() }); Object.assign(address, request.postDataJSON(), { version: 2 }); return json([{ id: address.id, version: 2 }]); }
        throw new Error(`Unexpected customer fixture ${method} ${url.pathname}`);
      });
      contexts.push(buyer.context);
      {
        const { page, context } = buyer, h = helpers(page), { button, dialog } = h;
        const heading = title => visible(page.getByRole('heading', { name: title, exact: true }));
        const house = () => visible(page.getByLabel('House, flat or floor', { exact: true }));
        await page.goto(customer.url, { waitUntil: 'networkidle' });
        await button('Account').click(); await button('Saved addresses').click(); await heading('Work').waitFor();
        // Add: clean close is immediate; typed text asks.
        await button('Add address').click(); await heading('Add address').waitFor(); assert.equal(await h.asksBeforeUnload(), false);
        await button('Close').click(); await heading('Add address').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0, 'no prompt for an untouched form');
        await button('Add address').click(); await house().fill('F'); await house().fill(''); assert.equal(await h.asksBeforeUnload(), false);
        await house().fill('Flat 7'); assert.equal(await h.asksBeforeUnload(), true); await h.guarded();
        await page.goBack(); await h.assertAsks(); await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        await button('Close').click(); await h.assertAsks(); await page.screenshot({ path: `${shots}/${slug}-discard-address.png` });
        await button('Keep editing').click(); await dialog().waitFor({ state: 'hidden' });
        assert.equal(await house().inputValue(), 'Flat 7', 'Keep editing keeps what was typed'); await eventually(async () => await h.focusedName() === 'Close');
        await page.goBack(); await h.assertAsks(); await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
        await page.goBack(); await h.assertAsks();
        const before = await h.history();
        await button('Discard changes').click(); await heading('Add address').waitFor({ state: 'hidden' });
        // The guard leaves nothing behind: not the current entry, still on this page, and the Saved addresses page (not the drawer) is still showing.
        await eventually(async () => !(await h.history()).guard);
        const after = await h.history(); assert.equal(after.path, before.path, 'still on the same page'); assert.ok(after.length - before.length <= 1, 'no more than the one entry already taken by the guard');
        await heading('Work').waitFor(); await button('Add address').waitFor();
        assert.deepEqual(writes, [], 'discarding sends nothing'); assert.equal(await h.asksBeforeUnload(), false);
        // Edit: unchanged is clean, changed asks and Discard restores the saved text on the next open.
        await button('Options for Work').click(); await button('Edit address').click(); await heading('Edit address').waitFor();
        assert.equal(await house().inputValue(), 'Shop 12'); await button('Close').click(); await heading('Edit address').waitFor({ state: 'hidden' }); assert.equal(await dialog().count(), 0);
        await button('Options for Work').click(); await button('Edit address').click(); await house().fill('Shop 14'); await button('Close').click();
        await h.assertAsks(); await button('Discard changes').click(); await heading('Edit address').waitFor({ state: 'hidden' });
        await button('Options for Work').click(); await button('Edit address').click(); assert.equal(await house().inputValue(), 'Shop 12'); assert.deepEqual(writes, []);
        // Saved: no prompt afterwards.
        await house().fill('Shop 14'); await button('Save address').click(); await visible(page.getByText('Address updated.', { exact: true })).waitFor();
        assert.equal(await dialog().count(), 0, 'no prompt after a save'); assert.equal(writes.length, 1); assert.equal(writes[0].body.house, 'Shop 14'); assert.equal(await h.asksBeforeUnload(), false);
        // A new address saved with a pin closes without asking.
        await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 17.7219, longitude: 73.3904, accuracy: 12 });
        await button('Add address').click(); await house().fill('Flat 7'); await visible(page.getByLabel('Street and area', { exact: true })).fill('Market Road');
        await button('Use my current location').click(); await visible(page.getByText('Delivery pin set from your phone\'s location.', { exact: true })).waitFor();
        // While the save is in flight, Escape and Back are ignored: nothing asks and the form stays.
        gate = deferred(); const arrived = deferred(); gateArrived = arrived;
        await button('Save address').click(); await arrived.promise;
        await page.keyboard.press('Escape'); await page.goBack(); await page.waitForTimeout(300);
        assert.equal(await dialog().count(), 0, 'no prompt while saving'); await heading('Add address').waitFor();
        gate.resolve();
        await visible(page.getByText('Address saved.', { exact: true })).waitFor(); assert.equal(await dialog().count(), 0, 'no prompt after saving a new address');
        assert.equal(writes.length, 2);
        await eventually(async () => !(await h.history()).guard); await heading('Work').waitFor(); await button('Add address').waitFor();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} discard confirmation (#200): dish add/edit, restaurant details, address add/edit - clean leaves, dirty asks (button, Escape, browser Back, beforeunload), Keep editing keeps text and focus, Discard leaves, no prompt after save`);
    } finally { for (const context of contexts) await context.close(); await admin.close(); await customer.close(); }
  }
} finally { await browser.close(); }
