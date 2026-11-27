import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn, profileFixture, profilesUnavailable } from './otp-login.mjs';

// #45 slice 2c, both brands: checkout's "Me" uses the canonical profile name. The profile name prefills "Me" once the read is confirmed;
// a typed name is never replaced (not even by a slow read); after a successful order the typed name is saved to a profile that confirmed
// it has none (never when the read failed, never for "Someone else", never at the cost of the order); the old device-only name is migrated and
// removed; and another account never sees the previous account's name. Real customer exports and the installed SDK, synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = (n, phone) => ({ id: `45600000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `u${n}@example.test`, phone, app_metadata: {}, user_metadata: { full_name: 'Stale Metadata Name' }, identities: [], created_at: '2026-01-01T00:00:00Z' });
const users = [mkUser(1, '919876543210'), mkUser(2, '919123456780'), mkUser(3, '919000011111')];
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const HOME = { latitude: 17.719, longitude: 73.397 };
const addressRow = id => ({ id, label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 });
const homeId = '45700000-0000-4000-8000-000000000001', orderId = '45800000-0000-4000-8000-000000000001';
const shots = process.env.CHECKOUT_ME_SHOTS ?? 'dist/browser';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

async function run(slug, brand) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
  const errors = [], orders = [], businessId = `45900000-0000-4000-8000-00000000000${brand + 1}`;
  const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const item = { id: '45a00000-0000-4000-8000-000000000001', name: 'Checkout name fixture meal', description: 'Synthetic fixture', category_id: '45b00000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
  let placed = null;
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
    if (url.pathname === '/rest/v1/rpc/list_addresses') return json([addressRow(homeId)]);
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (url.pathname === '/rest/v1/customer_businesses') return json([]);
    if (url.pathname === '/rest/v1/profiles') return profilesUnavailable(route); // before the first sign-in; afterwards the page-level fixture answers
    if (url.pathname === '/rest/v1/rpc/place_order') {
      const body = request.postDataJSON(); orders.push(body); const terms = body.p_accepted_pricing;
      placed = { id: orderId, business_id: businessId, customer_id: who, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
      return json({ outcome: 'placed', id: orderId });
    }
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const profiles = profileFixture(page); profiles.mode = 'live';
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const text = value => visible(page.getByText(value, { exact: true }));
  const field = label => visible(page.getByLabel(label, { exact: true }));
  const radio = name => visible(page.getByRole('radio', { name, exact: true }));
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${slug}-${name}.png`, fullPage: true }); };
  const ownKey = user => `market:own-name:${encodeURIComponent(user.id)}`;
  const device = user => page.evaluate(key => localStorage.getItem(key), ownKey(user));
  const until = async (condition, what) => { for (let waited = 0; !(await condition()); waited += 50) { assert.ok(waited < 6000, `timed out waiting for ${what}`); await page.waitForTimeout(50); } };
  const saves = () => profiles.writes.map(write => ({ who: write.who, name: write.body.full_name }));
  const nameValue = () => field('Name').inputValue();
  const frame = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  // A signed-in cart reads the profile when it opens: run `action`, wait for that answer, and give the screen a frame to show it.
  const afterRead = async action => {
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/profiles' && response.request().method() === 'GET');
    await action(); await answered.catch(() => {}); await frame();
  };
  const signIn = async user => { await button('Account').click(); const settings = button('Account settings'); if (await settings.count()) await settings.click(); await otpSignIn(page, { email: user.email }); await button('Sign out').waitFor(); };
  const signOut = async () => { await button('Account').click(); const settings = button('Account settings'); if (await settings.count()) await settings.click(); await button('Sign out').click(); await button('Get code').waitFor(); };
  const addDish = async () => { if (await button('Add to cart').count()) await button('Add to cart').first().click(); }; // a cart left by a checked-but-unordered visit already holds the dish
  const openCart = async ({ read = true } = {}) => {
    await page.goto(server.url, { waitUntil: 'networkidle' }); await addDish();
    await (read ? afterRead : action => action())(() => visible(page.getByRole('button', { name: /^Cart \(/ })).click()); await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor();
  };
  const place = async expected => {
    const before = orders.length; await button('Place order').click(); await page.waitForURL(/\/orders\//); assert.equal(orders.length, before + 1);
    assert.deepEqual({ name: orders.at(-1).p_delivery.name, phone: orders.at(-1).p_delivery.phone }, expected);
    assert.equal((await page.locator('body').innerText()).includes('Could not reach your profile'), false, 'a profile problem never shows over a placed order');
  };
  try {
    // 1. The profile name fills "Me" (the verified phone too), with no typing at all.
    profiles.names[users[0].id] = 'Asha Patil';
    await page.goto(server.url, { waitUntil: 'networkidle' }); await signIn(users[0]);
    await openCart();
    assert.equal(await radio('Me').getAttribute('aria-checked'), 'true');
    assert.deepEqual({ name: await nameValue(), phone: await field('Mobile number').inputValue() }, { name: 'Asha Patil', phone: '9876543210' }, 'Name from the profile, Mobile from the verified login');
    assert.equal(await page.evaluate(() => document.body.innerText.includes('Stale Metadata Name')), false, 'user_metadata is never used');
    await shot('me-prefilled-390');
    // 2. A name that exists is never replaced by an order, even an edited one; nothing is saved.
    await field('Name').fill('Asha P'); await place({ name: 'Asha P', phone: '+919876543210' });
    await page.waitForTimeout(300); assert.deepEqual(saves(), [], 'an existing profile name is not overwritten by an order');
    assert.equal(profiles.names[users[0].id], 'Asha Patil');

    // 3. A typed name wins over a slow profile read: the read is delayed, the customer types first, the answer lands afterwards.
    profiles.delay = 1500; await page.goto(server.url, { waitUntil: 'networkidle' }); await addDish();
    const slow = page.waitForResponse(response => new URL(response.url()).pathname === '/rest/v1/profiles' && response.request().method() === 'GET');
    await visible(page.getByRole('button', { name: /^Cart \(/ })).click(); await text('Delivery details').waitFor(); await text('Deliver to Home').waitFor();
    assert.equal(await nameValue(), '', 'nothing is shown while the read is slow');
    await field('Name').fill('Typed Early'); await slow; await frame(); profiles.delay = 0;
    assert.equal(await nameValue(), 'Typed Early', 'the late profile read did not overwrite the typed name');
    await place({ name: 'Typed Early', phone: '+919876543210' }); await page.waitForTimeout(300);
    assert.deepEqual(saves(), [], 'a typed name never replaces an existing profile name');

    // 4. No saved name: the typed name is saved to the profile after the order (and only the name is sent).
    await signOut(); await signIn(users[1]);
    await openCart();
    assert.deepEqual({ name: await nameValue(), phone: await field('Mobile number').inputValue() }, { name: '', phone: '9123456780' }, 'no profile name: Name empty, and the previous account\'s name is not shown');
    await field('Name').fill('  Meera Joshi '); await place({ name: 'Meera Joshi', phone: '+919123456780' });
    await until(() => saves().length === 1, 'the profile save');
    assert.deepEqual(saves(), [{ who: users[1].id, name: 'Meera Joshi' }]); assert.deepEqual(profiles.writes[0].body, { full_name: 'Meera Joshi' });
    await openCart(); assert.equal(await nameValue(), 'Meera Joshi', 'the next checkout is prefilled from the saved profile');
    // 5. An order for "Someone else" saves nothing, even with no profile name.
    delete profiles.names[users[1].id]; const writesBefore = profiles.writes.length;
    await page.goto(server.url, { waitUntil: 'networkidle' }); await addDish();
    await afterRead(() => visible(page.getByRole('button', { name: /^Cart \(/ })).click()); await text('Deliver to Home').waitFor();
    await radio('Someone else').click(); await field('Recipient name').fill('Ravi Kadam'); await field('Recipient mobile number').fill('9000011111');
    await place({ name: 'Ravi Kadam', phone: '+919000011111' }); await page.waitForTimeout(300);
    assert.equal(profiles.writes.length, writesBefore, 'a recipient is never saved to the profile'); assert.equal(profiles.names[users[1].id], undefined);

    // 6. The profile cannot be read: the order still works and nothing is saved (an unreadable profile is not "no name").
    profiles.mode = 'unavailable'; const before = profiles.writes.length;
    await openCart(); assert.equal(await nameValue(), '', 'unavailable: no name is guessed');
    await field('Name').fill('Unavailable Typed'); await place({ name: 'Unavailable Typed', phone: '+919123456780' }); await page.waitForTimeout(500);
    assert.equal(profiles.writes.length, before, 'no save when the profile was unavailable'); profiles.mode = 'live';
    // 7. The save itself fails after the order: the order is unaffected and nothing alarming is shown.
    profiles.failWrites = 503; await openCart(); await field('Name').fill('Save Fails'); await place({ name: 'Save Fails', phone: '+919123456780' });
    await until(() => profiles.writes.length === before + 1, 'the failing save request'); await page.waitForTimeout(300);
    assert.equal(profiles.names[users[1].id], undefined, 'the failed save stored nothing'); assert.deepEqual(errors, []); profiles.failWrites = null;

    // 8. The old device-only name: unavailable profile leaves it alone; a profile that confirmed none uses it, saves it only after an order, then removes it.
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [ownKey(users[2]), JSON.stringify({ name: 'Old Device Name' })]);
    await signOut(); await signIn(users[2]);
    profiles.mode = 'unavailable'; await openCart();
    assert.equal(await nameValue(), '', 'an unreadable profile does not use the old device name'); assert.ok(await device(users[2]), 'and leaves it for later');
    profiles.mode = 'live'; await openCart();
    assert.equal(await nameValue(), 'Old Device Name', 'the profile confirmed no name, so the old device name is the prefill');
    assert.ok(await device(users[2]), 'the device copy stays until the profile holds the name');
    assert.equal(profiles.names[users[2].id], undefined, 'prefilling alone saves nothing');
    await place({ name: 'Old Device Name', phone: '+919000011111' });
    await until(() => profiles.names[users[2].id] === 'Old Device Name', 'the migrated name to be saved'); await until(async () => (await device(users[2])) === null, 'the device copy to be removed');
    // A profile that has a name makes a leftover device copy obsolete at once, and the profile name wins.
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [ownKey(users[2]), JSON.stringify({ name: 'Another Old Name' })]);
    await openCart(); assert.equal(await nameValue(), 'Old Device Name', 'the profile name wins over the device name');
    await until(async () => (await device(users[2])) === null, 'the obsolete device copy to be removed');
    // An unusable stored value is removed without being used.
    await page.evaluate(key => localStorage.setItem(key, 'not json'), ownKey(users[2])); await openCart();
    await until(async () => (await device(users[2])) === null, 'the unusable device value to be removed');
    // Nothing writes the own name on the device any more.
    await field('Name').fill('Typed After'); await place({ name: 'Typed After', phone: '+919000011111' });
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('own-name')).length), 0, 'no own name is written to the device');

    // 9. Another account never sees the previous name in "Me", not even while its own profile read is slow.
    profiles.names[users[0].id] = 'Asha Patil';
    await signOut(); await signIn(users[0]); await openCart(); assert.equal(await nameValue(), 'Asha Patil');
    await signOut();
    // Sampled every few milliseconds on every page load from here on (kept in sessionStorage across reloads): text and field values.
    await page.addInitScript(() => { setInterval(() => { const inputs = Array.from(document.querySelectorAll('input')).map(input => input.value).join(' '); if ((document.body?.innerText + inputs).includes('Asha')) sessionStorage.setItem('sawAsha', '1'); }, 10); });
    await page.goto(server.url, { waitUntil: 'networkidle' });
    profiles.delay = 1500; delete profiles.names[users[1].id]; await signIn(users[1]);
    await openCart({ read: false }); await page.waitForTimeout(2200); profiles.delay = 0; // the slow read is still on its way when the cart opens
    assert.equal(await page.evaluate(() => sessionStorage.getItem('sawAsha')), null, 'the previous account\'s name was never on screen for the next account');
    assert.equal(await nameValue(), '', 'the next account with no name sees an empty Name');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${slug} checkout "Me" uses the profile name: prefill, typed name kept, save after order, unavailable, migration and account switch`);
  } catch (error) { await shot('checkout-me-failure').catch(() => {}); throw error; }
  finally { await context.close(); await server.close(); }
}
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) await run(slug, brand);
} finally { await browser.close(); }
