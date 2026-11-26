import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { otpSignIn } from './otp-login.mjs';

// #207 part 2: a response that was issued for customer A and arrives after A signed out is never used, whoever is signed in by then.
// Through the real customer UI (CustomerArea, the services and the installed SDK) with fixture HTTP whose responses are decided when the request is
// made (by the caller's token) and released later: the order read behind a placed order (receipt), a revised quote (pricing_changed), the order history
// and an offer quote. Each is released after (a) A -> B and (b) A -> guest -> A (a new generation of the same user). Rendered text, the URL, the requests
// sent and every localStorage value (market:checkout:<biz>, market:cart:<biz>, own-name) are asserted. Already covered elsewhere, not repeated here:
// checkout-signin213 (INVALID_SESSION keeps the attempt and key, other user refused), checkout48 (lost response retry), customer-offers182 (stale quote after a cart edit).
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = n => ({ id: `20700000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `u${n}@example.test`, phone: n === 1 ? '919876543210' : '919123456780', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' });
const [A, B] = [mkUser(1), mkUser(2)];
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const HOME = { latitude: 17.719, longitude: 73.397 };
const addressRow = { id: '20710000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 };
const price = 25000, fee = 2000, autoId = '20730000-0000-4000-8000-0000000000a1';
const secretName = 'Asha Patil'; // typed by A at checkout: never to be shown or stored for anyone else
const shots = process.env.STALE_SHOTS ?? 'dist/browser';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

// The server's quote for a cart (the automatic offer: 20% off up to Rs 100 above Rs 300).
function quote(items) {
  const lines = items.map(i => ({ menu_item_id: i.menu_item_id, quantity: i.quantity, unit_price_paise: price, line_total_paise: price * i.quantity }));
  const subtotal = lines.reduce((sum, l) => sum + l.line_total_paise, 0), offer = subtotal >= 30000;
  const discount = offer ? Math.min(Math.floor(subtotal * 20 / 100), 10000) : 0;
  const pricing = { lines, delivery_fee_paise: fee, min_order_paise: 0, subtotal_paise: subtotal, total_paise: subtotal + fee - discount, ...(offer ? { discount_paise: discount, offer: { id: autoId, name: 'Launch offer', code: null, kind: 'percent' } } : {}) };
  return { pricing, nudge: offer ? null : { offer_id: autoId, name: 'Launch offer', kind: 'percent', value: 20, shortfall_paise: 30000 - subtotal } };
}

async function world(slug, brand) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
  const businessId = `20720000-0000-4000-8000-00000000000${brand + 1}`, orderBase = '20750000-0000-4000-8000-0000000000';
  const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: fee, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const item = { id: '20740000-0000-4000-8000-000000000001', name: 'Stale fixture meal', description: 'Synthetic fixture', category_id: '20760000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: price, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
  const fx = { rows: [], keys: new Map(), places: [], quotes: [], place: 'placed', errors: [], gates: {} };
  /** The next request of this kind is answered (from what it carried) only once released. */
  const hold = name => { let release, arrive; const gate = { taken: false, released: new Promise(r => { release = r; }), arrived: new Promise(r => { arrive = r; }), release, arrive }; fx.gates[name] = gate; return gate; };
  const pass = async name => { const gate = fx.gates[name]; if (!gate || gate.taken) return; gate.taken = true; gate.arrive(); await gate.released; };
  const arrived = (gate, what) => Promise.race([gate.arrived, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} was never requested`)), 10000))]);
  const row = (id, who, name, lines, total) => ({ id, business_id: businessId, customer_id: who, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: total - fee, delivery_fee_paise: fee, total_paise: total, customer_name: name, customer_phone: '+919876543210', delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka',
    order_items: lines.map(([title, quantity, unit]) => ({ menu_item_id: item.id, diet: null, name: title, quantity, unit_price_paise: unit, line_total_paise: unit * quantity })), order_status_history: [] });
  fx.row = row;
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
    const path = url.pathname;
    if (path === '/auth/v1/token') { const input = request.postDataJSON(); return json(sessionFor([A, B].find(u => u.email === input.email || u.id === input.refresh_token) ?? A)); }
    if (path === '/auth/v1/user') return json([A, B].find(u => u.id === who) ?? A);
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    if (path === '/rest/v1/businesses') return json(business);
    if (path === '/rest/v1/menu_items') return json([item]);
    if (path === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
    if (path === '/rest/v1/orders') { // the caller's own rows only (RLS), decided now; a held answer keeps what it was decided with
      const owner = url.searchParams.get('customer_id')?.replace('eq.', ''), id = url.searchParams.get('id')?.replace('eq.', '');
      const rows = fx.rows.filter(r => (!owner || r.customer_id === owner) && (!id || r.id === id)).map(r => structuredClone(r));
      await pass(id ? 'read' : 'history'); return json(id ? rows[0] ?? null : rows);
    }
    if (path === '/rest/v1/rpc/list_active_offers') return json([]);
    if (path === '/rest/v1/rpc/quote_order') {
      const body = request.postDataJSON(); fx.quotes.push({ who, body }); const q = quote(body.p_items);
      const answer = { outcome: 'quoted', pricing: q.pricing, offer_error: null, nudge: q.nudge }; await pass('quote'); return json(answer);
    }
    if (path === '/rest/v1/rpc/list_addresses') return json([addressRow]);
    if (path === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (path === '/rest/v1/customer_businesses') return json([]);
    if (path === '/rest/v1/rpc/place_order') {
      const body = request.postDataJSON(), terms = body.p_accepted_pricing; fx.places.push({ who, body });
      let answer;
      if (fx.place === 'repriced') { fx.place = 'placed'; answer = { outcome: 'pricing_changed', pricing: { ...terms, delivery_fee_paise: 3000, total_paise: terms.subtotal_paise + 3000 - (terms.discount_paise ?? 0) } }; }
      else {
        // Idempotent like the server: the same key is the same order.
        if (!fx.keys.has(body.p_idempotency_key)) { const id = `${orderBase}${String(fx.rows.length + 1).padStart(2, '0')}`; fx.keys.set(body.p_idempotency_key, id); fx.rows.push(row(id, who, body.p_delivery.name, terms.lines.map(l => [item.name, l.quantity, l.unit_price_paise]), terms.total_paise)); }
        answer = { outcome: 'placed', id: fx.keys.get(body.p_idempotency_key) };
      }
      await pass('place'); return json(answer);
    }
    throw new Error(`Unexpected request ${request.method()} ${path}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => fx.errors.push(error.message));
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const text = value => visible(page.getByText(value, { exact: true }));
  const w = { slug, server, context, page, fx, hold, arrived, button, text, visible, businessId, item };
  w.body = () => page.locator('body').innerText();
  w.shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/${slug}-stale207-${name}.png`, fullPage: true }); };
  w.drawer = async () => { await button('Account').click(); const settings = button('Account settings'); if (await settings.count()) await settings.click(); };
  w.signIn = async user => { await button('Account').click(); await otpSignIn(page, { email: user.email }); await button('Sign out').waitFor(); };
  w.signOut = async () => { await w.drawer(); await button('Sign out').click(); await button('Get code').waitFor(); };
  /** Every localStorage value, minus the session token (it is rewritten as the SDK refreshes it). */
  w.storage = () => page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => !/:customer$/.test(key))));
  w.stored = key => page.evaluate(k => { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; }, key);
  w.attempt = () => w.stored(`market:checkout:${slug}`);
  w.cart = () => w.stored(`market:cart:${slug}`);
  w.cartLink = () => visible(page.getByRole('button', { name: /^Cart \(/ }));
  w.go = async label => { await button('Account').click(); await button(label).click(); };
  w.toMenu = async () => { await w.go('Browse menu'); await button('Add to cart').first().waitFor(); };
  w.addAndOpenCart = async () => { if (await button('Add to cart').count()) await button('Add to cart').first().click(); await w.cartLink().click(); await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor(); };
  w.fillName = name => visible(page.getByLabel('Name', { exact: true })).fill(name);
    /** Signs A out and then B, or A again, in: the same customer is a new generation. */
  w.switchTo = async variant => { await w.signOut(); await w.signIn(variant === 'B' ? B : A); };
  return w;
}

