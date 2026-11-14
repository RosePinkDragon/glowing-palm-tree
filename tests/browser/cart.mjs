import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

const fixture = 'https://market-fixture.supabase.co';
const slugs = ['ammu-sammu', 'kokani-dine-inn'];
const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'];
const itemIds = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
const users = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'].map((id, index) => ({ id, aud: 'authenticated', role: 'authenticated', email: `${index ? 'b' : 'a'}@example.test`, app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
function session(user) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.${part('fixture')}`;
  return { access_token: token, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
}
const businesses = slugs.map((slug, index) => ({ id: ids[index], slug, name: index ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true }));
const originalMenus = slugs.map((slug, index) => [{ id: itemIds[index], business_id: ids[index], name: `${index ? 'Kokani' : 'Ammu'} meal`, description: 'Synthetic cart fixture', category: 'Meals', price_paise: 15000, available: true, is_demo: false, image_url: null }]);
let menus = structuredClone(originalMenus);
let browser, context;
const servers = [];
const pageBrands = new Map();
const errors = [], external = [], recovered = [];
try {
  for (const slug of slugs) servers.push(await serveWeb(`apps/${slug}-customer/dist/web`));
  await mkdir('dist/browser', { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('market:cart:') && window.__failCartWrites) throw new DOMException('Synthetic cart storage failure', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await context.routeWebSocket(/.*/, socket => {
    if (new URL(socket.url()).origin !== 'wss://market-fixture.supabase.co') { external.push(socket.url()); socket.close(); return; }
    socket.onMessage(message => {
      const value = JSON.parse(String(message)); const array = Array.isArray(value);
      const [join, ref, topic, event, payload] = array ? value : [value.join_ref, value.ref, value.topic, value.event, value.payload];
      if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) {
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, i) => ({ ...change, id: i + 1 })) } };
        socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }
    });
  });
  // Serve both real exports at one origin so the test exercises shared localStorage.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === servers[0].url) {
      const index = pageBrands.get(request.frame().page()) ?? 0;
      return route.fulfill({ response: await context.request.get(servers[index].url + url.pathname + url.search) });
    }
    if (url.origin !== fixture) { external.push(url.href); return route.abort(); }
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/auth/v1/token') {
      const input = request.postDataJSON();
      return json(session(users.find(user => user.email === input.email || user.id === input.refresh_token) ?? users[0]));
    }
    if (url.pathname === '/auth/v1/user') {
      const token = request.headers().authorization?.replace('Bearer ', '');
      const id = token ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub : null;
      return json(users.find(user => user.id === id) ?? users[0]);
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/rest/v1/businesses') return json(businesses.find(b => url.searchParams.get('slug') === `eq.${b.slug}`));
    if (url.pathname === '/rest/v1/menu_items') return json(menus[ids.indexOf(url.searchParams.get('business_id')?.replace('eq.', ''))]);
    if (url.pathname === '/rest/v1/orders') return json([]);
    if (url.pathname === '/rest/v1/rpc/place_order') { recovered.push(request.postDataJSON()); return route.abort('failed'); }
    throw new Error('Unhandled cart fixture: ' + request.method() + ' ' + url.pathname);
  });
  const open = async (index, path = '/') => {
    const page = await context.newPage(); pageBrands.set(page, index);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(servers[0].url + path, { waitUntil: 'networkidle' }); return page;
  };
  const enabled = button => button.waitFor({ state: 'visible' }).then(async () => { await assertEventually(() => button.isEnabled()); });
  const cartLink = page => page.getByRole('button', { name: /^Cart \(/ });
  const account = async page => {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const settings = page.getByRole('button', { name: 'Account settings', exact: true });
    if (await settings.count()) await settings.click(); else await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  };
  const login = async (page, index = 0) => {
    await account(page);
    await page.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(users[index].email);
    await page.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  };
  const add = async page => { const button = page.getByRole('button', { name: 'Add to cart', exact: true }).first(); await enabled(button); await button.click(); await cartLink(page).waitFor(); };
  const saved = (page, slug) => page.evaluate(key => JSON.parse(localStorage.getItem(key)), `market:cart:${slug}`);
  const goCart = async page => { await cartLink(page).click(); await page.getByText('Delivery details', { exact: true }).filter({ visible: true }).waitFor(); };
  const pages = [];
  for (let index = 0; index < slugs.length; index++) {
    const page = await open(index); pages.push(page); await add(page); await goCart(page);
    await page.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Memory-only private name');
    await page.getByLabel('Delivery address', { exact: true }).filter({ visible: true }).fill('Private address');
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('₹150.00 × 1 = ₹150.00', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal(await page.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), '');
    const raw = await saved(page, slugs[index]); assert.equal(raw.lines.length, 1); assert.equal(raw.ownerId, null);
    assert.equal(JSON.stringify(raw).includes('Private address'), false);
    // Guest → login preserves this restaurant's draft, and survives another restart.
    await login(page); await goCart(page); await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('₹150.00 × 1 = ₹150.00', { exact: true }).filter({ visible: true }).waitFor();
    assert.equal((await saved(page, slugs[index])).ownerId, users[0].id);
  }
  assert.equal((await saved(pages[0], slugs[0])).lines[0].item.businessId, slugs[0]);
  assert.equal((await saved(pages[0], slugs[1])).lines[0].item.businessId, slugs[1]);
  console.log('PASS: both real restaurant apps share an origin with isolated guest/restarted/signed-in carts; delivery stays in memory');

  // Existing tabs share additions instead of overwriting each other's quantities.
  const other = await open(0, '/cart');
  await other.getByText('₹150.00 × 1 = ₹150.00', { exact: true }).filter({ visible: true }).waitFor();
  const plus = page => page.getByRole('button', { name: 'Add one Ammu meal', exact: true });
  await Promise.all([plus(pages[0]).click(), plus(other).click()]);
  await pages[0].getByText('₹150.00 × 3 = ₹450.00', { exact: true }).filter({ visible: true }).waitFor();
  await other.getByText('₹150.00 × 3 = ₹450.00', { exact: true }).filter({ visible: true }).waitFor();
  menus[0][0] = { ...menus[0][0], price_paise: 17500, name: 'Current Ammu meal' };
  await pages[0].reload({ waitUntil: 'networkidle' });
  await pages[0].getByText('₹175.00 × 3 = ₹525.00', { exact: true }).filter({ visible: true }).waitFor();
  await assertEventually(async () => (await saved(pages[0], slugs[0])).lines[0].item.name === 'Current Ammu meal');
  menus[0] = [];
  await pages[0].reload({ waitUntil: 'networkidle' });
  await pages[0].getByText('This dish is unavailable. Remove it before checkout.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await pages[0].getByRole('button', { name: 'Place order', exact: true }).isDisabled(), true);
  await pages[0].screenshot({ path: 'dist/browser/cart-unavailable-mobile.png', fullPage: true });
  await pages[0].getByRole('button', { name: 'Remove unavailable Current Ammu meal', exact: true }).click();
  await pages[0].getByText('Your cart is empty', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal((await saved(pages[0], slugs[1])).lines.length, 1);
  console.log('PASS: cross-tab additions serialize, fresh prices/names render, missing dishes require visible removal and block checkout');
  await other.close();

  // Logout must finish while the cart lock is held by another window.
  const kokani = pages[1];
  const holder = await open(1, '/cart');
  await holder.evaluate(key => {
    window.__held = false;
    void navigator.locks.request(key, async () => { window.__held = true; await new Promise(resolve => { window.__release = resolve; }); });
  }, `market:cart:${slugs[1]}`);
  await holder.waitForFunction(() => window.__held);
  await account(kokani); await kokani.getByRole('button', { name: 'Sign out', exact: true }).click();
  await kokani.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await cartLink(kokani).count(), 0);
  await holder.evaluate(() => window.__release());
  await assertEventually(async () => (await saved(kokani, slugs[1])).lines.length === 0);
  await holder.close();
  console.log('PASS: logout clears visible cart and completes without waiting for another window’s cart lock');

  menus = structuredClone(originalMenus);
  await kokani.goto(servers[0].url, { waitUntil: 'networkidle' }); await add(kokani); await login(kokani);
  await kokani.evaluate(() => { window.__failCartWrites = true; });
  await kokani.getByRole('button', { name: 'Sign out', exact: true }).click();
  await kokani.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await cartLink(kokani).count(), 0);
  // Sign in as B while cleanup still fails; A's persisted draft must stay hidden.
  await kokani.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(users[1].email);
  await kokani.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
  await kokani.getByRole('button', { name: 'Sign in', exact: true }).click();
  await kokani.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  assert.equal(await cartLink(kokani).count(), 0);
  await kokani.evaluate(() => { window.__failCartWrites = false; });
  await kokani.getByRole('button', { name: 'Retry saved cart', exact: true }).click();
  await assertEventually(async () => (await saved(kokani, slugs[1])).ownerId === users[1].id && (await saved(kokani, slugs[1])).lines.length === 0);
  console.log('PASS: failed cart cleanup does not block logout or expose A’s cart to guest/B; retry clears the old record');

  // A corrupt draft can be reset without removing or repricing an uncertain request.
  const uncertain = { version: 1, businessId: slugs[0], userId: users[0].id, idempotencyKey: '60000000-0000-4000-8000-000000000001', lines: [{ item: { id: itemIds[0], businessId: slugs[0], name: 'Original sent dish', description: '', category: 'Meals', pricePaise: 15000, isAvailable: true, isDemo: false }, quantity: 2 }], delivery: { name: 'Original sender', phone: '123', addressLine: 'Original address' }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: '2026-11-14T00:00:00Z' } };
  await pages[0].evaluate(({ draftKey, attemptKey, value }) => { localStorage.setItem(draftKey, '{corrupt'); localStorage.setItem(attemptKey, value); }, { draftKey: `market:cart:${slugs[0]}`, attemptKey: `market:checkout:${slugs[0]}`, value: JSON.stringify(uncertain) });
  await pages[0].reload({ waitUntil: 'networkidle' });
  await pages[0].getByRole('button', { name: 'Start new cart', exact: true }).click();
  await pages[0].getByRole('button', { name: 'Retry order recovery', exact: true }).waitFor();
  assert.equal(await pages[0].evaluate(key => localStorage.getItem(key), `market:checkout:${slugs[0]}`), JSON.stringify(uncertain));
  await pages[0].getByRole('button', { name: 'Retry order recovery', exact: true }).click();
  await assertEventually(() => recovered.length === 1);
  assert.deepEqual(recovered[0].p_items, [{ menu_item_id: itemIds[0], quantity: 2 }]);
  assert.equal(recovered[0].p_delivery.name, 'Original sender');
  assert.equal(recovered[0].p_idempotency_key, uncertain.idempotencyKey);
  assert.equal(await pages[0].evaluate(key => localStorage.getItem(key), `market:checkout:${slugs[0]}`), JSON.stringify(uncertain));
  console.log('PASS: corrupt draft reset and refreshed catalog leave uncertain request immutable; recovery resends original payload');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} finally {
  await context?.close(); await browser?.close();
  for (const server of servers) await server.close();
}
async function assertEventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
