import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn } from './otp-login.mjs';

// #213 checkout when the session ended (the server's INVALID_SESSION, raised before any write), both brands. The customer sees a plain message (no "result
// may be uncertain"), the cart and the saved attempt (same idempotency key) are kept, the app goes to sign-in, and after signing back in as the same user the
// retry replays the same key. Signing in as someone else never reuses the attempt. Real customer exports and the installed SDK, with synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = n => ({ id: `88000000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `u${n}@example.test`, phone: n === 1 ? '919876543210' : '919123456780', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' });
const users = [mkUser(1), mkUser(2)];
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const HOME = { latitude: 17.719, longitude: 73.397 };
const addressRow = { id: '88100000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 };
const orderId = '88200000-0000-4000-8000-000000000001';
const shots = process.env.QUICK_SHOTS ?? 'dist/browser';
const message = 'You were signed out. Sign in again to place your order — your cart is saved.';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

async function run(slug, brand) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
  const errors = [], orders = [], businessId = `88300000-0000-4000-8000-00000000000${brand + 1}`;
  const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const item = { id: '88400000-0000-4000-8000-000000000001', name: 'Sign-in fixture meal', description: 'Synthetic fixture', category_id: '88500000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
  let placed = null, deadSessions = 0; // deadSessions: how many next place_order calls fail as INVALID_SESSION
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
    if (url.pathname === '/rest/v1/rpc/list_addresses') return json(who === users[0].id ? [addressRow] : []);
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (url.pathname === '/rest/v1/customer_businesses') return json([]);
    if (url.pathname === '/rest/v1/rpc/place_order') {
      const body = request.postDataJSON(); orders.push({ key: body.p_idempotency_key, who });
      if (deadSessions > 0) { deadSessions--; return json({ code: '42501', message: 'permission denied', details: 'INVALID_SESSION', hint: null }, 403); }
      const terms = body.p_accepted_pricing;
      placed = { id: orderId, business_id: businessId, customer_id: who, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
      return json({ outcome: 'placed', id: orderId });
    }
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const text = value => visible(page.getByText(value, { exact: true }));
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${slug}-signin213-${name}.png`, fullPage: true }); };
  const attemptKey = () => page.evaluate(key => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw).idempotencyKey : null; }, `market:checkout:${slug}`);
  const attemptLines = () => page.evaluate(key => { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw).lines.map(line => [line.item.id, line.quantity]) : null; }, `market:checkout:${slug}`);
  const body = () => page.locator('body').innerText();
  const fillAndPlace = async () => {
    await page.goto(server.url, { waitUntil: 'networkidle' });
    if (await button('Add to cart').count()) await button('Add to cart').first().click();
    await visible(page.getByRole('button', { name: /^Cart \(/ })).click(); await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor();
    await visible(page.getByLabel('Name', { exact: true })).fill('Asha Patil');
    deadSessions = 1; await button('Place order').click();
  };
  const expectSignedOutFlow = async () => {
    await text(message).waitFor(); await button('Get code').waitFor();
    assert.equal((await body()).includes('may be uncertain'), false, 'nothing is uncertain');
    assert.equal(new URL(page.url()).pathname, '/login', 'sent to sign in');
    assert.deepEqual(await attemptLines(), [[item.id, 1]], 'the cart lines are kept in the saved attempt (a local sign-out clears the cart draft by design)');
  };
  try {
    // 1. The session ended: the message, sign-in screen, kept cart and kept attempt.
    await page.goto(server.url, { waitUntil: 'networkidle' }); await button('Account').click(); await otpSignIn(page, { email: users[0].email }); await button('Sign out').waitFor();
    await fillAndPlace(); await expectSignedOutFlow();
    assert.equal(orders.length, 1); const key = await attemptKey(); assert.ok(key, 'the attempt (and its key) is kept'); assert.equal(orders[0].key, key);
    await shot('signed-out-390');
    // 2. Signing back in as the same user returns to the cart; retrying replays the same key and places exactly one order.
    await otpSignIn(page, { email: users[0].email }); await text('Order awaiting confirmation').waitFor(); await page.waitForURL(/\/cart$/, { timeout: 5000 });
    assert.equal((await body()).includes(message), false, 'the note clears once signed in');
    await text('Order awaiting confirmation').waitFor(); assert.equal(await attemptKey(), key);
    assert.ok((await body()).includes('1 × Sign-in fixture meal'), 'the saved order lines are shown'); assert.ok((await body()).includes('You were signed out before this order could be checked'), 'plain card copy'); assert.equal((await body()).includes('may have been received'), false);
    await button('Retry order recovery').click(); await page.waitForURL(/\/orders\//);
    assert.deepEqual(orders.map(o => o.key), [key, key], 'the retry reuses the same idempotency key'); assert.equal(await attemptKey(), null, 'the attempt is released after the order');
    // 3. Signing in as a different user never reuses the attempt: the existing identity handling asks for the original account.
    placed = null; orders.length = 0;
    await fillAndPlace(); await expectSignedOutFlow(); const second = await attemptKey(); assert.ok(second && second !== key);
    await otpSignIn(page, { email: users[1].email }); await text('Order awaiting confirmation').waitFor();
    await button('Retry order recovery').click(); await text('Sign in with the account used for this order to recover it.').waitFor();
    assert.equal(orders.length, 1, 'nothing is sent for the other user'); assert.equal(await attemptKey(), second, 'the attempt is untouched');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${slug} ended session at checkout keeps the cart and attempt, goes to sign-in, and retries with the same key`);
  } catch (error) { await shot('failure').catch(() => {}); throw error; }
  finally { await context.close(); await server.close(); }
}
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) await run(slug, brand);
} finally { await browser.close(); }
