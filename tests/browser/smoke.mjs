import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { serveWeb } from '../../scripts/serve-web.mjs';

const categoriesOnly = process.argv.includes('--categories');
// Ammu Sammu's photo grid (#39) adds category headings (level 2) around the dish headings (level 3); Kokani's a la carte list has category headings at level 3 and dishes at level 4.
const dishHeadingsFor = slug => ({ level: slug === 'ammu-sammu' ? 3 : 4 });
const trackingOnly = process.argv.includes('--tracking');
const selectedBrand = process.argv.find(arg => arg.startsWith('--brand='))?.slice(8);
if (!trackingOnly) {
let customerServer, adminServer, browser, context;
try {
customerServer = await serveWeb('apps/ammu-sammu-customer/dist/web');
adminServer = await serveWeb('apps/ammu-sammu-admin/dist/web');
await mkdir('dist/browser', { recursive: true });

const origin = 'https://market-fixture.supabase.co';
const businessId = '10000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000001';
const itemId = '20000000-0000-4000-8000-000000000001';
const orderId = '40000000-0000-4000-8000-000000000001';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'customer@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: new Date().toISOString() };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now()/1000)+3600 }) + '.' + Buffer.from('synthetic-fixture-signature').toString('base64url');
const session = { access_token: token, refresh_token: 'fixture-refresh', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, token_type: 'bearer', user };
const business = { contact_phone: '+919876543210', id: businessId, slug: 'ammu-sammu', name: 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
const item = { id: itemId, business_id: businessId, name: 'Fixture meal', description: 'Synthetic browser test item', category_id: '14300000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 15000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
let savedOrder;
if (categoriesOnly) savedOrder = { order_number: 'AMS-2026110001', id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, subtotal_paise: 15000, delivery_fee_paise: 2000, total_paise: 17000, customer_name: 'Synthetic', customer_phone: '123', delivery_address_line: 'Synthetic address', created_at: new Date().toISOString(), order_items: [], order_status_history: [] };
let failOrders = false;
let holdOrders = false, orderHeld = false, releaseOrders;
let heldOrderResponses = [];
let adminAllowed = false, failMembership = false;
let failSave = true, failDelete = true;
let menuItems = [item];
let failCatalog = false;
const mutations = [];
let externalRequests = [];
const externalSockets = [];
let permissionRequests = 0;
const requests = [];
browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
context = await browser.newContext({ viewport: { width: 390, height: 844 }, geolocation: { latitude: 17.719, longitude: 73.397, accuracy: 10 }, permissions: ['geolocation'], serviceWorkers: 'block' });
await context.routeWebSocket(/.*/, socket => {
  if (new URL(socket.url()).origin !== 'wss://market-fixture.supabase.co') { externalSockets.push(socket.url()); socket.close(); return; }
  socket.onMessage(message => {
  const data = JSON.parse(String(message));
  const array = Array.isArray(data);
  const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
  const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index+1 })) } };
  if (event === 'phx_join' || event === 'heartbeat' || event === 'phx_leave') socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
  });
});
await context.addInitScript(() => { if ('Notification' in window) Notification.requestPermission = () => { window.__permissionRequests = (window.__permissionRequests || 0) + 1; return Promise.resolve('denied'); }; });
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin === origin || url.hostname === '127.0.0.1') return route.fallback();
  externalRequests.push(url.href); return route.abort();
});
await context.route(origin + '/**', async route => {
  const req = route.request(), url = new URL(req.url());
  const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
  if (url.pathname === '/auth/v1/token') return json(session);
  if (url.pathname === '/auth/v1/user') return json(user);
  if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
  if (url.pathname === '/rest/v1/businesses') return json(business);
  if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
  if (url.pathname === '/rest/v1/menu_items') {
    if (req.method() === 'GET') return failCatalog ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture catalog failure' }) }) : json(menuItems);
    if (req.method() === 'POST') { if (failSave) { failSave = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture save failure' }) }); } const row = { ...req.postDataJSON(), menu_categories: { name: 'Meals', sort_order: 0 }, id: '20000000-0000-4000-8000-000000000002' }; mutations.push(row); menuItems.push(row); return json(row); }
    if (req.method() === 'PATCH') { const values = req.postDataJSON(); mutations.push(values); menuItems = menuItems.map(row => row.id.endsWith('002') ? { ...row, ...values } : row); return json(menuItems.find(row => row.id.endsWith('002'))); }
    if (req.method() === 'DELETE') { if (failDelete) { failDelete = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture delete failure' }) }); } menuItems = menuItems.filter(row => !row.id.endsWith('002')); return json({ id: '20000000-0000-4000-8000-000000000002' }); }
  }
  if (url.pathname === '/rest/v1/business_memberships') return failMembership ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture membership failure' }) }) : json(adminAllowed ? { role: 'admin', display_name: 'Suresh Pawar' } : null);
  if (url.pathname === '/rest/v1/rpc/daily_summary') return json({ date: '2026-11-13', collected_paise: 426000, delivered_count: 11, outstanding_paise: 221000, outstanding_count: 6, placed_count: 14, cancelled_count: 1, top_dishes: [{ name: 'Veg thali', quantity: 12 }] });
  if (url.pathname === '/rest/v1/rpc/list_addresses') return json([{ id: '48200000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Bharne Naka', landmark: null, latitude: 17.719, longitude: 73.397, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 }]);
  if (url.pathname === '/rest/v1/rpc/place_order') {
    const body = req.postDataJSON(); requests.push(body);
    if (!savedOrder) {
      savedOrder = { order_number: 'AMS-2026110001', id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, subtotal_paise: 15000, delivery_fee_paise: 2000, total_paise: 17000, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: body.p_delivery.address_line ?? 'Flat 3, Bharne Naka', created_at: new Date().toISOString(), order_items: [{ menu_item_id: itemId, name: item.name, quantity: 1, unit_price_paise: 15000, line_total_paise: 15000 }], order_status_history: [{ status: 'placed', created_at: new Date().toISOString() }] };
      return route.abort('failed'); // Server committed; response was lost.
    }
    return json({ outcome: 'placed', id: orderId });
  }
  if (url.pathname === '/rest/v1/rpc/transition_order') { const body = req.postDataJSON(); mutations.push(body); savedOrder = { ...savedOrder, status: body.p_status, version: savedOrder.version + 1 }; return json({ id: orderId }); }
  if (url.pathname === '/rest/v1/orders') { if (holdOrders) { orderHeld = true; await new Promise(resolve => { heldOrderResponses.push(resolve); releaseOrders = () => { const pending = heldOrderResponses; heldOrderResponses = []; pending.forEach(done => done()); }; }); } if (failOrders) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture order load failure' }) }); return json(url.searchParams.has('id') ? (savedOrder?.id === url.searchParams.get('id')?.slice(3) ? savedOrder : null) : savedOrder ? [savedOrder] : []); }
  throw new Error('Unhandled fixture request: ' + req.method() + ' ' + url.pathname);
});
const errors = [];
const open = async () => { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(customerServer.url, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: /^(?:Add to cart|Add one )/ }).first().waitFor(); return page; };
const focused = (page, text) => page.waitForFunction(expected => [document.activeElement?.textContent, document.activeElement?.getAttribute('aria-label')].includes(expected), text);
const account = async page => { await page.getByRole('button', { name: 'Account', exact: true }).click(); const settings = page.getByRole('button', { name: 'Account settings', exact: true }); if (await settings.count()) await settings.click();  };
const signIn = async page => { await page.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor(); };
const prepareCart = async (page, add = true) => {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Browse menu', exact: true }).click();
  if (add) await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByRole('button', { name: /^Cart \(/ }).click();
  await page.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Test Customer');
  await page.getByLabel('Mobile number', { exact: true }).filter({ visible: true }).fill('9876543210');
  await page.getByText('Deliver to Home', { exact: true }).filter({ visible: true }).waitFor();
};
  if (!categoriesOnly) {
  const first = await open();
  await first.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await first.getByRole('button', { name: /^Cart \(/ }).click();
  await first.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Guest draft');
  await first.getByRole('button', { name: 'Place order', exact: true }).click();
  await first.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email);
  await first.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
  await first.getByRole('button', { name: 'Sign in', exact: true }).click();
  await first.getByLabel('Name', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(new URL(first.url()).pathname, '/cart');
  assert.equal(await first.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), 'Guest draft');
  await first.getByRole('button', { name: 'Remove one Fixture meal', exact: true }).click();
  await account(first);
  console.log('PASS: guest checkout returns to cart after login with form draft retained');
  await first.getByRole('button', { name: 'Turn analytics on', exact: true }).waitFor();
  await first.getByRole('button', { name: 'Turn notifications on', exact: true }).waitFor();
  assert.deepEqual(externalRequests, []);
  assert.equal(await first.evaluate(() => window.__permissionRequests || 0), 0);
  await first.getByRole('button', { name: 'Turn notifications on', exact: true }).click();
  await first.getByText('Notifications are not available yet.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await first.evaluate(() => window.__permissionRequests || 0), 0);
  await first.getByRole('button', { name: 'Sign out', exact: true }).click();
  await first.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await first.getByLabel('Password', { exact: true }).filter({ visible: true }).inputValue(), '');
  assert.equal(await first.getByLabel('Email', { exact: true }).filter({ visible: true }).inputValue(), '');
  console.log('PASS: sign-in/sign-out clears credentials in mounted account panel');
  await signIn(first); await prepareCart(first);
  const second = await open(); await prepareCart(second, false);
  await first.getByRole('button', { name: 'Place order', exact: true }).click();
  await first.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
  await second.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Place order', exact: true }).isDisabled(), true);
  failCatalog = true;
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByText(/Fixture catalog failure/).filter({ visible: true }).waitFor();
  await second.getByRole('button', { name: 'Retry order recovery', exact: true }).click();
  await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  failCatalog = false;
  await second.getByRole('button', { name: 'Retry loading', exact: true }).click();
  await second.getByText('₹170 cash on delivery', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await second.getByText('₹170 cash on delivery', { exact: true }).filter({ visible: true }).count(), 1);
  await second.screenshot({ path: 'dist/browser/customer-confirmed-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: cross-tab lost-response recovery reuses exact key/payload, survives catalog failure and confirms one server order');

  // A real receipt remains placed, but a newer successful detail must not regress
  // to that receipt while a subsequent server refresh is delayed.
  savedOrder = { ...savedOrder, version: savedOrder.version + 1, status: 'accepted' };
  await second.getByRole('button', { name: 'Refresh orders', exact: true }).click();
  await second.getByText('The restaurant accepted your order', { exact: true }).filter({ visible: true }).waitFor();
  holdOrders = true; orderHeld = false;
  await second.getByRole('button', { name: 'Refresh orders', exact: true }).click();
  for (let i = 0; i < 50 && !orderHeld; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(orderHeld, true);
  assert.equal(await second.getByText('The restaurant accepted your order', { exact: true }).filter({ visible: true }).count(), 1);
  assert.equal(await second.getByText('Your order is with the restaurant', { exact: true }).filter({ visible: true }).count(), 0);
  holdOrders = false; releaseOrders();
  await second.getByText('Refreshing order…', { exact: true }).filter({ visible: true }).waitFor({ state: 'hidden' });
  // Restore the shared fixture for later independent owner transition assertions.
  savedOrder = { ...savedOrder, version: 1, status: 'placed' };
  console.log('PASS: refreshing a newer successful detail never falls back to its original placed receipt');

  // Real paths survive reload and back; missing orders are distinct from loading.
  assert.equal(new URL(second.url()).pathname, '/orders/' + orderId);
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).waitFor();
  failOrders = true;
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByText('Could not load your orders', { exact: true }).filter({ visible: true }).waitFor();
  failOrders = false;
  await second.getByRole('button', { name: 'Retry orders', exact: true }).click();
  await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).waitFor();
  await second.goto(customerServer.url + '/orders/90000000-0000-4000-8000-000000000009', { waitUntil: 'networkidle' });
  await second.getByText("We can't show this order", { exact: true }).filter({ visible: true }).waitFor();
  // Drawer traps keyboard focus, dismisses with Escape and restores its opener.
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await focused(second, 'Your account');
  await second.waitForTimeout(250);
  await second.screenshot({ path: 'dist/browser/customer-drawer-mobile.png', fullPage: true });
  await second.keyboard.press('Shift+Tab'); await focused(second, 'Browse menu');
  await second.keyboard.press('Tab'); await focused(second, '×');
  await second.keyboard.press('Escape'); await focused(second, 'Account');
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await second.getByRole('button', { name: 'Browse menu', exact: true }).click();
  await second.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await second.getByRole('button', { name: /^Cart \(/ }).click();
  await second.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Draft stays');
  await second.goBack();
  await second.getByRole('button', { name: /^Cart \(/ }).click();
  assert.equal(await second.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), 'Draft stays');
  const acceptedTap = await second.evaluate(async id => {
    const channel = new MessageChannel();
    const accepted = new Promise(resolve => { channel.port1.onmessage = event => { resolve(event.data?.accepted); channel.port1.close(); }; });
    const event = new MessageEvent('message', { data: { type: 'market:notification-tap', path: `/orders/${id}` }, ports: [channel.port2] });
    Object.defineProperty(event, 'source', { value: { scriptURL: location.origin + '/firebase-messaging-worker.js' } });
    navigator.serviceWorker.dispatchEvent(event);
    return accepted;
  }, orderId);
  assert.equal(acceptedTap, true);
  await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).waitFor();
  await second.goBack();
  assert.equal(new URL(second.url()).pathname, '/cart');
  assert.equal(await second.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), 'Draft stays');
  assert.equal(await second.getByRole('button', { name: /^Cart \(/ }).count(), 0, 'the cart page has no separate View cart bar');
  const asset = await context.request.get(customerServer.url + '/orders/missing.js'); assert.equal(asset.status(), 404);
  const worker = await context.request.get(customerServer.url + '/firebase-messaging-worker.js'); assert.match(worker.headers()['content-type'], /javascript/);
  // A signed-out deep link returns to its exact order after authenticating.
  holdOrders = true;
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await second.getByRole('button', { name: 'Your orders', exact: true }).click();
  await second.getByRole('dialog').waitFor({ state: 'hidden' });
  await second.getByRole('button', { name: 'Refresh orders', exact: true }).click();
  for (let i = 0; i < 50 && !orderHeld; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(orderHeld, true);
  await account(second); await second.getByRole('button', { name: 'Sign out', exact: true }).click();
  await second.getByLabel('Email', { exact: true }).filter({ visible: true }).waitFor();
  holdOrders = false; releaseOrders();
  await second.waitForTimeout(100);
  assert.equal(await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).count(), 0);
  await second.goto(customerServer.url + '/orders/' + orderId, { waitUntil: 'networkidle' });
  await second.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email);
  await second.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
  await second.getByRole('button', { name: 'Sign in', exact: true }).click();
  await second.getByText('Order AMS-2026110001', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(new URL(second.url()).pathname, '/orders/' + orderId);
  await second.setViewportSize({ width: 1440, height: 900 });
  await second.screenshot({ path: 'dist/browser/customer-order-desktop.png', fullPage: true });
  console.log('PASS: deep-link reload/login return, missing-order state, browser back with draft retention, drawer keyboard focus and asset exclusions');

  const admin = await context.newPage(); admin.on('pageerror', error => errors.push(error.message));
  await admin.goto(adminServer.url, { waitUntil: 'networkidle' });
  await signIn(admin);
  await admin.getByText('Access denied', { exact: true }).filter({ visible: true }).waitFor();
  // Owner tabs exist only after the server confirms membership; sign out stays available meanwhile.
  const ownerTabs = admin.getByRole('navigation', { name: 'Owner sections' });
  const ownerTab = name => ownerTabs.getByRole('button', { name: new RegExp(`^${name}(,|$)`) }); // the Orders name gains ", N new"
  assert.equal(await ownerTabs.count(), 0, 'access denied shows no owner tabs');
  await admin.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  failMembership = true;
  await admin.reload({ waitUntil: 'networkidle' });
  await admin.getByText('Could not check access', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await ownerTabs.count(), 0, 'an access check error shows no owner tabs');
  failMembership = false; adminAllowed = true;
  await admin.getByRole('button', { name: 'Retry', exact: true }).click();
  await ownerTabs.waitFor();
  assert.deepEqual((await ownerTabs.getByRole('button').allTextContents()).map(text => text.replace(/^\d+|\d+$/g, '')), ['Orders', 'Menu', 'Today', 'Settings']);
  assert.equal(await ownerTab('Orders').getAttribute('aria-current'), 'page');
  await admin.getByRole('heading', { name: 'Orders', exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Accept order AMS-2026110001', exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Details for AMS-2026110001', exact: true }).click();
  await focused(admin, 'Order AMS-2026110001');
  await admin.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await focused(admin, 'Cancel order AMS-2026110001?');
  { // #53 p6: the full order number stays on one line in the cancel title
    const lines = await admin.getByText('AMS-2026110001?', { exact: true }).filter({ visible: true }).evaluate(el => el.getClientRects().length);
    assert.equal(lines, 1, 'cancel title keeps the order number unbroken');
  }
  await admin.getByRole('button', { name: 'Keep the order', exact: true }).click();
  await focused(admin, 'Cancel order');
  assert.equal(mutations.length, 0);
  await admin.getByRole('button', { name: 'Accept order', exact: true }).click();
  await admin.getByText('Order AMS-2026110001 updated to Accepted.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[0].p_status, 'accepted');
  await admin.getByRole('button', { name: 'Start preparing', exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await admin.getByRole('button', { name: 'Cancel the order', exact: true }).click();
  await admin.getByText('Order AMS-2026110001 updated to Cancelled.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[1].p_status, 'cancelled');
  assert.equal(await admin.getByRole('button', { name: 'Cancel order', exact: true }).count(), 0, 'cancelled orders have no actions');
  await admin.getByRole('button', { name: 'Back', exact: true }).click();
  await admin.getByRole('button', { name: 'Menu', exact: true }).click();
  await admin.getByRole('button', { name: 'Add dish', exact: true }).click();
  const addDialog = admin.getByRole('dialog');
  await addDialog.getByLabel('Dish name', { exact: true }).fill('Test dish');
  await addDialog.getByLabel('Price in rupees', { exact: true }).fill('123.45');
  await admin.getByRole('button', { name: 'Save dish', exact: true }).click();
  await admin.getByText('Choose a diet classification.', { exact: true }).waitFor();
  await addDialog.getByRole('button', { name: 'Contains egg', exact: true }).click();
  await admin.getByRole('button', { name: 'Save dish', exact: true }).click();
  await addDialog.getByRole('alert').getByText(/Fixture save failure/).waitFor();
  assert.equal(await addDialog.getByLabel('Dish name', { exact: true }).inputValue(), 'Test dish');
  assert.equal(await addDialog.getByRole('button', { name: 'Category: Meals', exact: true }).count(), 1, 'the only category is preselected');
  assert.equal(await addDialog.getByLabel('Price in rupees', { exact: true }).inputValue(), '123.45');
  await admin.getByRole('button', { name: 'Save dish', exact: true }).click();
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).waitFor();
  assert.equal(mutations[2].price_paise, 12345);
  assert.equal(mutations[2].diet, 'egg');
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).click();
  await focused(admin, 'Edit dish');
  assert.equal(await admin.getByRole('dialog').getByRole('alert').count(), 0);
  await admin.getByRole('button', { name: 'Close', exact: true }).click();
  await focused(admin, 'Edit Test dish');
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).click();
  await admin.getByLabel('Price in rupees', { exact: true }).fill('125.67');
  await admin.getByRole('button', { name: 'Save changes', exact: true }).click();
  await admin.getByText('₹125.67', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[3].price_paise, 12567);
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).click();
  await admin.getByRole('button', { name: 'Delete this dish', exact: true }).click();
  await focused(admin, 'Delete Test dish?');
  await admin.getByRole('button', { name: 'Keep dish', exact: true }).click();
  await focused(admin, 'Delete this dish');
  await admin.getByRole('button', { name: 'Delete this dish', exact: true }).click();
  await admin.getByRole('button', { name: 'Delete dish', exact: true }).click();
  await admin.getByRole('dialog').getByRole('alert').getByText(/Fixture delete failure/).waitFor();
  await admin.getByRole('button', { name: 'Keep dish', exact: true }).click();
  await admin.getByRole('button', { name: 'Delete this dish', exact: true }).click();
  assert.equal(await admin.getByRole('dialog').getByRole('alert').count(), 0);
  await admin.getByRole('button', { name: 'Delete dish', exact: true }).click();
  await admin.getByText('Test dish deleted.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(menuItems.length, 1);
  assert.equal(await ownerTab('Menu').getAttribute('aria-current'), 'page');
  await ownerTab('Today').click();
  await admin.getByText('Still to collect now', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await admin.getByText("Today's summary is coming soon").count(), 0, 'the placeholder is gone');
  assert.equal(await ownerTab('Today').getAttribute('aria-current'), 'page');
  assert.equal(await ownerTab('Menu').getAttribute('aria-current'), null);
  assert.equal(await admin.getByRole('button', { name: 'Details for AMS-2026110001' }).count(), 0, 'order cards are only on the Orders tab');
  await ownerTab('Settings').click();
  await admin.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  // Owners' Settings follows p. 10: owner card from the membership name, alert and privacy switches, Log out.
  await admin.getByRole('heading', { name: 'Suresh Pawar', exact: true }).waitFor();
  await admin.getByText(`${user.email} · Owner`, { exact: true }).filter({ visible: true }).waitFor();
  for (const heading of ['Restaurant', 'New order alerts on this phone', 'Privacy']) await admin.getByRole('heading', { name: heading, exact: true }).waitFor();
  const notifications = admin.getByRole('switch', { name: 'Notifications', exact: true });
  await notifications.waitFor(); assert.equal(await notifications.isChecked(), false);
  assert.equal(await admin.getByRole('switch', { name: 'Share app usage', exact: true }).isChecked(), false);
  // One key press is one toggle on a switch that stays enabled while it saves (Enter comes from
  // react-native-web's press handling, Space from MarketSwitch), so a double toggle would show here.
  const usage = admin.getByRole('switch', { name: 'Share app usage', exact: true });
  await usage.focus(); await admin.keyboard.press('Enter');
  await admin.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Share app usage"]')?.getAttribute('aria-checked') === 'true');
  await admin.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Share app usage"]')?.getAttribute('aria-busy') !== 'true');
  assert.equal(await usage.isChecked(), true, 'Enter toggles once');
  await admin.keyboard.press('Space');
  await admin.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Share app usage"]')?.getAttribute('aria-checked') === 'false');
  await admin.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Share app usage"]')?.getAttribute('aria-busy') !== 'true');
  assert.equal(await usage.isChecked(), false, 'Space toggles once');
  await admin.getByText('Phone numbers, delivery fee, minimum order', { exact: true }).filter({ visible: true }).waitFor();
  await admin.getByText('Who can manage Ammu Sammu', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await admin.getByText('Coming soon', { exact: true }).filter({ visible: true }).count(), 3, 'owners, ring and test alert are announced');
  assert.equal(await admin.getByRole('button', { name: /Owners|Ring|test alert|Coming soon/ }).count(), 0, 'placeholders are not interactive');
  assert.equal(await admin.getByRole('button', { name: 'Restaurant details', exact: true }).filter({ visible: true }).count(), 1, 'Restaurant details (#60) opens its screen');
  assert.equal(await admin.getByRole('button', { name: /Turn (analytics|notifications)/ }).count(), 0, 'the old preference buttons are gone');
  await ownerTab('Orders').click();
  await admin.getByRole('button', { name: 'Done', exact: true }).waitFor();
  await ownerTab('Settings').click();
  await admin.getByRole('button', { name: 'Log out', exact: true }).click();
  await admin.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await ownerTabs.count(), 0, 'signing out removes owner tabs');
  await admin.getByText("This app is for Ammu Sammu's owners. Customers order from the Ammu Sammu app.", { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await admin.getByLabel('Password', { exact: true }).filter({ visible: true }).inputValue(), '');
  console.log('PASS: owner tabs appear only after server access; denied/error states hide them; tab switching and sign-out');
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(externalSockets, []);
  permissionRequests += await first.evaluate(() => window.__permissionRequests || 0);
  permissionRequests += await admin.evaluate(() => window.__permissionRequests || 0);
  assert.equal(permissionRequests, 0);
  console.log('PASS: admin membership, order transition, cancellation and menu CRUD');

  }
  // The real exports for each brand render the same accessible shapes everywhere.
  for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
    if (selectedBrand && slug !== selectedBrand) continue;
    const customer = await serveWeb(`apps/${slug}-customer/dist/web`);
    const owner = await serveWeb(`apps/${slug}-admin/dist/web`);
    const dietContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    try {
      const dietErrors = [], dietWrites = [];
      const otherUser = { ...user, id: '30000000-0000-4000-8000-000000000043', email: 'other-diet-account@example.test' };
      let activeUser = user;
      const sessionFor = selected => {
        const jwt = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ sub: selected.id, aud: 'authenticated', role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now()/1000)+3600 }) + '.fixture';
        return { ...session, user: selected, access_token: jwt };
      };
      const labels = ['Vegetarian', 'Contains egg', 'Non-vegetarian'];
      let dishes = ['veg', 'egg', 'non_veg', null].map((diet, index) => ({ ...item, id: `20000000-0000-4000-8000-00000000004${index}`, name: `Diet fixture ${index + 1}`, diet }));
      let groups = [{ id: item.category_id, name: 'Meals', sort_order: 0 }];
      let failCategorySave = true, categoryDeleteRace = true;
      const categoryWrites = [], reorderCalls = [];
      let categoryReloadGate = null, failCategoryReload = false;
      const joined = dish => ({ ...dish, menu_categories: groups.find(group => group.id === dish.category_id) });
      const historical = { ...savedOrder, order_number: `${slug === 'ammu-sammu' ? 'AMS' : 'KDI'}-2026110001`, status: 'placed', business_id: businessId, order_items: dishes.map(dish => ({ menu_item_id: dish.id, name: dish.name, diet: dish.diet, quantity: 1, unit_price_paise: dish.price_paise, line_total_paise: dish.price_paise })) };
      await dietContext.addInitScript(({ slug, session }) => {
        if (localStorage.getItem('diet-fixture-initialized')) return;
        localStorage.setItem('diet-fixture-initialized', 'yes');
        for (const audience of ['customer', 'admin']) localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:${audience}`, JSON.stringify(session));
      }, { slug, session });
      await dietContext.routeWebSocket(/.*/, socket => {
        if (new URL(socket.url()).origin !== 'wss://market-fixture.supabase.co') throw new Error('Unexpected diet fixture socket: ' + socket.url());
        socket.onMessage(message => {
          const data = JSON.parse(String(message)), array = Array.isArray(data);
          const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
          const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index + 1 })) } };
          if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
        });
      });
      await dietContext.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname === '127.0.0.1') return route.fallback();
        if (url.origin !== origin) throw new Error('Unexpected diet fixture external request: ' + url.href);
        const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/auth/v1/user') return json(activeUser);
        if (url.pathname === '/auth/v1/token') { activeUser = request.postDataJSON().email === otherUser.email ? otherUser : user; return json(sessionFor(activeUser)); }
        if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
        if (url.pathname === '/rest/v1/businesses') return json({ ...business, slug, name: slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn', accepting_orders: true });
        if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
        if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? (historical.id === url.searchParams.get('id')?.slice(3) ? historical : null) : historical.customer_id === activeUser.id ? [historical] : []);
        if (url.pathname === '/rest/v1/menu_categories') {
          const method = request.method(), id = url.searchParams.get('id')?.replace('eq.', '');
          if (method === 'GET') {
            if (categoryReloadGate) { const gate = categoryReloadGate; categoryReloadGate = null; gate.requested(); await gate.wait; }
            if (failCategoryReload) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Category reload failed' }) });
            return json([...groups].sort((a,b) => a.sort_order-b.sort_order || a.name.localeCompare(b.name)));
          }
          assert.equal(url.searchParams.get('business_id'), method === 'POST' ? null : `eq.${businessId}`);
          const values = method === 'DELETE' ? {} : request.postDataJSON();
          categoryWrites.push({ method, values, id });
          const fail = (code, message, status = 409) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ code, message }) });
          if (method === 'DELETE') {
            if (categoryDeleteRace || dishes.some(dish => dish.category_id === id)) { categoryDeleteRace = false; return fail('23503', 'In use'); }
            groups = groups.filter(group => group.id !== id); return json({ id });
          }
          if (failCategorySave) { failCategorySave = false; return fail('SYNTHETIC', 'Category save failed. Retry.', 500); }
          if (groups.some(group => group.id !== id && group.name === values.name)) return fail('23505', 'Duplicate name');
          const row = { ...values, id: id ?? `14300000-0000-4000-8000-00000000000${groups.length + 1}` };
          groups = method === 'POST' ? [...groups,row] : groups.map(group => group.id === id ? row : group);
          return json(row);
        }
        if (url.pathname === '/rest/v1/rpc/reorder_menu_items' || url.pathname === '/rest/v1/rpc/reorder_menu_categories') {
          const body = request.postDataJSON(); reorderCalls.push(body);
          if (body.p_item_ids) dishes = dishes.map(dish => body.p_item_ids.includes(dish.id) ? { ...dish, sort_order: body.p_item_ids.indexOf(dish.id) } : dish);
          else groups = groups.map(group => ({ ...group, sort_order: body.p_category_ids.indexOf(group.id) }));
          return json((body.p_item_ids ?? body.p_category_ids).length);
        }
        if (url.pathname === '/rest/v1/menu_items') {
          if (request.method() === 'GET') return json(dishes.map(joined));
          const values = request.postDataJSON(); dietWrites.push(values);
          const id = url.searchParams.get('id')?.replace('eq.', '');
          dishes = dishes.map(dish => dish.id === id ? { ...dish, ...values } : dish);
          return json(joined(dishes.find(dish => dish.id === id)));
        }
        if (url.pathname === '/rest/v1/rpc/list_addresses') return json([]); // signed-in carts read saved addresses (#48)
        throw new Error('Unhandled diet fixture: ' + request.method() + ' ' + url.pathname);
      });
      const page = await dietContext.newPage(); page.on('pageerror', error => dietErrors.push(error.message));
      const adminPage = await dietContext.newPage(); adminPage.on('pageerror', error => dietErrors.push(error.message));
      const dialog = adminPage.getByRole('dialog');
      const marks = page => page.getByRole('img', { name: /^(Vegetarian|Contains egg|Non-vegetarian)$/ });
      const assertMarks = async page => {
        for (const label of labels) assert.equal(await page.getByRole('img', { name: label, exact: true }).count(), 1);
        assert.equal(await marks(page).count(), 3, 'the unclassified fourth dish has no mark');
      };
      if (!categoriesOnly) {
      await page.goto(customer.url, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Add to cart', exact: true }).first().waitFor();
      await assertMarks(page);
      const shapes = await marks(page).evaluateAll(nodes => nodes.map(node => {
        const square = getComputedStyle(node.firstElementChild), shape = getComputedStyle(node.firstElementChild.firstElementChild);
        return { squareWidth: square.width, squareHeight: square.height, border: square.borderTopStyle, width: shape.width, height: shape.height, radius: shape.borderRadius, triangle: shape.borderBottomWidth, left: shape.borderLeftColor };
      }));
      for (const shape of shapes) { assert.equal(shape.squareWidth, shape.squareHeight); assert.equal(shape.border, 'solid'); }
      assert.equal(shapes[0].width, shapes[0].height, 'veg is a circle');
      assert.notEqual(shapes[1].width, shapes[1].height, 'egg is an oval');
      const compact = true; // the photo-grid cards and a la carte rows (#39) use the shape-only mark
      assert.equal(shapes[2].width, compact ? '8px' : '12px', 'triangle width is the two transparent side borders'); assert.equal(shapes[2].triangle, compact ? '8px' : '11px'); assert.equal(shapes[2].left, 'rgba(0, 0, 0, 0)', 'non-veg is a triangle');
      await page.setViewportSize({ width: 390, height: 2400 });
      await page.screenshot({ path: `dist/browser/${slug}-diet-menu-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      // Cards and rows (#39) swap their Add button for a stepper once added, so the next Add is always the first.
      for (let index = 0; index < dishes.length; index++) await page.getByRole('button', { name: 'Add to cart', exact: true }).nth(0).click();
      await page.getByRole('button', { name: /^Cart \(/ }).click();
      await page.getByRole('heading', { name: 'Your cart', exact: true }).waitFor(); await assertMarks(page);
      await page.reload({ waitUntil: 'networkidle' }); await assertMarks(page);
      await page.setViewportSize({ width: 390, height: 2400 });
      await page.screenshot({ path: `dist/browser/${slug}-diet-checkout-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      // Catalog changes affect the draft, but past orders use the stored diet.
      dishes[0] = { ...dishes[0], diet: 'egg' };
      await page.goto(customer.url + '/orders', { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: 'Your orders', exact: true }).waitFor(); await assertMarks(page);
      await page.screenshot({ path: `dist/browser/${slug}-diet-history-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: `dist/browser/${slug}-diet-history-desktop.png`, fullPage: true });
      // An uncertain attempt displays its own immutable dish classification.
      const attempt = { pricing: { lines: [{ menu_item_id: itemId, quantity: 2, unit_price_paise: 15123, line_total_paise: 30246 }], delivery_fee_paise: 2000, min_order_paise: 0, subtotal_paise: 30246, total_paise: 32246 }, version: 2, businessId: slug, userId, idempotencyKey: '63000000-0000-4000-8000-000000000043', lines: [{ item: { id: itemId, businessId: slug, name: `${slug} private pending dish`, description: '', category: 'Meals', categoryId: '14300000-0000-4000-8000-000000000001', categorySortOrder: 0, pricePaise: 15123, isAvailable: true, isDemo: false, diet: 'veg' }, quantity: 2 }], delivery: { name: 'Synthetic', phone: '123' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 1 }, location: { latitude: 0.5, longitude: 0.5, accuracy: 10, capturedAtISO: '2026-11-14T00:00:00Z' } };
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: `market:checkout:${slug}`, value: JSON.stringify(attempt) });
      await page.goto(customer.url + '/cart', { waitUntil: 'networkidle' });
      await page.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
      const privateLine = `2 × ${slug} private pending dish · ₹302.46`;
      await page.getByText(privateLine, { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await page.getByRole('img', { name: 'Vegetarian', exact: true }).count(), 1, 'only frozen attempt retains the old mark');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), JSON.stringify(attempt));
      await adminPage.goto(owner.url, { waitUntil: 'networkidle' });
      // Each owners' app shows only its own logo and fonts, with a bottom tab bar at phone and desktop widths.
      const brands = { 'ammu-sammu': { name: 'Ammu Sammu', heading: 'Eczar_600SemiBold' }, 'kokani-dine-inn': { name: 'Kokani Dine Inn', heading: 'TiroDevanagariMarathi_400Regular' } };
      const brand = brands[slug], other = Object.values(brands).find(value => value !== brand);
      const sections = adminPage.getByRole('navigation', { name: 'Owner sections' });
      await sections.waitFor();
      assert.equal(await adminPage.getByRole('img', { name: brand.name, exact: true }).count(), 1);
      assert.equal(await adminPage.getByRole('img', { name: other.name }).count(), 0);
      const title = adminPage.getByRole('heading', { name: 'Orders', exact: true });
      await adminPage.waitForFunction(family => [...document.querySelectorAll('[role=heading]')].some(node => getComputedStyle(node).fontFamily.includes(family)), brand.heading);
      const families = await adminPage.evaluate(() => [...document.fonts].map(font => font.family.replace(/"/g, '')));
      assert.ok(families.includes(brand.heading));
      assert.equal(families.includes(other.heading), false, 'the other restaurant fonts are never loaded');
      assert.match(await title.evaluate(node => getComputedStyle(node).fontFamily), new RegExp(brand.heading));
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        await adminPage.setViewportSize({ width, height });
        const bar = await sections.boundingBox();
        assert.ok(Math.abs(bar.y + bar.height - height) <= 1, 'tab bar is fixed to the bottom');
        assert.ok(bar.width <= 600 && Math.abs(bar.x + bar.width / 2 - width / 2) <= 1, 'tab bar is centred');
        for (const box of await sections.getByRole('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))) assert.ok(box.width >= 48 && box.height >= 48, 'tab targets are at least 48px');
        await adminPage.screenshot({ path: `dist/browser/${slug}-owner-tabs-${width}.png` });
      }
      await adminPage.setViewportSize({ width: 390, height: 844 });
      console.log(`PASS: ${slug} owner shell brand logo/fonts isolation and responsive bottom tabs`);
      await adminPage.getByRole('button', { name: `Details for ${historical.order_number}`, exact: true }).click();
      await assertMarks(adminPage);
      await adminPage.getByRole('button', { name: 'Back', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Menu', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Edit Diet fixture 4', exact: true }).click();
      await dialog.getByText('Not classified yet. No diet mark is shown to customers.', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Non-vegetarian', exact: true }).focus(); await adminPage.keyboard.press('Enter');
      assert.equal(await dialog.getByRole('button', { name: 'Non-vegetarian', exact: true }).getAttribute('aria-pressed'), 'true');
      await adminPage.setViewportSize({ width: 390, height: 1400 });
      await adminPage.screenshot({ path: `dist/browser/${slug}-diet-owner-mobile.png`, fullPage: true });
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
      await adminPage.getByText('Dish saved.', { exact: true }).waitFor();
      assert.equal(dietWrites.at(-1).diet, 'non_veg');
      await adminPage.setViewportSize({ width: 1440, height: 900 });
      await adminPage.screenshot({ path: `dist/browser/${slug}-diet-owner-desktop.png`, fullPage: true });
      // The business-keyed recovery blocker survives logout; its private detail
      // is visible only to the account that submitted the immutable attempt.
      const savedAttempt = JSON.stringify(attempt);
      const assertPrivateHidden = async () => {
        assert.equal(await page.getByText(privateLine, { exact: true }).filter({ visible: true }).count(), 0);
        assert.equal(await page.getByText(`${slug} private pending dish`, { exact: false }).filter({ visible: true }).count(), 0);
        assert.equal(await page.getByRole('img', { name: 'Vegetarian', exact: true }).count(), 0);
        await page.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
        assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), savedAttempt);
      };
      // Cold guest restore has no auth record, while the old attempt remains.
      await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('market:https')) localStorage.removeItem(key); });
      await page.goto(customer.url + '/account', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await assertPrivateHidden();
      await page.goto(customer.url, { waitUntil: 'networkidle' });
      assert.ok(await page.getByRole('img', { name: 'Contains egg', exact: true }).count() > 0, 'public menu marks stay visible to guests');
      await assertPrivateHidden();
      await page.goto(customer.url + '/account', { waitUntil: 'networkidle' });
      await signIn(page);
      await page.getByText(privateLine, { exact: true }).filter({ visible: true }).waitFor();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await assertPrivateHidden();
      await page.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(otherUser.email);
      await page.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      await assertPrivateHidden();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      await signIn(page);
      await page.getByText(privateLine, { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await page.getByRole('img', { name: 'Vegetarian', exact: true }).count(), 1);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), savedAttempt);
      console.log(`PASS: ${slug} cold guest/logout/B cannot see pending order details; matching A restores unchanged name, quantity, amount and mark`);
      // Owner merchandising persists, sorts deterministically and appears publicly only while available.
      const featureLabel = slug === 'ammu-sammu' ? "Today's special" : 'Signature dish';
      const featureHeading = slug === 'ammu-sammu' ? "Today's special" : 'Signature dishes';
      // Ordering is by Move up/down (#102): put Diet fixture 4 first in Meals.
      await adminPage.getByRole('button', { name: 'Reorder Diet fixture 4', exact: true }).click();
      for (const position of [3, 2, 1]) {
        await adminPage.getByRole('button', { name: 'Move Diet fixture 4 up', exact: true }).click();
        await adminPage.getByText(`Diet fixture 4 moved to position ${position} of 4 in Meals.`, { exact: true }).waitFor();
      }
      assert.deepEqual(reorderCalls.at(-1).p_item_ids, ['20000000-0000-4000-8000-000000000043', '20000000-0000-4000-8000-000000000040', '20000000-0000-4000-8000-000000000041', '20000000-0000-4000-8000-000000000042']);
      await adminPage.getByRole('button', { name: 'Edit Diet fixture 4', exact: true }).click();
      await dialog.getByRole('switch', { name: featureLabel, exact: true }).click();
      await adminPage.setViewportSize({ width: 390, height: 1500 });
      await adminPage.screenshot({ path: `dist/browser/${slug}-featured-owner-mobile.png`, fullPage: true });
      await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
      await adminPage.getByText('Dish saved.', { exact: true }).waitFor();
      assert.equal(dietWrites.at(-1).is_featured, true); assert.equal(dietWrites.at(-1).sort_order, 0, 'an edit keeps the moved position');
      await adminPage.reload({ waitUntil: 'networkidle' });
      await adminPage.getByRole('button', { name: 'Menu', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Edit Diet fixture 4', exact: true }).click();
      assert.equal(await dialog.getByRole('switch', { name: featureLabel, exact: true }).isChecked(), true);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      // Deliberately return unsorted rows: the public UI establishes its own stable order.
      dishes[0] = { ...dishes[0], is_featured: true, available: false, sort_order: -10 };
      await page.evaluate(key => localStorage.removeItem(key), `market:checkout:${slug}`);
      await page.goto(customer.url, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: featureHeading, exact: true }).waitFor();
      const featured = page.locator('#featured-menu');
      assert.equal(await featured.getByRole('heading', { name: 'Diet fixture 4', exact: true }).count(), 1);
      assert.equal(await featured.getByRole('heading', { name: 'Diet fixture 1', exact: true }).count(), 0);
      const grid = page.locator('#regular-menu');
      assert.deepEqual(await grid.getByRole('heading', dishHeadingsFor(slug)).allTextContents(), ['Diet fixture 1', 'Diet fixture 4', 'Diet fixture 2', 'Diet fixture 3']);
      const cartButton = page.getByRole('button', { name: /^Cart \(/ });
      const beforeCount = await cartButton.count() ? Number((await cartButton.textContent()).match(/\d+/)[0]) : 0;
      await featured.getByRole('button', { name: 'Add to cart', exact: true }).click();
      await page.getByRole('button', { name: `Cart (${beforeCount + 1}) · View cart`, exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 2400 });
      await page.screenshot({ path: `dist/browser/${slug}-featured-menu-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: `dist/browser/${slug}-featured-menu-desktop.png`, fullPage: true });
      dishes[1] = { ...dishes[1], name: 'Same name', description: 'Tie first' };
      dishes[2] = { ...dishes[2], name: 'Same name', description: 'Tie second' };
      dishes.reverse();
      await page.reload({ waitUntil: 'networkidle' });
      // Photo-grid cards (Ammu Sammu, #39) omit the description; the tie order itself is covered by the sortMenuItems unit test.
      if (slug !== 'ammu-sammu') assert.deepEqual(await page.locator('#regular-menu').getByText(/^Tie /).allTextContents(), ['Tie first', 'Tie second']);
      assert.equal(await page.locator('#regular-menu').getByRole('heading', { name: 'Same name', level: slug === 'ammu-sammu' ? 3 : 4, exact: true }).count(), 2);
      // No available featured item means there is no heading or empty section.
      dishes = dishes.map(dish => ({ ...dish, is_featured: !dish.available }));
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#featured-menu').count(), 0);
      assert.equal(await page.getByRole('heading', { name: featureHeading, exact: true }).count(), 0);
      console.log(`PASS: ${slug} owner featured/order validation and persistence, stable public order, unavailable exclusion and empty section hiding`);
      } else {
        await adminPage.goto(owner.url, { waitUntil: 'networkidle' });
        await adminPage.getByRole('button', { name: 'Menu', exact: true }).click();
        await page.goto(customer.url, { waitUntil: 'networkidle' });
      }
      // Categories use independent IDs, with a real category named All.
      const categoriesButton = adminPage.getByRole('button', { name: 'Manage categories', exact: true });
      await categoriesButton.click(); await focused(adminPage, 'Categories');
      await adminPage.getByRole('button', { name: 'Add category', exact: true }).click();
      await focused(adminPage, 'Add category');
      await dialog.getByLabel('Category name', { exact: true }).fill('Z First');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await dialog.getByText(/Category save failed/).waitFor();
      assert.equal(await dialog.getByLabel('Category name', { exact: true }).inputValue(), 'Z First');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await adminPage.getByText('Category saved.', { exact: true }).waitFor();
      await focused(adminPage, 'Categories');
      assert.equal(categoryWrites.at(-1).values.sort_order, 1, 'new categories are added last');
      await adminPage.getByRole('button', { name: 'Move category Z First up', exact: true }).click();
      await adminPage.getByText('Z First moved to position 1 of 2.', { exact: true }).waitFor();
      assert.equal(reorderCalls.at(-1).p_category_ids[0], groups.find(group => group.name === 'Z First').id);
      await adminPage.getByRole('button', { name: 'Rename category Z First', exact: true }).click();
      await dialog.getByLabel('Category name', { exact: true }).fill('Meals');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await dialog.getByText('A category with this name already exists. Choose another name.', { exact: true }).waitFor();
      await dialog.getByLabel('Category name', { exact: true }).fill('All');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Rename category All', exact: true }).waitFor();
      await adminPage.getByRole('button', { name: 'Done', exact: true }).click(); await focused(adminPage, 'Manage categories');
      await adminPage.getByRole('button', { name: 'Edit Diet fixture 4', exact: true }).click();
      await dialog.getByRole('button', { name: 'Category: Meals', exact: true }).click();
      await dialog.getByRole('button', { name: 'All', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
      await adminPage.getByText('Dish saved.', { exact: true }).waitFor();
      assert.equal(dietWrites.at(-1).category_id, groups.find(group => group.name === 'All').id);
      assert.equal(dietWrites.at(-1).category, undefined, 'dish saves contain only category ID');
      await categoriesButton.click();
      assert.equal(await adminPage.getByRole('button', { name: 'Delete category All', exact: true }).isDisabled(), true);
      await adminPage.setViewportSize({ width: 390, height: 1500 });
      await adminPage.screenshot({ path: `dist/browser/${slug}-categories-owner-mobile.png`, fullPage: true });
      await page.setViewportSize({ width: 390, height: 1100 });
      await page.reload({ waitUntil: 'networkidle' });
      const allDishes = page.getByRole('button', { name: 'All dishes', exact: true });
      const realAll = page.getByRole('button', { name: 'All', exact: true });
      await realAll.waitFor();
      const listed = await page.locator('#regular-menu').getByRole('heading', dishHeadingsFor(slug)).allTextContents();
      assert.deepEqual(listed, categoriesOnly ? ['Diet fixture 4','Diet fixture 1','Diet fixture 2','Diet fixture 3'] : ['Diet fixture 4','Diet fixture 1','Same name','Same name']);
      await realAll.click();
      assert.equal(await realAll.getAttribute('aria-pressed'), 'true');
      // Since #39 the chips jump to the section and keep every dish listed.
      assert.deepEqual(await page.locator('#regular-menu').getByRole('heading', dishHeadingsFor(slug)).allTextContents(), listed);
      await page.screenshot({ path: `dist/browser/${slug}-category-all-mobile.png`, fullPage: true });
      await allDishes.click(); 
      assert.equal(await page.locator('#regular-menu').getByRole('heading', dishHeadingsFor(slug)).count(), 4);
      await adminPage.getByRole('button', { name: 'Add category', exact: true }).click();
      await dialog.getByLabel('Category name', { exact: true }).fill('Temporary');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Delete category Temporary', exact: true }).click();
      await dialog.getByRole('button', { name: 'Confirm delete category', exact: true }).click();
      await dialog.getByText('Move all dishes to another category before deleting this category.', { exact: true }).waitFor();
      let reloadRequested, releaseReload;
      const reloadStarted = new Promise(resolve => { reloadRequested = resolve; });
      categoryReloadGate = { requested: () => reloadRequested(), wait: new Promise(resolve => { releaseReload = resolve; }) };
      await dialog.getByRole('button', { name: 'Confirm delete category', exact: true }).click();
      await reloadStarted;
      await adminPage.getByText('Loading menu', { exact: true }).waitFor();
      assert.equal(await adminPage.getByText('Category deleted.', { exact: true }).count(), 0, 'success waits for the category reload');
      assert.equal(await adminPage.getByRole('button', { name: 'Deleting…', exact: true }).count(), 1, 'held reload keeps the confirmation busy');
      releaseReload();
      await adminPage.getByText('Category deleted.', { exact: true }).waitFor();
      assert.equal(await adminPage.getByRole('button', { name: 'Rename category Temporary', exact: true }).count(), 0);
      await focused(adminPage, 'Categories');
      // A committed deletion followed by a failed refresh must not announce success
      // or repeat the DELETE when the owner retries loading the catalog.
      await adminPage.getByRole('button', { name: 'Add category', exact: true }).click();
      await dialog.getByLabel('Category name', { exact: true }).fill('Reload failure');
      await dialog.getByRole('button', { name: 'Save category', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Delete category Reload failure', exact: true }).click();
      failCategoryReload = true;
      await dialog.getByRole('button', { name: 'Confirm delete category', exact: true }).click();
      await adminPage.getByText(/Could not load categories: Category reload failed/).waitFor();
      assert.equal(await adminPage.getByText('Category deleted.', { exact: true }).count(), 0);
      const deletesBeforeRetry = categoryWrites.filter(write => write.method === 'DELETE').length;
      failCategoryReload = false;
      await adminPage.getByRole('button', { name: 'Retry loading menu', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Rename category Reload failure', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(categoryWrites.filter(write => write.method === 'DELETE').length, deletesBeforeRetry);
      await adminPage.getByRole('button', { name: 'Done', exact: true }).click(); await focused(adminPage, 'Manage categories');
      console.log(`PASS: ${slug} deletion waits for reload, restores focus, and reload failure retries without duplicate deletion`);
      assert.ok(categoryWrites.every(write => write.method !== 'PATCH' || write.values.business_id === undefined));
      console.log(`PASS: ${slug} category create/rename/order/picker, duplicate and retry errors, in-use restriction/race, keyboard focus and real All filter`);
      // Signing out from Settings returns this brand's owners' app to its branded sign-in without tabs.
      const ownerName = slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn';
      const ownerSections = adminPage.getByRole('navigation', { name: 'Owner sections' });
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await ownerSections.getByRole('button', { name: 'Settings', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Log out', exact: true }).click();
      await adminPage.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
      assert.equal(await ownerSections.count(), 0, 'signed-out owners see no tabs');
      await adminPage.getByRole('heading', { name: `${ownerName} kitchen`, exact: true }).waitFor();
      await adminPage.getByText(`This app is for ${ownerName}'s owners. Customers order from the ${ownerName} app.`, { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await adminPage.getByRole('img', { name: ownerName }).count(), 0, 'the logo is decorative beside the restaurant name');
      console.log(`PASS: ${slug} owner sign-out shows the branded signed-out state without tabs`);
      assert.deepEqual(dietErrors, []);
      if (!categoriesOnly) console.log(`PASS: ${slug} accessible diet shapes, unknown mark absence, menu/cart/reload/history/frozen attempt and owner keyboard classification`);
    } finally { await dietContext.close(); await customer.close(); await owner.close(); }
  }

  // Owners' Orders queue (#100): cards, accept, conflicts, live/paused, badge and single subscription, per brand.
  if (!categoriesOnly) for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
    if (selectedBrand && slug !== selectedBrand) continue;
    const owner = await serveWeb(`apps/${slug}-admin/dist/web`);
    // One anchor drives both Node fixtures and the browser, including the midnight regression run.
    const midnight = process.argv.includes('--owner-clock=midnight');
    const fixtureNow = Date.parse(midnight ? '2026-11-19T00:05:00+05:30' : '2026-11-19T12:00:00+05:30');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata', serviceWorkers: 'block' });
    await ctx.clock.install({ time: new Date(fixtureNow) });
    const expiresAt = Math.floor(fixtureNow / 1000) + 3600;
    const ownerToken = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: expiresAt })}.fixture`;
    const ownerSession = { ...session, access_token: ownerToken, expires_at: expiresAt };
    const primary = { 'ammu-sammu': 'rgb(168, 62, 50)', 'kokani-dine-inn': 'rgb(22, 92, 84)' }[slug];
    const brandName = slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn';
    const errs = [], unhandled = [], rpcCalls = [], sockets = [], joined = new Map();
    const istDay = offset => new Date(fixtureNow + 19800000 + offset * 86400000).toISOString().slice(0, 10);
    let realtimeFail = false, gate = null, orderGets = 0, summaryFail = false, summaryGate = null; const summaryCalls = [];
    const ids = n => `40000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    const ref = n => `${slug === 'ammu-sammu' ? 'AMS' : 'KDI'}-202611${String(n).padStart(4, '0')}`;
    const ago = minutes => new Date(fixtureNow - minutes * 60000).toISOString();
    const row = (n, status, customer, address, minutes, lines) => ({ order_number: ref(n), id: ids(n), business_id: businessId, customer_id: userId, status, version: 1, subtotal_paise: lines.reduce((sum, l) => sum + l[1] * l[2], 0), delivery_fee_paise: 3000, total_paise: lines.reduce((sum, l) => sum + l[1] * l[2], 0) + 3000, customer_name: customer, customer_phone: '9876543210', delivery_address_line: address, created_at: ago(minutes), order_items: lines.map(([name, quantity, unit], i) => ({ menu_item_id: `20000000-0000-4000-8000-00000000010${i}`, name, quantity, unit_price_paise: unit, line_total_paise: quantity * unit })), order_status_history: [{ status: 'placed', created_at: ago(minutes) }] });
    let db = [
      row(0x1A1, 'placed', 'Priya Kadam', 'Station Road, Khed, Ratnagiri, Maharashtra 415709', 2, [['Veg thali', 2, 15000], ['Sol kadhi', 1, 10000]]),
      row(0x1A2, 'placed', 'Amit Jadhav', 'Bharne Naka', 6, [['Chicken thali', 1, 25000], ['Ukadiche modak (4 pcs)', 2, 12000]]),
      row(0x1A3, 'accepted', 'Sneha Pawar', 'Market Yard', 12, [['Fish curry meal', 1, 28000]]),
      row(0x1A4, 'preparing', 'Rahul More', 'Temple Lane', 20, [['Veg thali', 1, 15000]]),
      row(0x1A5, 'delivered', 'Asha Gole', 'Mill Road', 90, [['Sol kadhi', 1, 10000]]),
    ];
    await ctx.addInitScript(({ slug, session }) => { for (const audience of ['customer', 'admin']) localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:${audience}`, JSON.stringify(session)); }, { slug, session: ownerSession });
    await ctx.routeWebSocket(/.*/, socket => {
      const entry = { socket, array: true, closed: false }; sockets.push(entry);
      socket.onClose(() => { entry.closed = true; });
      socket.onMessage(message => {
        const data = JSON.parse(String(message)); entry.array = Array.isArray(data);
        const [join, reference, topic, event, payload] = entry.array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        const fail = event === 'phx_join' && realtimeFail && topic.includes('orders:');
        const response = fail ? { status: 'error', response: { reason: 'fixture realtime failure' } } : { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index + 1 })) } };
        if (event === 'phx_join' && topic.includes('orders:') && !fail) joined.set(topic, entry);
        if (event === 'phx_leave') joined.delete(topic);
        if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) socket.send(JSON.stringify(entry.array ? [join, reference, topic, 'phx_reply', response] : { join_ref: join, ref: reference, topic, event: 'phx_reply', payload: response }));
      });
    });
    const activeSubscriptions = () => [...joined.values()].filter(entry => !entry.closed).length;
    const pushChange = () => { for (const [topic, entry] of joined) if (!entry.closed) { const payload = { ids: [1], data: { schema: 'public', table: 'orders', type: 'INSERT', commit_timestamp: new Date(fixtureNow).toISOString(), columns: [], record: {}, old_record: null, errors: null } }; entry.socket.send(JSON.stringify(entry.array ? [null, null, topic, 'postgres_changes', payload] : { topic, event: 'postgres_changes', payload, ref: null })); } };
    await ctx.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || url.hostname === '127.0.0.1') return route.fallback(); return route.abort(); });
    await ctx.route(origin + '/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/auth/v1/token') return json(ownerSession);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/rest/v1/businesses') return json({ ...business, slug, name: brandName });
      if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
      if (url.pathname === '/rest/v1/menu_categories') return json([]);
      if (url.pathname === '/rest/v1/menu_items') return json([]);
      if (url.pathname === '/rest/v1/orders') {
        if (url.searchParams.has('id')) return json(db.find(order => order.id === url.searchParams.get('id').slice(3)) ?? null);
        orderGets++; return json(db);
      }
      if (url.pathname === '/rest/v1/rpc/daily_summary') {
        const body = req.postDataJSON(); summaryCalls.push(body);
        if (summaryGate?.[body.p_date ?? 'today']) await summaryGate[body.p_date ?? 'today'];
        if (summaryFail) return json({ message: 'Fixture summary failure' }, 500);
        const day = body.p_date ?? istDay(0), empty = day === '2026-11-01';
        return json({ date: day, collected_paise: empty ? 0 : day === istDay(0) ? 426000 : 188050, delivered_count: empty ? 0 : day === istDay(0) ? 11 : 1, outstanding_paise: 221000, outstanding_count: 6, placed_count: empty ? 0 : 14, cancelled_count: empty ? 0 : 2, top_dishes: empty ? [] : [{ name: day === istDay(0) ? 'Veg thali' : 'Fish curry meal', quantity: 12 }] });
      }
      if (url.pathname === '/rest/v1/rpc/transition_order') {
        const body = req.postDataJSON(); rpcCalls.push(body);
        if (gate) await gate;
        const order = db.find(candidate => candidate.id === body.p_order_id);
        if (!order || order.version !== body.p_expected_version) return json({ code: 'P0001', message: 'Order was changed by someone else' }, 409);
        Object.assign(order, { status: body.p_status, version: order.version + 1 });
        return json({ id: order.id });
      }
      unhandled.push(req.method() + ' ' + url.pathname); return json({}, 404);
    });
    const open = async () => { const page = await ctx.newPage(); page.on('pageerror', error => errs.push(error.message)); await page.goto(owner.url, { waitUntil: 'networkidle' }); return page; };
    try {
      let page = await open();
      const tabs = page.getByRole('navigation', { name: 'Owner sections' });
      const card = n => page.getByRole('group', { name: new RegExp(`^Order ${ref(n)},`) });
      const accept = n => page.getByRole('button', { name: `Accept order ${ref(n)}`, exact: true });
      const pill = state => page.getByRole('status', { name: `Live updates: ${state}`, exact: true });
      await accept(0x1A1).waitFor(); await pill('Live').waitFor();
      // Card content, filters with counts, badge and brand.
      const first = card(0x1A1);
      await first.getByRole('heading', { name: 'Priya Kadam', level: 3 }).waitFor();
      for (const text of [/^New · 2 min ago$/, ref(0x1A1), /^Station Road, Khed/, '2 × Veg thali', '1 × Sol kadhi', /₹430/, 'Cash']) await first.getByText(text).first().waitFor();
      assert.equal(await first.getByText(/^Station Road, Khed, Ratnagiri, Maharashtra 415709$/).count(), 0, 'long addresses are truncated on the card');
      for (const name of ['New, 2', 'Accepted, 1', 'Preparing, 1', 'Out', 'Done']) await page.getByRole('button', { name, exact: true }).waitFor();
      await tabs.getByRole('button', { name: 'Orders, 2 new', exact: true }).waitFor();
      assert.equal(await accept(0x1A1).evaluate(node => getComputedStyle(node).backgroundColor), primary, `${slug} accent colour`);
      await page.getByRole('img', { name: brandName, exact: true }).count();
      for (const button of [accept(0x1A1), page.getByRole('button', { name: `Details for ${ref(0x1A1)}`, exact: true })]) { const box = await button.boundingBox(); assert.ok(box.height >= 48 && box.width >= 48, 'card targets are at least 48px'); }
      assert.equal(await card(0x1A3).count(), 0, 'accepted orders are not under New');
      await mkdir('/tmp/review100', { recursive: true }); await mkdir('/tmp/review61', { recursive: true });
      await page.screenshot({ path: `/tmp/review100/${slug}-orders.png` });
      // Accept: version-checked transition, per-card in-flight disable, no double accept.
      let release; gate = new Promise(resolve => { release = resolve; });
      await accept(0x1A1).click();
      await page.waitForFunction(() => document.body.innerText.includes('Accepting'));
      assert.equal(await accept(0x1A1).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: `Details for ${ref(0x1A1)}`, exact: true }).isDisabled(), true);
      assert.equal(await accept(0x1A2).isDisabled(), false, 'other cards stay usable');
      await accept(0x1A1).click({ force: true, timeout: 500 }).catch(() => {});
      gate = null; release();
      await page.getByText(`Order ${ref(0x1A1)} updated to Accepted.`, { exact: true }).filter({ visible: true }).waitFor();
      assert.deepEqual(rpcCalls, [{ p_order_id: ids(0x1A1), p_status: 'accepted', p_expected_version: 1 }]);
      await page.getByRole('button', { name: 'New, 1', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Accepted, 2', exact: true }).waitFor();
      assert.equal(await card(0x1A1).count(), 0);
      // Another owner accepted the second order first: the stale accept is rejected, the queue reloads, nothing claims success.
      Object.assign(db.find(order => order.id === ids(0x1A2)), { status: 'accepted', version: 2 });
      await accept(0x1A2).click();
      await page.getByText(new RegExp(`^Order ${ref(0x1A2)} was not updated: .*Order was changed by someone else`)).filter({ visible: true }).waitFor();
      assert.equal(rpcCalls.at(-1).p_expected_version, 1);
      assert.equal(await page.getByText(`Order ${ref(0x1A2)} updated to Accepted.`).count(), 0, 'no false success');
      await page.getByText('No new orders', { exact: true }).waitFor();
      await page.getByText('Keep this app open. New orders appear here.', { exact: true }).waitFor();
      assert.equal(await accept(0x1A2).count(), 0);
      await page.getByRole('button', { name: 'Accepted, 3', exact: true }).waitFor();
      await page.screenshot({ path: `/tmp/review100/${slug}-empty.png` });
      // New orders arrive live, including while another tab is open; one subscription survives tab switches.
      assert.equal(activeSubscriptions(), 1);
      db.push(row(0x1A6, 'placed', 'Meera Salvi', 'Gandhi Chowk', 0, [['Veg thali', 1, 15000]]));
      pushChange();
      await accept(0x1A6).waitFor();
      await tabs.getByRole('button', { name: 'Orders, 1 new', exact: true }).waitFor();
      await tabs.getByRole('button', { name: /^Menu/ }).click();
      await page.getByRole('button', { name: 'Add dish', exact: true }).waitFor();
      db.push(row(0x1A7, 'placed', 'Omkar Patil', 'Bus Stand', 0, [['Sol kadhi', 3, 10000]]));
      pushChange();
      await tabs.getByRole('button', { name: 'Orders, 2 new', exact: true }).waitFor();
      await tabs.getByRole('button', { name: /^Today/ }).click(); await tabs.getByRole('button', { name: /^Orders/ }).click();
      await accept(0x1A7).waitFor(); await accept(0x1A6).waitFor();
      assert.equal(await page.getByRole('group', { name: /^Order (AMS|KDI)-/ }).count(), 2, 'no duplicate cards');
      assert.equal(joined.size, 1, 'exactly one orders subscription after tab switches');
      assert.equal(activeSubscriptions(), 1);
      await page.close();
      // Paused: the channel fails to join; Reconnect re-subscribes and refreshes without losing or duplicating cards.
      realtimeFail = true;
      page = await open();
      await accept(0x1A6).waitFor();
      await pill('Paused').waitFor();
      await page.getByText('Live updates paused.', { exact: false }).first().waitFor();
      await page.getByText('New orders may not show until you reconnect.', { exact: false }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).evaluate(node => node.getBoundingClientRect().height >= 48), true);
      await page.screenshot({ path: `/tmp/review100/${slug}-paused.png` });
      db.push(row(0x1A8, 'placed', 'Late Customer', 'Ring Road', 0, [['Veg thali', 1, 15000]]));
      assert.equal(await accept(0x1A8).count(), 0, 'missed while paused');
      realtimeFail = false;
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await pill('Live').waitFor();
      await accept(0x1A8).waitFor();
      assert.equal(await page.getByText('Live updates paused.', { exact: false }).count(), 0);
      assert.equal(await page.getByRole('group', { name: /^Order (AMS|KDI)-/ }).count(), 3, 'reconnect keeps every card once');
      assert.equal(activeSubscriptions(), 1, 'reconnect leaves exactly one subscription');
      // ---- Order details (#101) ----
      await mkdir('/tmp/review101', { recursive: true });
      const find = n => db.find(order => order.id === ids(n));
      Object.assign(find(0x1A6), { customer_phone: '123' });
      Object.assign(find(0x1A3), { latitude: 17.7, longitude: 73.4, order_status_history: [{ status: 'placed', created_at: ago(12) }, { status: 'accepted', created_at: ago(10), order_status_actors: { actor_name: 'Suresh' } }] });
      pushChange(); await page.waitForTimeout(400);
      const detailsButton = n => page.getByRole('button', { name: `Details for ${ref(n)}`, exact: true });
      const panel = () => page.getByRole('dialog').first();
      const rpcFor = n => rpcCalls.filter(call => call.p_order_id === ids(n));
      // An unusable phone and no pin hide Call and Open in Maps; the state machine's first step is Accept order.
      await detailsButton(0x1A6).click();
      await focused(page, `Order ${ref(0x1A6)}`);
      await panel().getByText('123', { exact: true }).waitFor();
      assert.equal(await panel().getByRole('link', { name: /^Call /, exact: true }).count(), 0, 'no Call for an invalid phone');
      assert.equal(await panel().getByRole('link', { name: 'Open in Maps', exact: true }).count(), 0, 'no Maps without a pin');
      await panel().getByRole('button', { name: 'Accept order', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, `Details for ${ref(0x1A6)}`);
      // Full details for an accepted order: contact, links, bill, history with the owner snapshot.
      await page.getByRole('button', { name: 'Accepted, 3', exact: true }).click();
      await detailsButton(0x1A3).click();
      await focused(page, `Order ${ref(0x1A3)}`);
      const view = panel();
      for (const text of ['Sneha Pawar', '9876543210', 'Market Yard', '1 × Fish curry meal', 'Collect in cash', 'Accepted by Suresh', 'Items', 'Delivery']) await view.getByText(text, { exact: true }).first().waitFor();
      // At 00:05 IST the accepted fixture (12 minutes old) belongs to yesterday.
      await view.getByText(midnight ? 'Placed 18 Nov, 11:53 pm' : 'Placed today, 11:48 am', { exact: true }).waitFor();
      await view.getByRole('heading', { name: 'History' }).waitFor();
      assert.equal(await view.getByText('Placed', { exact: true }).count(), 1, 'the placed step has no owner name');
      assert.equal(await view.getByText(/^Placed by /).count(), 0);
      await view.getByText('₹280').first().waitFor(); await view.getByText('₹310').first().waitFor();
      assert.equal(await view.getByRole('link', { name: /^Call /, exact: true }).getAttribute('href'), 'tel:+919876543210');
      assert.equal(await view.getByRole('link', { name: 'Open in Maps', exact: true }).getAttribute('href'), 'https://www.google.com/maps/search/?api=1&query=17.7,73.4');
      for (const control of [view.getByRole('link', { name: /^Call /, exact: true }), view.getByRole('link', { name: 'Open in Maps', exact: true }), page.getByRole('button', { name: 'Cancel order', exact: true }), page.getByRole('button', { name: 'Start preparing', exact: true })]) { const box = await control.boundingBox(); assert.ok(box.height >= 48 && box.width >= 48, 'details targets are at least 48px'); }
      assert.equal(await page.getByRole('button', { name: 'Start preparing', exact: true }).evaluate(node => getComputedStyle(node).backgroundColor), primary, `${slug} primary action colour`);
      await page.screenshot({ path: `/tmp/review101/${slug}-details.png` });
      // Another owner moved it on first: our stale step is refused, the screen reloads to the current state and says so.
      Object.assign(find(0x1A3), { status: 'preparing', version: 2 });
      await page.getByRole('button', { name: 'Start preparing', exact: true }).click();
      await page.getByText(new RegExp(`^Order ${ref(0x1A3)} was not updated: .*Order was changed by someone else`)).filter({ visible: true }).waitFor();
      assert.deepEqual(rpcFor(0x1A3), [{ p_order_id: ids(0x1A3), p_status: 'preparing', p_expected_version: 1 }]);
      assert.equal(await page.getByText(`Order ${ref(0x1A3)} updated to Preparing.`).count(), 0, 'no false success');
      await view.getByRole('status', { name: 'Status: Preparing' }).waitFor();
      // Next step uses the new version, is disabled while in flight and cannot be sent twice.
      let letGo; gate = new Promise(resolve => { letGo = resolve; });
      await page.getByRole('button', { name: 'Out for delivery', exact: true }).click();
      await page.getByRole('button', { name: 'Out for delivery', exact: true }).isDisabled();
      assert.equal(await page.getByRole('button', { name: 'Out for delivery', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Cancel order', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: 'Out for delivery', exact: true }).click({ force: true, timeout: 500 }).catch(() => {});
      gate = null; letGo();
      await page.getByText(`Order ${ref(0x1A3)} updated to Out for delivery.`, { exact: true }).filter({ visible: true }).waitFor();
      assert.deepEqual(rpcFor(0x1A3).at(-1), { p_order_id: ids(0x1A3), p_status: 'out_for_delivery', p_expected_version: 2 });
      assert.equal(rpcFor(0x1A3).length, 2, 'one RPC per tap');
      assert.equal(await page.getByRole('button', { name: 'Cancel order', exact: true }).count(), 0, 'out for delivery cannot be cancelled');
      await page.getByRole('button', { name: 'Mark delivered', exact: true }).click();
      await view.getByRole('status', { name: 'Status: Delivered' }).waitFor();
      await view.getByText('This order was delivered. No further actions.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^(Mark delivered|Cancel order|Start preparing|Accept order)$/ }).filter({ visible: true }).count(), 0, 'terminal orders have no actions');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).waitFor();
      await detailsButton(0x1A3).waitFor();
      await focused(page, `Details for ${ref(0x1A3)}`); // the card moved to Done; focus still returns to it
      // Cancel sheet: focus moves in, Keep restores it, confirm sends one version-checked cancellation.
      await page.getByRole('button', { name: 'Preparing, 1', exact: true }).click();
      await detailsButton(0x1A4).click();
      await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
      await focused(page, `Cancel order ${ref(0x1A4)}?`);
      const sheetTitle = await page.getByRole('heading', { name: `Cancel order ${ref(0x1A4)}?`, exact: true }).boundingBox();
      assert.ok(sheetTitle.y > page.viewportSize().height / 2, 'the cancel confirmation rises from the bottom as a sheet');
      // On a short screen the sheet stays within 90% of the height and scrolls to its buttons.
      const fullSize = page.viewportSize(); await page.setViewportSize({ width: fullSize.width, height: 300 });
      const hint = page.getByText('A quick call to say why helps, for example if a dish has run out.', { exact: true });
      await page.waitForTimeout(300);
      const shortTitle = await page.getByRole('heading', { name: `Cancel order ${ref(0x1A4)}?`, exact: true }).boundingBox();
      assert.ok(shortTitle.y >= 300 * 0.1 - 2, 'the sheet stays within 90% of a short screen instead of growing off the top');
      const keep = page.getByRole('button', { name: 'Keep the order', exact: true }); await keep.scrollIntoViewIfNeeded();
      const keepBox = await keep.boundingBox(); assert.ok(keepBox.y >= 0 && keepBox.y + keepBox.height <= 300, 'Keep is reachable by scrolling');
      assert.equal(await hint.locator('xpath=ancestor::div[1]/preceding-sibling::*[local-name()="svg"][@aria-hidden="true"]').count(), 1, 'the call-hint icon is hidden from assistive tech');
      await page.setViewportSize(fullSize);
      await page.getByText("Rahul More's order for ₹180 will be cancelled, and it will show as cancelled in their app. This can't be undone.", { exact: true }).waitFor();
      await page.getByText('A quick call to say why helps, for example if a dish has run out.', { exact: true }).waitFor();
      await page.screenshot({ path: `/tmp/review101/${slug}-cancel.png` });
      await page.getByRole('button', { name: 'Keep the order', exact: true }).click();
      await focused(page, 'Cancel order');
      assert.equal(rpcFor(0x1A4).length, 0);
      await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
      gate = new Promise(resolve => { letGo = resolve; });
      await page.getByRole('button', { name: 'Cancel the order', exact: true }).click();
      await page.getByRole('status', { name: 'Status: Preparing' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Cancel order', exact: true }).isDisabled(), true, 'disabled while cancelling');
      gate = null; letGo();
      await page.getByText(`Order ${ref(0x1A4)} updated to Cancelled.`, { exact: true }).filter({ visible: true }).waitFor();
      assert.deepEqual(rpcFor(0x1A4), [{ p_order_id: ids(0x1A4), p_status: 'cancelled', p_expected_version: 1 }]);
      await page.getByRole('status', { name: 'Status: Cancelled' }).waitFor();
      await page.getByText('This order was cancelled. No further actions.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      // A retry after a lost response: the order is already cancelled, so the stale cancel is refused, nothing is cancelled twice, and the screen shows Cancelled.
      await page.getByRole('button', { name: 'New, 3', exact: true }).click();
      await detailsButton(0x1A7).click();
      await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
      Object.assign(find(0x1A7), { status: 'cancelled', version: 2 });
      await page.getByRole('button', { name: 'Cancel the order', exact: true }).click();
      await page.getByText(new RegExp(`^Order ${ref(0x1A7)} was not updated: `)).filter({ visible: true }).waitFor();
      await page.getByRole('status', { name: 'Status: Cancelled' }).waitFor();
      assert.deepEqual(rpcFor(0x1A7).map(call => call.p_status), ['cancelled']);
      assert.equal(await page.getByRole('button', { name: 'Cancel order', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await detailsButton(0x1A5).click();
      await page.getByRole('dialog').first().getByText('This order was delivered. No further actions.', { exact: true }).waitFor();
      assert.equal(await page.getByText(new RegExp(`^Order ${ref(0x1A7)} was not updated`)).filter({ visible: true }).count(), 0, "another order's notice is not shown here");
      await page.screenshot({ path: `/tmp/review101/${slug}-details-wide.png` });
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      assert.deepEqual(unhandled, []); assert.deepEqual(errs, []);
      console.log(`PASS: ${slug} owners' Orders queue cards, accept, in-flight, conflict, empty, live badge, single subscription and Paused/Reconnect, plus order details (#101): contact/maps/bill/history, version-checked steps, conflict reload, cancel sheet, terminal state`);
      // Today tab (#61): India-time days, date-scoped labels, current outstanding, stale responses, error + Retry.
      const ownerTabs = page.getByRole('navigation', { name: 'Owner sections' });
      const [istToday, istYesterday] = [istDay(0), istDay(-1)], dayName = iso => `${Number(iso.slice(8))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1]}`;
      await ownerTabs.getByRole('button', { name: /^Today/ }).click();
      const today = text => page.getByText(text, { exact: true }).filter({ visible: true });
      await today('₹4,260').waitFor();
      for (const text of ['Collected', '11 orders delivered today', 'Still to collect now', '₹2,210', '6 open orders · all dates', 'Placed today', 'Delivered today', 'Cancelled today', 'Veg thali', '× 12', "Days run midnight to midnight, India time. Cancelled orders aren't counted in cash."]) await today(text).waitFor();
      await page.getByRole('heading', { name: 'Most ordered', level: 2 }).waitFor();
      assert.deepEqual(summaryCalls.at(-1), { p_business_slug: slug }, 'today sends no p_date');
      assert.equal(await page.getByRole('button', { name: `Today, ${dayName(istToday)}`, exact: true }).getAttribute('aria-pressed'), 'true');
      for (const name of [`Today, ${dayName(istToday)}`, 'Yesterday', 'Pick a date']) { const box = await page.getByRole('button', { name, exact: true }).boundingBox(); assert.ok(box.height >= 48, 'chips are at least 48px tall'); }
      // #114 p. 11: the day chips sit in the compact header (brand header fill), above the cash card, not in the scrolling body.
      const chipGroup = page.getByRole('group', { name: 'Choose a day', exact: true }).filter({ visible: true });
      assert.equal(await chipGroup.evaluate(el => { for (let node = el; node; node = node.parentElement) { const color = getComputedStyle(node).backgroundColor; if (color !== 'rgba(0, 0, 0, 0)') return color; } return ''; }), slug === 'kokani-dine-inn' ? 'rgb(16, 48, 43)' : 'rgb(255, 248, 240)', 'day chips are on the header fill');
      const [chipBox, cashBox] = [await chipGroup.boundingBox(), await today('CASH').boundingBox()];
      assert.ok(chipBox.y + chipBox.height <= cashBox.y, 'day chips are above the cash card');
      assert.ok(chipBox.y < 140, 'day chips sit in the compact header region');
      await today('Placed today').waitFor();
      assert.equal(await page.getByText(brandName === 'Ammu Sammu' ? 'Kokani' : 'Ammu', { exact: false }).filter({ visible: true }).count(), 0, 'the other brand is never shown');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `/tmp/review61/${slug}-today.png` });
      // Yesterday: p_date is the India-time yesterday; labels follow the day; outstanding stays current.
      await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
      await today('Delivered yesterday').waitFor(); await today('Collected yesterday').waitFor(); await today('₹1,880.50').waitFor(); await today('Fish curry meal').waitFor();
      assert.deepEqual(summaryCalls.at(-1), { p_business_slug: slug, p_date: istYesterday });
      assert.equal(await page.getByRole('button', { name: 'Yesterday', exact: true }).getAttribute('aria-pressed'), 'true');
      await today('Still to collect now').waitFor(); await today('₹2,210').waitFor();
      // Picked date (native input, max = today IST).
      await page.getByRole('button', { name: 'Pick a date', exact: true }).click();
      const input = page.getByLabel('Choose a day', { exact: true }).and(page.locator('input'));
      await input.waitFor(); assert.equal(await input.getAttribute('max'), istToday);
      await today(`Delivered on ${dayName(istDay(-2))}`).waitFor();
      assert.deepEqual(summaryCalls.at(-1), { p_business_slug: slug, p_date: istDay(-2) });
      await input.fill('2026-11-10');
      await today('Delivered on 10 Nov').waitFor(); await today('1 order delivered on 10 Nov').waitFor();
      assert.deepEqual(summaryCalls.at(-1), { p_business_slug: slug, p_date: '2026-11-10' });
      await page.screenshot({ path: `/tmp/review61/${slug}-today-picked.png` });
      // Empty day: zeros and "No dishes ordered".
      await input.fill('2026-11-01');
      await today('No dishes ordered').waitFor(); await today('₹0').first().waitFor();
      assert.equal(await page.getByRole('group', { name: 'Placed on 1 Nov: 0', exact: true }).count(), 1);
      // Stale responses: leave a slow picked-day request, switch to Today, the slow answer must not replace it.
      let releaseSlow; summaryGate = { '2026-11-05': new Promise(resolve => { releaseSlow = resolve; }) };
      await input.fill('2026-11-05');
      await page.getByRole('button', { name: new RegExp(`^Today, ${dayName(istToday)}`) }).click();
      await today('Collected').waitFor(); releaseSlow(); summaryGate = null;
      await page.waitForTimeout(150);
      assert.equal(await today('Collected on 5 Nov').count(), 0, 'a stale response is ignored');
      await today('Collected').waitFor();
      // Error with Retry, then recovery.
      summaryFail = true;
      await page.getByRole('button', { name: 'Yesterday', exact: true }).click();
      await page.getByText('Could not load the summary', { exact: true }).filter({ visible: true }).waitFor();
      summaryFail = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await today('Collected yesterday').waitFor();
      await ownerTabs.getByRole('button', { name: /^Orders/ }).click();
      await page.getByRole('button', { name: 'New, 2', exact: true }).waitFor();
      await ownerTabs.getByRole('button', { name: /^Today/ }).click();
      await today('Collected').waitFor();
      assert.deepEqual(summaryCalls.at(-1), { p_business_slug: slug }, 'returning to the tab starts on today');
      assert.deepEqual(unhandled, []); assert.deepEqual(errs, []);
      console.log(`PASS: ${slug} owners' Today tab (#61): India-time chips, rpc/daily_summary params, labels, picked date, empty, stale-response guard, error/Retry`);
    } finally { await ctx.close(); await owner.close(); }
  }
} finally { await context?.close(); await browser?.close(); await customerServer?.close(); await adminServer?.close(); }

