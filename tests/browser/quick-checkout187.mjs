import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn } from './otp-login.mjs';

// #187 quicker checkout, both brands: the order is for "Me" (Mobile from the verified login phone, Name from the customer's own remembered
// name) or "Someone else" (separate, never-stored details); typed text is never overwritten; nothing is shown to the next account; and the
// add-address form is inline only once the address list has loaded with zero addresses. Payloads are asserted on place_order.
// Real customer exports and the installed SDK, with deterministic synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = (n, phone) => ({ id: `87000000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `u${n}@example.test`, phone, app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' });
const users = [mkUser(1, '919876543210'), mkUser(2, '919123456780')]; // Supabase stores the phone without a plus
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const HOME = { latitude: 17.719, longitude: 73.397 };
const addressRow = (id, extra = {}) => ({ id, label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200, ...extra });
const homeId = '87100000-0000-4000-8000-000000000001', newId = '87100000-0000-4000-8000-000000000002', orderId = '87200000-0000-4000-8000-000000000001';
const shots = process.env.QUICK_SHOTS ?? 'dist/browser';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

async function run(slug, brand, { demo = false } = {}) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
  const errors = [], orders = [], businessId = `87300000-0000-4000-8000-00000000000${brand + 1}`;
  const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: demo, ordering_enabled: true, accepting_orders: true };
  const item = { id: '87400000-0000-4000-8000-000000000001', name: 'Quick checkout meal', description: 'Synthetic fixture', category_id: '87500000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: demo, is_featured: false, sort_order: 0, image_url: null };
  const rows = { [users[0].id]: [addressRow(homeId)], [users[1].id]: [] }; // the second customer has no saved address
  let placed = null, listFails = false;
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
    const bearer = request.headers().authorization?.replace('Bearer ', '');
    const who = bearer?.includes('.') ? JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub : null;
    if (url.pathname === '/auth/v1/token') { const input = request.postDataJSON(); return json(sessionFor(users.find(u => u.email === input.email || u.id === input.refresh_token) ?? users[0])); }
    if (url.pathname === '/auth/v1/user') return json(users.find(u => u.id === who) ?? users[0]);
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/rest/v1/businesses') return json(business);
    if (url.pathname === '/rest/v1/menu_items') return json([item]);
    if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
    if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? placed : placed ? [placed] : []);
    const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
    if (url.pathname === '/rest/v1/rpc/list_addresses') return listFails ? json({ code: 'XX000', message: 'fixture address failure', details: null, hint: null }, 500) : json(rows[who] ?? []);
    if (url.pathname === '/rest/v1/customer_addresses' && request.method() === 'POST') { const row = addressRow(newId, { ...request.postDataJSON(), distance_m: 900 }); rows[who].push(row); return json({ id: newId, version: 1 }, 201); }
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (url.pathname === '/rest/v1/customer_businesses') return json([]);
    if (url.pathname === '/rest/v1/rpc/place_order') {
      const body = request.postDataJSON(); orders.push(body); const terms = body.p_accepted_pricing;
      placed = { id: orderId, business_id: businessId, customer_id: who, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
      return json({ outcome: 'placed', id: orderId });
    }
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const text = value => visible(page.getByText(value, { exact: true }));
  const field = label => visible(page.getByLabel(label, { exact: true }));
  const cartLink = () => visible(page.getByRole('button', { name: /^Cart \(/ }));
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${slug}-${name}.png`, fullPage: true }); };
  const stored = id => page.evaluate(key => localStorage.getItem(key), `market:own-name:${encodeURIComponent(id)}`);
  // Taps are counted as button presses from the menu to a placed order; typing is counted separately.
  let taps = 0;
  const tap = async locator => { taps++; await locator.click(); };
  const addAndOpenCart = async () => { await page.goto(server.url, { waitUntil: 'networkidle' }); taps = 0; if (await button('Add to cart').count()) await tap(button('Add to cart').first()); await tap(cartLink()); await text('Delivery details').waitFor(); };
  const signIn = async user => {
    await button('Account').click(); const settings = button('Account settings'); if (await settings.count()) await settings.click();
    await otpSignIn(page, { email: user.email }); await button('Sign out').waitFor();
  };
  const signOut = async () => { await button('Account').click(); const settings = button('Account settings'); if (await settings.count()) await settings.click(); await button('Sign out').click(); await button('Get code').waitFor(); };
  const place = async (expected) => { const before = orders.length; await tap(button('Place order')); await page.waitForURL(/\/orders\//); assert.equal(orders.length, before + 1); assert.deepEqual({ name: orders.at(-1).p_delivery.name, phone: orders.at(-1).p_delivery.phone }, expected); };
  const values = async () => ({ name: await field('Name').inputValue(), phone: await field('Mobile number').inputValue() });
  const otherValues = async () => ({ name: await field('Recipient name').inputValue(), phone: await field('Recipient mobile number').inputValue() });
  const radio = name => visible(page.getByRole('radio', { name, exact: true }));
  const isMe = async () => (await radio('Me').getAttribute('aria-checked')) === 'true';
  let typing = 0;
  const type = async (locator, value) => { typing++; await locator.fill(value); };
  const ownKey = JSON.stringify({ name: 'Asha Patil' });
  const counts = {};
  try {
    if (demo) {
      // The demo menu never prefills or stores: seed a remembered name for the signed-in account and check it stays unused and unchanged.
      await page.addInitScript(key => localStorage.setItem(key, JSON.stringify({ name: 'Stored Demo' })), `market:own-name:${encodeURIComponent(users[0].id)}`);
      await page.goto(server.url, { waitUntil: 'networkidle' }); await signIn(users[0]);
      await page.goto(server.url, { waitUntil: 'networkidle' }); await visible(page.getByRole('button').filter({ hasText: '+ Add' })).first().click(); await cartLink().click(); await text('Delivery details').waitFor();
      assert.deepEqual(await values(), { name: '', phone: '' }, 'the demo cart is not prefilled');
      await field('Name').fill('Demo typed'); await page.waitForTimeout(300);
      assert.equal(await stored(users[0].id), JSON.stringify({ name: 'Stored Demo' }), 'nothing is stored from the demo menu');
      assert.equal(orders.length, 0); assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} demo menu does not prefill or store`); return;
    }
    // 1. First order as "Me": Mobile is the verified login number (stored without a plus, shown as ten digits); Name is empty and typed once.
    await page.goto(server.url, { waitUntil: 'networkidle' }); await signIn(users[0]);
    await addAndOpenCart(); await text('Deliver to Home').waitFor();
    assert.equal(await isMe(), true, '"Me" is the default');
    assert.deepEqual(await values(), { name: '', phone: '9876543210' }, 'first order: Mobile from the signed-in phone, Name empty');
    assert.equal(await stored(users[0].id), null, 'nothing is stored before an order');
    typing = 0; await type(field('Name'), 'Asha Patil');
    await place({ name: 'Asha Patil', phone: '+919876543210' });
    assert.equal(await stored(users[0].id), ownKey, 'only the own name is stored, per user id');
    counts.firstTimer = { taps, typedFields: typing };

    // 2. Returning as "Me": Add -> Cart -> Place order with no typing sends the own name and the verified phone.
    await addAndOpenCart(); await text('Deliver to Home').waitFor();
    assert.deepEqual(await values(), { name: 'Asha Patil', phone: '9876543210' });
    await shot('me-prefilled-390');
    await place({ name: 'Asha Patil', phone: '+919876543210' });
    counts.returningMe = { taps, typedFields: 0 }; assert.equal(taps, 3, 'Add, Cart, Place order');

    // 3. "Someone else": empty recipient fields; the order carries them and the own name is not overwritten.
    await addAndOpenCart(); await text('Deliver to Home').waitFor();
    await radio('Someone else').click();
    assert.deepEqual(await otherValues(), { name: '', phone: '' }, 'recipient fields start empty');
    assert.equal(await field('Name').count(), 0, 'the own fields are replaced, not shown twice');
    await shot('someone-else-390');
    await field('Recipient name').fill('Ravi Kadam'); await field('Recipient mobile number').fill('9000011111');
    // 4. Switching back restores the account holder's details; switching again keeps the recipient's.
    await radio('Me').click();
    assert.deepEqual(await values(), { name: 'Asha Patil', phone: '9876543210' }, 'back to Me restores the own details');
    await radio('Someone else').click();
    assert.deepEqual(await otherValues(), { name: 'Ravi Kadam', phone: '9000011111' });
    await place({ name: 'Ravi Kadam', phone: '+919000011111' });
    assert.equal(await stored(users[0].id), ownKey, 'an order for someone else leaves the own name unchanged');
    assert.equal((await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => k + v).join())).includes('Ravi'), false, 'the recipient is never stored');

    // 5. Returning but signed out: nothing shown; signing in at Place order fills the own details and the order needs no more typing.
    await signOut(); await addAndOpenCart();
    assert.deepEqual(await values(), { name: '', phone: '' }, 'signed out: nothing from the last account');
    await tap(button('Place order')); await button('Get code').waitFor();
    await otpSignIn(page, { email: users[0].email });
    await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor();
    assert.deepEqual(await values(), { name: 'Asha Patil', phone: '9876543210' }, 'signing in fills the own details');
    await place({ name: 'Asha Patil', phone: '+919876543210' });
    counts.signedOutReturning = { taps, typedFields: 0 };

    // 6. A prefill that arrives late never overwrites typing: a name typed as a guest survives the prefill on sign-in.
    await signOut(); await addAndOpenCart(); await field('Name').fill('Guest Typed');
    await tap(button('Place order')); await button('Get code').waitFor(); await otpSignIn(page, { email: users[0].email });
    await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor();
    assert.deepEqual(await values(), { name: 'Guest Typed', phone: '9876543210' }, 'typed name kept, empty Mobile filled');
    assert.equal(await stored(users[0].id), ownKey, 'typing alone stores nothing');
    // Sign out while "Someone else" holds a recipient: the next visitor sees "Me", empty, and nothing from them.
    await radio('Someone else').click(); await field('Recipient name').fill('Ravi Kadam');
    await signOut(); await addAndOpenCart();
    assert.equal(await isMe(), true); assert.deepEqual(await values(), { name: '', phone: '' }, 'signed out: back to Me, empty');
    assert.equal((await page.locator('body').innerText()).includes('Ravi'), false);

    // 7. Another account on the same device. Its address list fails first: that is never treated as empty.
    await signIn(users[1]); listFails = true;
    await addAndOpenCart(); await button('Retry addresses').waitFor();
    assert.deepEqual(await values(), { name: '', phone: '9123456780' }, 'second account: its own login phone, no name');
    const pageText = await page.locator('body').innerText();
    for (const secret of ['Asha Patil', 'Guest Typed', 'Ravi', '9876543210', '9000011111']) assert.equal(pageText.includes(secret), false, `${secret} is not shown to the next account`);
    assert.equal(await field('House, flat or floor').count(), 0, 'an address-list error does not show the inline form');
    assert.equal(await button('Use my current location').count(), 0); assert.equal(await button('Save address').count(), 0);
    await field('Name').fill('Meera Joshi');
    // Tapping Place order here says so, takes the customer to Retry (not the picker, not a dead end) and places nothing.
    await button('Choose a delivery address').click(); await text('We couldn\'t load your addresses. Retry.').waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Retry addresses', null, { timeout: 5000 }); // Retry is focused
    assert.equal(await visible(page.getByRole('radiogroup', { name: 'Saved addresses' })).count(), 0, 'no picker opened'); assert.equal(await field('House, flat or floor').count(), 0);
    // 8. The list loads with zero addresses: now the form is inline, typed details and the cart are kept.
    listFails = false; await button('Retry addresses').click(); await field('House, flat or floor').waitFor();
    assert.deepEqual(await values(), { name: 'Meera Joshi', phone: '9123456780' }, 'typed details kept when the form appears');
    assert.equal(await button('Add a new address').count(), 0); assert.equal(await text('No saved addresses yet').count(), 0);
    assert.equal(await visible(page.getByRole('heading', { name: 'Add address', exact: true })).count(), 0, 'inline, not a panel');
    await shot('inline-address-390');
    // Place order with no address focuses the form's first empty field, and Save address clears the pinned bar when scrolled into place.
    await button('Add a delivery address').click(); await text('Add a delivery address first.').waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'House, flat or floor', null, { timeout: 5000 }); // the first empty field is focused
    const gap = await page.evaluate(() => {
      const bar = Array.from(document.querySelectorAll('[role="button"]')).find(el => el.textContent === 'Add a delivery address').parentElement.getBoundingClientRect();
      document.getElementById('checkout-address-form').scrollIntoView({ block: 'end' });
      const save = Array.from(document.querySelectorAll('[role="button"]')).find(el => el.textContent === 'Save address').getBoundingClientRect();
      return bar.top - save.bottom;
    });
    assert.ok(gap >= 0, `Save address is not covered by the pinned bar (gap ${gap}px)`);
    await button('Save address').click(); assert.ok(await visible(page.getByRole('alert')).count() > 0, 'the same validation as the dialog');
    assert.equal(rows[users[1].id].length, 0, 'an invalid form saves nothing');
    await field('House, flat or floor').fill('Flat 7'); await field('Street and area').fill('Market Road');
    await button('Use my current location').click(); await text('Delivery pin set from your phone\'s location.').waitFor();
    await button('Save address').click();
    await text('Deliver to Home').waitFor(); await text('Flat 7, Market Road · 900 m').waitFor();
    assert.equal(await field('House, flat or floor').count(), 0, 'the form is gone once an address is saved');
    assert.deepEqual(await values(), { name: 'Meera Joshi', phone: '9123456780' });
    await place({ name: 'Meera Joshi', phone: '+919123456780' });
    assert.equal(orders.at(-1).p_delivery.address_id, newId, 'the saved address is the one ordered to');
    assert.equal(await stored(users[1].id), JSON.stringify({ name: 'Meera Joshi' }));
    assert.deepEqual(errors, []);
    console.log(`PASS: ${slug} quick checkout. Taps from the menu to a placed order and fields typed: returning Me ${JSON.stringify(counts.returningMe)}; first-timer ${JSON.stringify(counts.firstTimer)}; signed-out returning (taps include the Place order that opens sign-in and the one after it; OTP entry not counted) ${JSON.stringify(counts.signedOutReturning)}`);
  } catch (error) { await shot('failure').catch(() => {}); throw error; }
  finally { await context.close(); await server.close(); }
}
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) await run(slug, brand);
  await run('ammu-sammu', 0, { demo: true });
} finally { await browser.close(); }
