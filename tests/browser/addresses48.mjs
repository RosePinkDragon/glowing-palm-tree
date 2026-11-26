import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #48 customer slice: saved-address list, add/edit/delete, location denied, in both brands.
// Real customer exports and the installed SDK, with deterministic synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const userId = '48100000-0000-4000-8000-000000000001';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'addresses@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'addresses-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const addressId = n => `48200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = () => [
  { id: addressId(1), label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: 'Khed 415709', latitude: 17.72, longitude: 73.39, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 },
  { id: addressId(2), label: 'work', custom_label: null, house: 'Shop 12', street_area: 'Station Road', landmark: 'near ST stand', latitude: 17.73, longitude: 73.4, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 2800 },
  { id: addressId(3), label: 'other', custom_label: 'Aai\'s place', house: 'Pawar Wadi', street_area: 'Bahadur Shaikh Naka', landmark: 'Chiplun', latitude: 17.5, longitude: 73.5, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: false, distance_m: 34000 },
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const errors = [], writes = [];
    const businessId = `48300000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const fixture = { rows: seed(), conflict: false, limit: false, failList: false, listCalls: 0, nextId: 10 };
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
    await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
      const data = JSON.parse(String(message)), array = Array.isArray(data);
      const [join, ref, topic, event] = array ? data : [data.join_ref, data.ref, data.topic, data.event];
      if (event === 'phx_join' || event === 'heartbeat' || event === 'phx_leave') socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }] : { join_ref: join, ref, topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: [] } } }));
    }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.fallback();
      assert.equal(url.origin, api, 'no third-party requests');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
      const method = request.method();
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items' || url.pathname === '/rest/v1/menu_categories' || url.pathname === '/rest/v1/orders') return json([]);
      if (url.pathname === '/rest/v1/rpc/list_addresses') {
        assert.equal(request.postDataJSON().p_business_slug, slug, 'distance and area are for this restaurant');
        fixture.listCalls++; if (fixture.failList) return json({ message: 'Address list fixture unavailable' }, 400);
        return json(fixture.rows);
      }
      if (url.pathname === '/rest/v1/customer_addresses') {
        if (method === 'POST') {
          const body = request.postDataJSON(); writes.push({ method, body });
          if (fixture.limit) return json({ code: '23514', message: 'saved address limit reached' }, 400);
          const row = { ...body, id: addressId(fixture.nextId++), version: 1, updated_at: new Date().toISOString(), in_area: true, distance_m: 900 };
          fixture.rows.push(row); return json({ id: row.id, version: 1 }, 201);
        }
        const id = url.searchParams.get('id')?.slice(3), version = url.searchParams.get('version')?.slice(3);
        const row = fixture.rows.find(item => item.id === id);
        if (method === 'PATCH') {
          writes.push({ method, id, version, body: request.postDataJSON() });
          if (fixture.conflict || !row || String(row.version) !== version) return json([]);
          Object.assign(row, request.postDataJSON(), { version: row.version + 1 }); return json([{ id, version: row.version }]);
        }
        if (method === 'DELETE') { writes.push({ method, id }); fixture.rows = fixture.rows.filter(item => item.id !== id); return route.fulfill({ status: 204, body: '' }); }
      }
      if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0); // inbox badge (#55)
      throw new Error(`Unexpected addresses request ${method} ${url.pathname}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const shot = async name => { await page.waitForTimeout(600); return page.screenshot({ path: `dist/browser/${slug}-addresses-${name}.png`, fullPage: name === 'list' || name === 'empty' }); };
    const visible = locator => locator.filter({ visible: true });
    const button = name => visible(page.getByRole('button', { name, exact: true }));
    const text = value => visible(page.getByText(value, { exact: true }));
    const row = title => visible(page.getByRole('heading', { name: title, exact: true }));
    try {
      // Reached from the account drawer.
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await button('Account').click();
      await button('Saved addresses').click();
      await row('Home').waitFor();
      assert.equal(new URL(page.url()).pathname, '/addresses');
      // List: title, line, distance from this restaurant, outside-area state.
      await row('Work').waitFor(); await row('Aai\'s place').waitFor();
      await text('Flat 3, Sai Krupa Apartments, Bharne Naka, Khed 415709').waitFor();
      await text('Shop 12, Station Road, near ST stand').waitFor();
      for (const distance of ['1.2 km', '2.8 km', '34 km']) await text(distance).waitFor();
      assert.equal(await text('Outside delivery area').count(), 1, 'only the outside address carries the state');
      assert.equal(await button('Options for Aai\'s place').count(), 1);
      await shot('list');
      // The ⋮ sheet: edit, delete and the both-apps note.
      await button('Options for Work').click();
      await visible(page.getByRole('heading', { name: 'Work', exact: true, level: 2 }).or(page.getByRole('heading', { name: 'Work', exact: true }))).first().waitFor();
      await button('Edit address').waitFor(); await button('Delete address').waitFor();
      await text(brand ? 'Changes apply in both the Kokani Dine Inn and Ammu Sammu apps. Past orders keep the address they were delivered to.' : 'Changes apply in both the Ammu Sammu and Kokani Dine Inn apps. Past orders keep the address they were delivered to.').waitFor();
      await shot('options');
      await button('Close').click(); await button('Delete address').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Options for Work');
      // Delete: confirm first; keeping changes nothing.
      await button('Options for Aai\'s place').click(); await button('Delete address').click();
      await text('Delete this address?').waitFor();
      await text('It will be removed from both apps. Past orders keep the address they were delivered to.').waitFor();
      await shot('delete');
      await button('Keep address').click(); await text('Delete this address?').waitFor({ state: 'hidden' });
      assert.deepEqual(writes, [], 'keeping an address sends nothing');
      await button('Options for Aai\'s place').click(); await button('Delete address').click();
      await button('Yes, delete address').click();
      await text('Address deleted.').waitFor(); await row('Aai\'s place').waitFor({ state: 'hidden' });
      assert.deepEqual(writes.splice(0), [{ method: 'DELETE', id: addressId(3) }]);
      // Add: location is required; a denied permission blocks saving with a clear message.
      await button('Add address').click(); await visible(page.getByRole('heading', { name: 'Add address', exact: true })).waitFor();
      await button('Save address').click();
      for (const message of ['Enter the house or flat number and building.', 'Enter the street or area.', 'Use your current location to set the delivery pin. It is required to save the address.']) await text(message).waitFor();
      assert.deepEqual(writes, [], 'nothing is sent while the form is invalid');
      await button('Use my current location').click();
      await text('Location permission is off. Allow location access for this app in your settings and try again, or save later.').waitFor();
      await visible(page.getByLabel('House, flat or floor', { exact: true })).fill('Flat 7');
      await visible(page.getByLabel('Street and area', { exact: true })).fill('Market Road');
      await button('Save address').click();
      await text('Use your current location to set the delivery pin. It is required to save the address.').waitFor();
      assert.deepEqual(writes, [], 'no location, no save');
      await shot('add-denied');
      // Granted: the pin is the phone's location, recorded as gps.
      await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 17.7219, longitude: 73.3904, accuracy: 12 });
      await button('Use my current location').click();
      await text('Delivery pin set from your phone\'s location.').waitFor();
      await visible(page.getByLabel('Landmark (optional)', { exact: true })).fill('Near the bus stop');
      await visible(page.getByRole('radio', { name: 'Other', exact: true })).click();
      await visible(page.getByLabel('Name this address (optional)', { exact: true })).fill('Friend\'s flat');
      await shot('add');
      fixture.limit = true; await button('Save address').click();
      await text('You can save up to 20 addresses. Delete one to add another.').waitFor();
      fixture.limit = false; writes.length = 0;
      await button('Save address').click();
      await text('Address saved.').waitFor(); await row('Friend\'s flat').waitFor();
      assert.deepEqual(writes.map(write => write.body), [{ label: 'other', custom_label: 'Friend\'s flat', house: 'Flat 7', street_area: 'Market Road', landmark: 'Near the bus stop', latitude: 17.7219, longitude: 73.3904, location_source: 'gps' }]);
      await text('900 m').waitFor(); writes.length = 0;
      // Edit: starts from the saved values and sends the reviewed version.
      await button('Options for Work').click(); await button('Edit address').click();
      await visible(page.getByRole('heading', { name: 'Edit address', exact: true })).waitFor();
      const house = visible(page.getByLabel('House, flat or floor', { exact: true }));
      assert.equal(await house.inputValue(), 'Shop 12');
      const labels = visible(page.getByRole('radiogroup', { name: 'Save as', exact: true }));
      assert.equal(await labels.getByRole('radio').count(), 3, 'label chips are radios in a group named Save as');
      assert.equal(await labels.getByRole('radio', { name: 'Work', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await labels.getByRole('radio', { name: 'Home', exact: true }).getAttribute('aria-checked'), 'false');
      await house.fill('Shop 14'); await shot('edit');
      fixture.conflict = true; await button('Save address').click();
      await text('This address was changed elsewhere. Reload and try again.').waitFor();
      fixture.conflict = false; writes.length = 0;
      // #200: the changed field is unsaved, so leaving asks first; discarding returns to the list.
      await button('Close').click(); await button('Discard changes').click();
      await button('Options for Work').click(); await button('Edit address').click();
      await visible(page.getByLabel('House, flat or floor', { exact: true })).fill('Shop 14');
      await button('Save address').click(); await text('Address updated.').waitFor();
      assert.equal(writes[0].method, 'PATCH'); assert.equal(writes[0].id, addressId(2)); assert.equal(writes[0].version, '1');
      assert.equal(writes[0].body.house, 'Shop 14'); assert.equal(writes[0].body.location_source, 'pin', 'an edit keeps the saved pin');
      await text('Shop 14, Station Road, near ST stand').waitFor();
      // Empty and failed lists.
      fixture.rows = []; await page.reload({ waitUntil: 'networkidle' });
      await text('No saved addresses yet').waitFor(); await shot('empty');
      fixture.failList = true; await page.reload({ waitUntil: 'networkidle' });
      await visible(page.getByText(/Address list fixture unavailable/)).waitFor(); fixture.failList = false;
      await button('Retry addresses').click(); await text('No saved addresses yet').waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} saved addresses list (in/out of area, distance), options sheet, delete confirm, add with gps/denied/limit, edit with version conflict, empty/error`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