if (!categoriesOnly) await import('./account.mjs');
if (!categoriesOnly) await import('./addresses48.mjs');
if (!categoriesOnly) await import('./closed58.mjs');
if (!categoriesOnly) await import('./owner-menu.mjs');
if (!categoriesOnly) { await import('./owner58.mjs'); await import('./owner48.mjs'); await import('./owner60.mjs'); await import('./owner53name.mjs'); }

}
if (!categoriesOnly) await tracking47();

/** Customer tracking (#47), exercising the shared screen through each built brand. */
async function tracking47() {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await mkdir('dist/browser', { recursive: true });
  try {
    for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
      if (selectedBrand && slug !== selectedBrand) continue;
      const server = await serveWeb(`apps/${slug}-customer/dist/web`);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await ctx.clock.install({ time: new Date('2026-11-16T06:30:30Z') }); // pin fixture clock: fixtures are dated 16 Nov 2026 (12:00 pm IST); time still flows
      const origin = 'https://market-fixture.supabase.co';
      const businessId = slug === 'ammu-sammu' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002';
      const userId = '30000000-0000-4000-8000-000000000001', orderId = '40000000-0000-4000-8000-000000000047';
      const prefix = slug === 'ammu-sammu' ? 'AMS' : 'KDI', brandName = slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn';
      const reference = `${prefix}-20261110000`;
      const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'tracking@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-11-01T00:00:00Z' };
      const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: userId, role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000047', exp: Math.floor(Date.now() / 1000) + 3600 })}.${part('synthetic-signature')}`;
      const session = { access_token: token, refresh_token: 'tracking-refresh', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
      const placed = '2026-11-16T06:30:00Z';
      let contactPhone = '+919876543210';
      let order = { id: orderId, order_number: reference, business_id: businessId, customer_id: userId, status: 'placed', version: 1, subtotal_paise: 15000, delivery_fee_paise: 2000, total_paise: 17000, customer_name: 'Tracking customer', customer_phone: '+919000000000', delivery_address_line: 'House 5, Station Road, Khed', latitude: 17.719, longitude: 73.397, created_at: placed, order_items: [{ menu_item_id: '20000000-0000-4000-8000-000000000001', diet: 'veg', name: 'Tracking thali', quantity: 1, unit_price_paise: 15000, line_total_paise: 15000 }, { menu_item_id: '20000000-0000-4000-8000-000000000002', diet: 'non_veg', name: 'Tracking curry', quantity: 1, unit_price_paise: 0, line_total_paise: 0 }, { menu_item_id: '20000000-0000-4000-8000-000000000003', diet: null, name: 'Tracking unmarked', quantity: 1, unit_price_paise: 0, line_total_paise: 0 }], order_status_history: [{ status: 'placed', created_at: placed }] };
      const joined = new Map(), businessJoined = new Map(), errors = [], unexpected = [];
      let menuFails = false;
      let orderReads = 0, navigations = 0;
      await ctx.addInitScript(({ slug, session }) => {
        localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:customer`, JSON.stringify(session));
        window.__trackingPermissionRequests = 0;
        if ('Notification' in window) Notification.requestPermission = () => { window.__trackingPermissionRequests++; return Promise.resolve('denied'); };
      }, { slug, session });
      await ctx.routeWebSocket(/.*/, socket => {
        const entry = { socket, array: true, closed: false };
        socket.onClose(() => { entry.closed = true; });
        socket.onMessage(message => {
          const data = JSON.parse(String(message)); entry.array = Array.isArray(data);
          const [join, ref, topic, event, payload] = entry.array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
          if (event === 'phx_join' && topic.includes('orders:')) joined.set(topic, entry);
          if (event === 'phx_join' && topic.includes('business-state:')) businessJoined.set(topic, entry);
          if (event === 'phx_leave') joined.delete(topic);
          if (['phx_join', 'phx_leave', 'heartbeat'].includes(event)) {
            const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index + 1 })) } };
            socket.send(JSON.stringify(entry.array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
          }
        });
      });
      const liveSubscriptions = () => [...joined.values()].filter(entry => !entry.closed).length;
      const pushStatus = (status, createdAt) => {
        order = { ...order, status, version: order.version + 1, order_status_history: [...order.order_status_history, { status, created_at: createdAt }] };
        for (const [topic, entry] of joined) if (!entry.closed) {
          const payload = { ids: [1], data: { schema: 'public', table: 'orders', type: 'UPDATE', commit_timestamp: createdAt, columns: [], record: { id: orderId, status }, old_record: null, errors: null } };
          entry.socket.send(JSON.stringify(entry.array ? [null, null, topic, 'postgres_changes', payload] : { topic, event: 'postgres_changes', payload, ref: null }));
        }
      };
      await ctx.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || url.hostname === '127.0.0.1') return route.fallback(); return route.abort(); });
      await ctx.route(origin + '/**', async route => {
        const url = new URL(route.request().url());
        const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/auth/v1/token') return json(session);
        if (url.pathname === '/auth/v1/user') return json(user);
        if (url.pathname === '/rest/v1/businesses') return json({ id: businessId, slug, name: brandName, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: contactPhone });
        if (url.pathname === '/rest/v1/menu_items' && menuFails) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture menu failure' }) });
        // The live menu disagrees with the saved snapshots (#153): the thali is now non-veg, the curry is veg.
        if (url.pathname === '/rest/v1/menu_items') return json([['20000000-0000-4000-8000-000000000001', 'non_veg'], ['20000000-0000-4000-8000-000000000002', 'veg']].map(([id, diet], sort_order) => ({ id, diet, business_id: businessId, name: 'Live menu dish', description: '', category_id: '14300000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 100, available: true, is_demo: false, is_featured: false, sort_order, image_url: null })));
        if (url.pathname === '/rest/v1/menu_categories') return json([]);
        if (url.pathname === '/rest/v1/orders') { orderReads++; return json(url.searchParams.has('id') ? order : [order]); }
        unexpected.push(route.request().method() + ' ' + url.pathname); return json([]);
      });
      try {
        const page = await ctx.newPage(); page.on('pageerror', error => errors.push(error.message));
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
        await page.goto(`${server.url}/orders/${orderId}`, { waitUntil: 'networkidle' });
        const visible = text => page.getByText(text, { exact: true }).filter({ visible: true });
        await visible(`Order ${reference}`).waitFor();
        await visible('Your order is with the restaurant').waitFor();
        const stage = name => page.getByRole('listitem', { name }).filter({ visible: true });
        for (const name of [/^Order placed, now, .*12:00 pm$/, /^Accepted by the restaurant, not yet$/, /^Being prepared, not yet$/, /^Out for delivery, not yet$/, /^Delivered, not yet$/]) await stage(name).waitFor();
        await visible(`Waiting for ${brandName} to accept it. We'll tell you when they do.`).waitFor();
        assert.equal(await visible('Good food starts here.').count(), 0);
        assert.equal(await page.getByRole('link', { name: `Call ${brandName}`, exact: true }).getAttribute('href'), 'tel:+919876543210');
        // #153: every line shows its saved diet snapshot (never the live menu's opposite value); an unmarked line shows none.
        const dietMarks = () => page.getByRole('img', { name: /^(Vegetarian|Contains egg|Non-vegetarian)$/ }).filter({ visible: true });
        const dietLabel = diet => ({ veg: 'Vegetarian', non_veg: 'Non-vegetarian', egg: 'Contains egg' })[diet];
        const marks = async () => (await dietMarks().evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))));
        assert.deepEqual(await marks(), [dietLabel('veg'), dietLabel('non_veg')], 'active order shows snapshot diet marks in line order');
        // Each line and its mark form one group, with more space between lines than inside a line; Items sits beside its list like the other detail rows.
        const lineGroups = page.getByRole('group', { name: /^\d+ × / }).filter({ visible: true });
        assert.equal(await lineGroups.count(), 3, 'one group per order line');
        assert.equal(await lineGroups.first().getByRole('img').count(), 1, 'the first line holds its own diet mark');
        assert.equal(await lineGroups.nth(2).getByRole('img').count(), 0, 'the unmarked line shows no mark');
        const [g1, g2, label] = await Promise.all([lineGroups.nth(0).boundingBox(), lineGroups.nth(1).boundingBox(), visible(slug === 'kokani-dine-inn' ? 'Dishes' : 'Items').boundingBox()]);
        assert.ok(g2.y - (g1.y + g1.height) >= 8, 'lines are separated more than a line is from its mark');
        assert.ok(Math.abs(label.y - g1.y) < 12, 'the Items label is level with the first line, not above the list');
        // #153: a failed catalog refresh keeps the already-loaded contact number callable.
        menuFails = true;
        const refreshFailed = page.waitForResponse(response => response.url().includes('/rest/v1/menu_items') && response.status() === 500);
        for (const [topic, entry] of businessJoined) if (!entry.closed) entry.socket.send(JSON.stringify(entry.array ? [null, null, topic, 'postgres_changes', { ids: [1], data: { schema: 'public', table: 'businesses', type: 'UPDATE', commit_timestamp: placed, columns: [], record: { id: businessId }, old_record: null, errors: null } }] : { topic, event: 'postgres_changes', payload: { ids: [1], data: { schema: 'public', table: 'businesses', type: 'UPDATE', commit_timestamp: placed, columns: [], record: { id: businessId }, old_record: null, errors: null } }, ref: null }));
        await refreshFailed; await page.waitForTimeout(300);
        assert.equal(await page.getByRole('link', { name: `Call ${brandName}`, exact: true }).getAttribute('href'), 'tel:+919876543210', 'call stays available while the catalog refresh fails');
        menuFails = false;
        assert.equal(await page.evaluate(() => window.__trackingPermissionRequests), 0, 'tracking never requests notification consent automatically');
        assert.equal(await page.getByText('Notifications are not available yet.', { exact: true }).count(), 0, 'no updates message before a tap');
        await page.getByRole('button', { name: 'Turn on order updates', exact: true }).click();
        assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'focus stays on the button after Turn on');
        // The tapped button disappears once delivered, so park focus on a control that survives and check it stays put.
        await page.getByRole('button', { name: 'Refresh orders', exact: true }).focus();
        await page.evaluate(() => { window.__focusBeforeDelivered = document.activeElement; });
        await visible('Notifications are not available yet.').waitFor();
        assert.equal(liveSubscriptions(), 1, 'one order subscription serves the tracking screen');
        const initialNavigations = navigations, initialReads = orderReads;
        pushStatus('accepted', '2026-11-16T06:32:00Z');
        await visible('The restaurant accepted your order').waitFor();
        await stage(/^Accepted by the restaurant, now, .*12:02 pm$/).waitFor();
        await visible(`${brandName} accepted your order at 12:02 pm. They'll start cooking soon.`).waitFor();
        pushStatus('preparing', '2026-11-16T06:35:00Z');
        await visible('Your food is being prepared').waitFor();
        await stage(/^Being prepared, now, .*12:05 pm$/).waitFor();
        await visible('Order details').waitFor(); await visible('₹170 cash on delivery').waitFor();
        await visible(`Order ${reference}`).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `dist/browser/${slug}-tracking-mobile.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 1500 }); await page.screenshot({ path: `dist/browser/${slug}-tracking-diet-active.png` });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({ path: `dist/browser/${slug}-tracking-desktop.png`, fullPage: true });
        pushStatus('out_for_delivery', '2026-11-16T06:50:00Z');
        await visible(slug === 'kokani-dine-inn' ? 'Out for delivery' : 'Your food is on its way').first().waitFor();
        await page.getByText(/left (the|our) kitchen at .*Please keep ₹170 ready in cash\.$/).filter({ visible: true }).waitFor();
        pushStatus('delivered', '2026-11-16T07:05:00Z');
        await visible(slug === 'kokani-dine-inn' ? 'Enjoy your meal' : 'Delivered. Enjoy!').waitFor();
        await visible('Paid in cash').waitFor(); await visible('₹170').waitFor();
        await page.getByText(/^Arrived on .* 35 minutes after you ordered\.$/).filter({ visible: true }).waitFor();
        await visible('House 5, Station Road, Khed').waitFor();
        await visible('Order this again').waitFor();
        assert.deepEqual(await marks(), [dietLabel('veg'), dietLabel('non_veg')], 'delivered order shows snapshot diet marks');
        assert.equal(await page.evaluate(() => document.activeElement === window.__focusBeforeDelivered), true, 'focus stays on the same element when the order is delivered after a failed Turn on');
        assert.equal(await page.getByRole('button', { name: 'Turn on order updates', exact: true }).count(), 0, 'no consent prompt on terminal order');
        assert.equal(navigations, initialNavigations, 'all transitions arrived without page navigation/reload');
        assert.ok(orderReads > initialReads); assert.equal(liveSubscriptions(), 1);
        await page.setViewportSize({ width: 390, height: 1100 }); await page.screenshot({ path: `dist/browser/${slug}-tracking-diet-delivered.png` });
        await visible(`Order ${reference}`).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `dist/browser/${slug}-tracking-delivered.png`, fullPage: true });
        // A separate cancelled order exercises the other terminal presentation.
        order = { ...order, id: '40000000-0000-4000-8000-000000000048', order_number: `${prefix}-20261110001`, status: 'cancelled', version: 2, order_status_history: [{ status: 'placed', created_at: placed }, { status: 'cancelled', created_at: '2026-11-16T06:34:00Z' }] };
        await page.goto(`${server.url}/orders/${order.id}`, { waitUntil: 'networkidle' });
        await visible('This order was cancelled').waitFor();
        await visible(`${brandName} cancelled it at 12:04 pm. You don't need to pay anything.`).waitFor();
        await stage(/^Cancelled by the restaurant, cancelled, .*12:04 pm$/).waitFor();
        await visible('Want to know why? The restaurant can tell you.').waitFor();
        assert.deepEqual(await marks(), [dietLabel('veg'), dietLabel('non_veg')], 'cancelled order shows snapshot diet marks');
        await visible('Order again').waitFor();
        assert.equal(await visible('₹170').evaluate(el => getComputedStyle(el).textDecorationLine), 'line-through', 'nothing is owed: the total is struck through');
        assert.equal(await page.getByRole('link', { name: slug === 'kokani-dine-inn' ? `Call us, ${brandName}` : `Call ${brandName}`, exact: true }).getAttribute('href'), 'tel:+919876543210');
        await visible(`Order ${prefix}-20261110001`).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `dist/browser/${slug}-tracking-cancelled.png`, fullPage: true });
        // Missing contact stays honest, and refresh/reload never manufactures a dialer target.
        contactPhone = null;
        await page.reload({ waitUntil: 'networkidle' });
        await visible('Restaurant phone is unavailable. Please try Help & support.').waitFor();
        assert.equal(await page.getByRole('link', { name: `Call ${brandName}`, exact: true }).count(), 0);
        assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        console.log(`PASS: ${slug} #47 tracking number, five stages/times, one realtime subscription, live transitions, delivered cash/duration/address, cancellation, call/missing phone, consent gesture and narrow/wide screenshots`);
      } catch (error) {
        await ctx.pages()[0]?.screenshot({ path: `dist/browser/${slug}-tracking-failure.png`, fullPage: true }).catch(() => {});
        throw error;
      } finally { await ctx.close(); await server.close(); }
    }
  } finally { await browser.close(); }
}