// Nothing of A's reaches the screen or the stored state once a different identity (B or A again) is in place, and a late response rewrites nothing.
const assertNoLeak = async (w, variant, { before, privates = [secretName], allowAttempt }) => {
  const after = await w.storage(), body = await w.body();
  assert.deepEqual(after, before, 'the late response wrote nothing to storage');
  for (const secret of privates) assert.equal(body.includes(secret), false, `${secret} is not shown after A -> ${variant}`);
  assert.equal(new URL(w.page.url()).pathname.startsWith('/orders/'), false, 'no receipt or order screen was opened');
  assert.equal(body.includes('Review revised order'), false, 'no revised quote');
  if (variant === 'B') for (const [key, value] of Object.entries(after)) if (key !== `market:checkout:${w.slug}` || !allowAttempt) assert.equal(value.includes(secretName), false, `${key} holds nothing of A's for B`);
  assert.deepEqual(w.fx.errors, []);
};

async function receipt(slug, brand, variant) {
  const w = await world(slug, brand), { page, fx, button, text } = w;
  try {
    await page.goto(w.server.url, { waitUntil: 'networkidle' }); await w.signIn(A); await w.toMenu(); await w.addAndOpenCart(); await w.fillName(secretName);
    const read = w.hold('read'); await button('Place order').click(); await w.arrived(read, 'the order read');
    assert.equal(fx.places.length, 1, 'the order was written for A'); const key = fx.places[0].body.p_idempotency_key;
    await w.switchTo(variant); await page.waitForTimeout(600);
    const before = await w.storage(); const sent = fx.places.length;
    read.release(); await page.waitForTimeout(1500);
    await w.shot(`receipt-${variant}-390`);
    await assertNoLeak(w, variant, { before, allowAttempt: true });
    assert.equal(fx.places.length, sent, 'nothing is re-sent');
    // A's saved attempt (and its key) is kept for A, untouched by the late response.
    assert.equal((await w.attempt())?.idempotencyKey, key); assert.equal((await w.attempt())?.userId, A.id);
    // After a reload the same holds.
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(800);
    assert.equal((await w.body()).includes(secretName), false); assert.equal(new URL(page.url()).pathname.startsWith('/orders/'), false);
    if (variant === 'B') {
      await page.goto(`${w.server.url}/cart`, { waitUntil: 'networkidle' });
      assert.equal(await text('Order awaiting confirmation').count() > 0, true, 'the unconfirmed attempt is still pending');
      await button('Retry order recovery').click(); await text('Sign in with the account used for this order to recover it.').waitFor();
      assert.equal(fx.places.length, sent, 'B cannot replay A\'s attempt'); assert.equal((await w.attempt()).idempotencyKey, key);
    } else {
      // Same customer again: the old response was not the receipt, so the attempt is recovered by retrying the same request.
      await page.goto(`${w.server.url}/cart`, { waitUntil: 'networkidle' }); await text('Order awaiting confirmation').waitFor();
      await button('Retry order recovery').click(); await page.waitForURL(/\/orders\//);
      assert.equal(fx.places.length, sent + 1); assert.equal(fx.places.at(-1).body.p_idempotency_key, key, 'the retry reuses the saved idempotency key');
      assert.equal(fx.rows.length, 1, 'one order only'); assert.equal(await w.attempt(), null, 'released once recovered');
    }
  } catch (error) { await w.shot('failure').catch(() => {}); console.error((await w.body().catch(() => '')).slice(0, 1500)); throw error; }
  finally { await w.context.close(); await w.server.close(); }
}

async function revised(slug, brand, variant) {
  const w = await world(slug, brand), { page, fx, button, text } = w;
  try {
    await page.goto(w.server.url, { waitUntil: 'networkidle' }); await w.signIn(A); await w.toMenu(); await w.addAndOpenCart(); await w.fillName(secretName);
    fx.place = 'repriced'; const gate = w.hold('place'); await button('Place order').click(); await w.arrived(gate, 'the order');
    const key = fx.places[0].body.p_idempotency_key;
    await w.switchTo(variant); await page.waitForTimeout(600);
    const before = await w.storage(); const sent = fx.places.length;
    gate.release(); await page.waitForTimeout(1500);
    await w.shot(`revised-${variant}-390`);
    await assertNoLeak(w, variant, { before, allowAttempt: true, privates: [secretName, 'Delivery fee: ₹20 → ₹30'] });
    assert.equal(fx.places.length, sent, 'nothing is re-sent'); { const cart = await w.cart(); assert.equal(cart?.ownerId, (variant === 'B' ? B : A).id); assert.deepEqual(cart.lines, [], 'the new identity\'s cart holds none of A\'s dishes'); }
    assert.equal((await w.attempt())?.idempotencyKey, key, 'A\'s attempt is not released by a response for another generation');
    await page.reload({ waitUntil: 'networkidle' }); await page.waitForTimeout(800);
    assert.equal((await w.body()).includes('Review revised order'), false, 'not after a reload either');
  } catch (error) { await w.shot('failure').catch(() => {}); console.error((await w.body().catch(() => '')).slice(0, 1500)); throw error; }
  finally { await w.context.close(); await w.server.close(); }
}

async function history(slug, brand, variant) {
  const w = await world(slug, brand), { page, fx, button, text } = w;
  try {
    const aRow = (id, title) => fx.row(id, A.id, 'Asha Patil', [[title, 1, price]], price + fee);
    fx.rows.push(aRow('20750000-0000-4000-8000-000000000a01', 'A stale thali'));
    fx.rows.push(fx.row('20750000-0000-4000-8000-000000000b01', B.id, 'Meera Joshi', [['B own thali', 1, price]], price + fee));
    await page.goto(w.server.url, { waitUntil: 'networkidle' });
    const gate = w.hold('history'); await w.signIn(A); await w.arrived(gate, 'A\'s order history');
    // A's snapshot is what the held answer carries; the server's current list for A changes before the late answer lands.
    fx.rows.splice(0, 1, aRow('20750000-0000-4000-8000-000000000a02', 'A fresh thali'));
    await w.switchTo(variant); await w.go('Your orders');
    await text('1 orders loaded').first().waitFor();
    await text(variant === 'B' ? '1 × B own thali · ₹250' : '1 × A fresh thali · ₹250').first().waitFor();
    const before = await w.storage(); gate.release(); await page.waitForTimeout(1500);
    const body = await w.body();
    assert.equal(body.includes('A stale thali'), false, 'the old A list never appears'); assert.equal(body.includes('1 orders loaded'), true, 'the list was not merged with the late one');
    if (variant === 'B') assert.equal(body.includes('A fresh thali'), false, 'nothing of A is shown to B');
    else assert.equal(body.includes('B own thali'), false);
    assert.deepEqual(await w.storage(), before, 'nothing written'); assert.deepEqual(fx.errors, []);
    await w.shot(`history-${variant}-390`);
  } catch (error) { await w.shot('failure').catch(() => {}); console.error((await w.body().catch(() => '')).slice(0, 1500)); throw error; }
  finally { await w.context.close(); await w.server.close(); }
}

async function offerQuote(slug, brand, variant) {
  const w = await world(slug, brand), { page, fx, button, text } = w;
  try {
    await page.goto(w.server.url, { waitUntil: 'networkidle' }); await w.signIn(A); await w.toMenu(); await w.addAndOpenCart(); await w.fillName(secretName);
    await button('Add one Stale fixture meal').click(); await text('Offer applied: Launch offer').waitFor();
    const gate = w.hold('quote'); await button('Add one Stale fixture meal').click(); await w.arrived(gate, 'A\'s three-dish quote');
    assert.equal(fx.quotes.at(-1).who, A.id); assert.equal(fx.quotes.at(-1).body.p_items[0].quantity, 3);
    await w.switchTo(variant); await w.toMenu(); await w.addAndOpenCart(); await w.fillName('Meera Joshi');
    await text('Add ₹50 more to get 20% off').waitFor(); await text('₹270').first().waitFor();
    gate.release(); await page.waitForTimeout(1500);
    const body = await w.body();
    assert.equal(body.includes('Offer applied'), false, 'A\'s discount is not applied'); assert.equal(body.includes('₹670'), false, 'A\'s total is not shown');
    assert.equal(await text('Add ₹50 more to get 20% off').count() > 0, true, 'the new identity keeps its own quote');
    await button('Place order').click(); await page.waitForURL(/\/orders\//);
    const placed = fx.places.at(-1); assert.equal(placed.who, (variant === 'B' ? B : A).id);
    assert.equal(placed.body.p_accepted_pricing.discount_paise, undefined, 'no discount from A\'s quote'); assert.equal(placed.body.p_accepted_pricing.total_paise, 27000); assert.equal(placed.body.p_items[0].quantity, 1);
    assert.deepEqual(fx.errors, []);
  } catch (error) { await w.shot('failure').catch(() => {}); console.error((await w.body().catch(() => '')).slice(0, 1500)); throw error; }
  finally { await w.context.close(); await w.server.close(); }
}

try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    for (const variant of ['B', 'A'].filter(v => !process.env.STALE_VARIANT || v === process.env.STALE_VARIANT)) for (const [name, run] of [['receipt', receipt], ['revised quote', revised], ['order history', history], ['offer quote', offerQuote]].filter(([name]) => !process.env.STALE_ONLY || name === process.env.STALE_ONLY)) { await run(slug, brand, variant); console.log(`ok ${slug} ${name} A -> ${variant === 'B' ? 'B' : 'guest -> A'}`); }
  }
} finally { await browser.close(); }
