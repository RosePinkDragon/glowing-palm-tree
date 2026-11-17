import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #48 checkout slice: address picker, direct / remote / no-location confirmation, rejections and idempotent retry,
// in both brands. Real customer exports and the installed SDK, with deterministic synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const userId = '48400000-0000-4000-8000-000000000001';
const orderId = '48400000-0000-4000-8000-000000000002';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'checkout@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'checkout-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const addressId = n => `48500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// The phone sits at HOME. WORK is ~3.2 km north of it; AAI's place is far away and outside the area.
const HOME = { latitude: 17.719, longitude: 73.397 };
const north = metres => ({ latitude: HOME.latitude + metres / 111_195, longitude: HOME.longitude });
const seed = () => [
  { id: addressId(1), label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 },
  { id: addressId(2), label: 'work', custom_label: null, house: 'Shop 12', street_area: 'Station Road', landmark: 'near ST stand', ...north(3200), location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 2800 },
  { id: addressId(3), label: 'other', custom_label: 'Aai\'s place', house: 'Pawar Wadi', street_area: 'Bahadur Shaikh Naka', landmark: 'Chiplun', latitude: 17.5, longitude: 73.5, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: false, distance_m: 34000 },
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true }); await mkdir(process.env.CHECKOUT_SHOTS ?? 'dist/browser', { recursive: true });
const shots = process.env.CHECKOUT_SHOTS ?? 'dist/browser';
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
    await context.addInitScript(() => { for (const slug of ['ammu-sammu', 'kokani-dine-inn']) localStorage.setItem(`market:welcome:${slug}`, '1'); }); // first-launch welcome (#39) already dismissed
    const errors = [], orders = [];
    const businessId = `48600000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const item = { id: '48700000-0000-4000-8000-000000000001', name: 'Checkout fixture meal', description: 'Synthetic fixture', category_id: '48800000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const fixture = { rows: seed(), mode: 'placed', listCalls: 0, placed: null };
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
    await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
      const data = JSON.parse(String(message)), array = Array.isArray(data);
      const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
      const changes = (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 }));
      if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) { const response = { status: 'ok', response: { postgres_changes: changes } }; socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response })); }
    }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.fallback();
      assert.equal(url.origin, api, 'no third-party requests');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      const method = request.method();
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json([item]);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? fixture.placed : fixture.placed ? [fixture.placed] : []);
      if (url.pathname === '/rest/v1/rpc/list_addresses') { fixture.listCalls++; return json(fixture.rows); }
      if (url.pathname === '/rest/v1/customer_addresses' && method === 'POST') {
        const body = request.postDataJSON(), row = { ...body, id: addressId(20), version: 1, updated_at: new Date().toISOString(), in_area: true, distance_m: 900 };
        fixture.rows.push(row); return json({ id: row.id, version: 1 }, 201);
      }
      if (url.pathname === '/rest/v1/rpc/place_order') {
        const body = request.postDataJSON(); orders.push(body);
        if (fixture.mode === 'changed') return json({ code: 'PT412', message: 'address changed', details: null, hint: null }, 412);
        if (fixture.mode === 'unavailable') return json({ code: '22023', message: 'Could not place order: delivery unavailable', details: null, hint: null }, 400);
        const terms = body.p_accepted_pricing;
        fixture.placed ??= { id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
        if (fixture.mode === 'lost') { fixture.mode = 'placed'; return route.abort('failed'); } // committed; the response was lost
        return json({ outcome: 'placed', id: orderId });
      }
      throw new Error(`Unexpected checkout request ${method} ${url.pathname}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const visible = locator => locator.filter({ visible: true });
    const button = name => visible(page.getByRole('button', { name, exact: true }));
    const text = value => visible(page.getByText(value, { exact: true }));
    const shot = async name => { await page.waitForTimeout(600); return page.screenshot({ path: `${shots}/${slug}-checkout-${name}.png`, fullPage: name === 'cart' }); };
    const attempt = () => page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`);
    const reset = async () => { await page.evaluate(key => { localStorage.removeItem(`market:checkout:${key}`); }, slug); fixture.placed = null; orders.length = 0; };
    const cartLink = () => visible(page.getByRole('button', { name: /^Cart \(/ }));
    const toCart = async () => {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      if (!(await cartLink().count())) await button('Add to cart').first().click();
      await cartLink().click(); await text('Delivery details').waitFor();
      await visible(page.getByLabel('Name', { exact: true })).fill('Rohan Sawant'); await visible(page.getByLabel('Mobile number', { exact: true })).fill('9876543210');
    };
    try {
      await toCart();
      // The typed address entry and the fresh-GPS button are gone; the first usable saved address is chosen.
      assert.equal(await page.getByLabel('Delivery address', { exact: true }).count(), 0, 'no typed address field');
      assert.equal(await button('Check my delivery location').count(), 0);
      await text('Deliver to Home').waitFor();
      await text('Flat 3, Sai Krupa Apartments, Bharne Naka · 1.2 km').waitFor();
      await shot('cart');

      // Picker: in-area rows are radios, the outside one is visible but disabled with its reason.
      await button('Change delivery address').click();
      await visible(page.getByRole('heading', { name: 'Delivery address', exact: true, level: 1 }).or(page.getByRole('heading', { name: 'Delivery address', exact: true }))).first().waitFor();
      const radio = name => visible(page.getByRole('radio', { name: new RegExp(`^${name}`) }));
      assert.equal(await radio('Home').getAttribute('aria-checked'), 'true');
      assert.equal(await radio('Work').getAttribute('aria-checked'), 'false');
      assert.equal(await radio('Aai\'s place').isDisabled(), true, 'outside the area cannot be selected');
      assert.equal(await radio('Aai\'s place').getAttribute('aria-checked'), 'false');
      await text('Outside delivery area').waitFor();
      await shot('picker');
      await radio('Aai\'s place').click({ force: true });
      assert.equal(await button('Deliver to Home').isEnabled(), true, 'tapping an outside address does not change the choice');
      await radio('Work').click(); await button('Deliver to Work').click();
      await text('Deliver to Work').waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Change delivery address');

      // Add a new address from the picker: it is saved, listed again and selected.
      await button('Change delivery address').click(); await button('Add a new address').click();
      await visible(page.getByRole('heading', { name: 'Add address', exact: true })).waitFor();
      await visible(page.getByLabel('House, flat or floor', { exact: true })).fill('Flat 7');
      await visible(page.getByLabel('Street and area', { exact: true })).fill('Market Road');
      await button('Use my current location').click(); await text('Delivery pin set from your phone\'s location.').waitFor();
      await button('Save address').click();
      await text('Deliver to Home').waitFor();
      await text('Flat 7, Market Road · 900 m').waitFor();
      assert.ok(fixture.listCalls >= 2, 'the list is read again after saving');
      fixture.rows.pop(); fixture.rows[0].version = 1;
      await page.reload({ waitUntil: 'networkidle' }); await text('Deliver to Home').waitFor();

      // Near the pin (within 150 m): goes straight through, with the saved address and the phone fix.
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      await button('Place order').click();
      await page.waitForURL(/\/orders\//);
      assert.equal(orders.length, 1);
      assert.deepEqual(orders[0].p_delivery, { name: 'Rohan Sawant', phone: '+919876543210', address_id: addressId(1), address_version: 1 });
      assert.equal(orders[0].p_location.latitude, HOME.latitude); assert.ok(orders[0].p_location.accuracy <= 100);
      assert.equal(await attempt(), null, 'a placed order releases its saved attempt');

      // Remote: the phone is 3.2 km from Home. The sheet names the distance, the address and the cash; both buttons work.
      await reset(); await context.setGeolocation({ ...north(3200), accuracy: 12 }); await toCart();
      await text('Deliver to Home').waitFor();
      await button('Place order').click();
      await text('You\'re 3.2 km from this address').waitFor();
      await text('You\'re ordering to Home, Flat 3, Sai Krupa Apartments, Bharne Naka. Is that right?').waitFor();
      await text('Make sure someone at the address can take the food and pay ₹120 in cash. The restaurant may call you to confirm.').waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === 'You\'re 3.2 km from this address');
      assert.equal(orders.length, 0, 'nothing is sent before confirming'); assert.equal(await attempt(), null);
      await shot('remote');
      await button('Change address').click(); await text('You\'re 3.2 km from this address').waitFor({ state: 'hidden' });
      await visible(page.getByRole('heading', { name: 'Delivery address', exact: true })).first().waitFor();
      assert.equal(orders.length, 0, 'Change address sends nothing and opens the picker');
      await radio('Work').click(); await button('Deliver to Work').click();
      await text('Deliver to Work').waitFor();
      await button('Place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders[0].p_delivery.address_id, addressId(2), 'the phone is at Work, so Work places directly');
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      await button('Place order').click(); await text('You\'re 3.2 km from this address').waitFor();
      await button('Yes, place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders.length, 1); assert.equal(orders[0].p_delivery.address_id, addressId(1));
      assert.ok(Math.abs(orders[0].p_location.latitude - north(3200).latitude) < 1e-9, 'the phone fix is sent so the server can measure the distance');

      // The total a sheet quotes can't go stale: a cart change closes it, and one made while the phone was still being awaited is caught on confirm.
      const bumpCart = (by = 1) => page.evaluate(([key, by]) => { const record = JSON.parse(localStorage.getItem(key)); record.revision += 1; record.lines[0].quantity = Math.max(1, record.lines[0].quantity + by); localStorage.setItem(key, JSON.stringify(record)); window.dispatchEvent(new StorageEvent('storage', { key })); }, [`market:cart:${slug}`, by]);
      await reset(); await context.setGeolocation({ ...north(3200), accuracy: 12 }); await toCart(); await text('Deliver to Home').waitFor();
      await button('Place order').click(); await text('You\'re 3.2 km from this address').waitFor();
      await bumpCart(); await text('You\'re 3.2 km from this address').waitFor({ state: 'hidden' });
      assert.equal(orders.length, 0, 'a cart change closes the sheet without sending');
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      await page.evaluate(() => { navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.watchPosition = () => 0; });
      await button('Place order').click(); await button('Please wait…').waitFor(); await bumpCart();
      await text('We couldn\'t confirm where you are').waitFor({ timeout: 20000 });
      await button('Yes, place order').click(); await text('Your total changed. Please check your order and try again.').waitFor();
      assert.equal(orders.length, 0, 'a stale total is never sent'); assert.equal(await attempt(), null);
      await bumpCart(-9); await context.grantPermissions(['geolocation']);

      // Far away: "not in Khed".
      await reset(); await context.setGeolocation({ latitude: 18.52, longitude: 73.85, accuracy: 12 }); await toCart(); await text('Deliver to Home').waitFor();
      await button('Place order').click(); await text('You\'re not in Khed right now').waitFor();
      await text('You\'re ordering to Home, Flat 3, Sai Krupa Apartments, Bharne Naka. Ordering for someone there?').waitFor();
      await button('Change address').click(); assert.equal(orders.length, 0);

      // No location: NoLocation sheet; Yes places it with a null fix, never blocked.
      await context.clearPermissions(); await reset(); await toCart(); await text('Deliver to Home').waitFor();
      await button('Place order').click();
      await text('We couldn\'t confirm where you are').waitFor();
      await text('You\'re ordering to Home, Flat 3, Sai Krupa Apartments, Bharne Naka. Your phone didn\'t share its location, so please check this is right.').waitFor();
      await text('Make sure someone at the address can take the food and pay ₹120 in cash. The restaurant may call you to confirm.').waitFor();
      assert.equal(orders.length, 0);
      await shot('nolocation');
      await button('Yes, place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders.length, 1); assert.equal(orders[0].p_location, null, 'no fix, still ordered');
      assert.equal(orders[0].p_delivery.address_id, addressId(1));

      // A phone that never answers (unanswered prompt, no fix) falls back to the same sheet after about 8 s, and ordering still works.
      await context.grantPermissions(['geolocation']); await reset(); await toCart(); await text('Deliver to Home').waitFor();
      await page.evaluate(() => { navigator.geolocation.getCurrentPosition = () => {}; navigator.geolocation.watchPosition = () => 0; });
      await button('Place order').click();
      await button('Please wait…').waitFor();
      await text('We couldn\'t confirm where you are').waitFor({ timeout: 20000 });
      assert.equal(orders.length, 0);
      // Change address from the sheet, then close the picker: focus goes back to Place order, not to the page.
      await button('Change address').click(); await visible(page.getByRole('heading', { name: 'Delivery address', exact: true })).first().waitFor();
      await button('Close').click();
      await page.waitForFunction(() => document.activeElement?.textContent === 'Place order');
      await button('Place order').click(); await text('We couldn\'t confirm where you are').waitFor({ timeout: 20000 });
      await button('Yes, place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders.length, 1); assert.equal(orders[0].p_location, null);
      await context.setGeolocation({ ...HOME, accuracy: 12 });

      // ADDRESS_CHANGED: addresses are read again, the message is shown, nothing is left pending.
      await context.grantPermissions(['geolocation']); await context.setGeolocation({ ...HOME, accuracy: 12 });
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      const before = fixture.listCalls; fixture.mode = 'changed'; fixture.rows[0].version = 2; fixture.rows[0].house = 'Flat 3A';
      await button('Place order').click();
      await text('This address changed. Check it and try again.').waitFor();
      await text('Flat 3A, Sai Krupa Apartments, Bharne Naka · 1.2 km').waitFor(); assert.ok(fixture.listCalls > before, 'addresses refreshed');
      assert.equal(await attempt(), null, 'a definite rejection releases the attempt, so it is not replayed');
      assert.equal(orders.length, 1);
      fixture.mode = 'placed'; await button('Place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders.at(-1).p_delivery.address_version, 2, 'the retry sends the reviewed new version');

      // DELIVERY_UNAVAILABLE: the message shows and the address is deselected.
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      fixture.mode = 'unavailable'; await button('Place order').click();
      await text('We can\'t deliver to this address. We deliver in Khed and nearby villages. Choose another address.').waitFor();
      await button('Choose delivery address').waitFor(); await text('No address chosen').waitFor();
      assert.equal(await attempt(), null); assert.equal(await button('Choose a delivery address').count(), 1);
      fixture.mode = 'placed';

      // Lost response: the retry resends the identical request and key, and recovers the one order.
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      fixture.mode = 'lost'; await button('Place order').click();
      await button('Retry order recovery').waitFor();
      const frozen = await attempt(); assert.ok(frozen); assert.equal(JSON.parse(frozen).version, 2);
      assert.deepEqual(JSON.parse(frozen).savedAddress, { id: addressId(1), version: 2 });
      await button('Retry order recovery').click(); await page.waitForURL(/\/orders\//);
      assert.equal(orders.length, 2); assert.deepEqual(orders[1], orders[0], 'the retry resends the same payload and idempotency key');

      // An attempt saved by the old typed-address checkout (version 1) is discarded safely: not replayed, no crash.
      await reset(); await toCart(); await text('Deliver to Home').waitFor();
      const sentBefore = orders.length;
      await page.evaluate(([key, userId]) => localStorage.setItem(key, JSON.stringify({ version: 1, businessId: key.split(':')[2], userId, idempotencyKey: 'legacy-fixture', lines: [], pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 }, delivery: { name: 'Legacy', phone: '+919876543210', addressLine: 'Typed address line' }, location: { latitude: 1, longitude: 2, accuracy: 3, capturedAtISO: '2026-01-01T00:00:00Z' } })), [`market:checkout:${slug}`, userId]);
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText(/could not be read/).first().waitFor({ state: 'attached' });
      assert.equal(await button('Retry order recovery').count(), 0, 'the legacy attempt is not offered for replay');
      assert.equal(orders.length, sentBefore, 'the legacy attempt is never sent');
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} checkout picker (in/out of area, add, select), direct, remote, not-in-Khed, no-location, ADDRESS_CHANGED, DELIVERY_UNAVAILABLE, idempotent retry, legacy v1 attempt discarded`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
