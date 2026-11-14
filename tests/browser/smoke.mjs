import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { serveWeb } from '../../scripts/serve-web.mjs';

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
const business = { id: businessId, slug: 'ammu-sammu', name: 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true };
const item = { id: itemId, business_id: businessId, name: 'Fixture meal', description: 'Synthetic browser test item', category: 'Meals', price_paise: 15000, available: true, is_demo: false, image_url: null };
let savedOrder;
let failOrders = false;
let holdOrders = false, orderHeld = false, releaseOrders;
let adminAllowed = false;
let failSave = true, failDelete = true;
let menuItems = [item];
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
  if (url.pathname === '/rest/v1/menu_items') {
    if (req.method() === 'GET') return json(menuItems);
    if (req.method() === 'POST') { if (failSave) { failSave = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture save failure' }) }); } const row = { ...req.postDataJSON(), id: '20000000-0000-4000-8000-000000000002' }; mutations.push(row); menuItems.push(row); return json(row); }
    if (req.method() === 'PATCH') { const values = req.postDataJSON(); mutations.push(values); menuItems = menuItems.map(row => row.id.endsWith('002') ? { ...row, ...values } : row); return json(menuItems.find(row => row.id.endsWith('002'))); }
    if (req.method() === 'DELETE') { if (failDelete) { failDelete = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture delete failure' }) }); } menuItems = menuItems.filter(row => !row.id.endsWith('002')); return json({ id: '20000000-0000-4000-8000-000000000002' }); }
  }
  if (url.pathname === '/rest/v1/business_memberships') return json(adminAllowed ? { role: 'admin' } : null);
  if (url.pathname === '/rest/v1/rpc/check_delivery_eligibility') return json({ eligible: true });
  if (url.pathname === '/rest/v1/rpc/place_order') {
    const body = req.postDataJSON(); requests.push(body);
    if (!savedOrder) {
      savedOrder = { id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, subtotal_paise: 15000, delivery_fee_paise: 2000, total_paise: 17000, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: body.p_delivery.address_line, created_at: new Date().toISOString(), order_items: [{ menu_item_id: itemId, name: item.name, quantity: 1, unit_price_paise: 15000, line_total_paise: 15000 }], order_status_history: [{ status: 'placed', created_at: new Date().toISOString() }] };
      return route.abort('failed'); // Server committed; response was lost.
    }
    return json({ id: orderId });
  }
  if (url.pathname === '/rest/v1/rpc/transition_order') { const body = req.postDataJSON(); mutations.push(body); savedOrder = { ...savedOrder, status: body.p_status, version: savedOrder.version + 1 }; return json({ id: orderId }); }
  if (url.pathname === '/rest/v1/orders') { if (holdOrders) { orderHeld = true; await new Promise(resolve => { releaseOrders = resolve; }); } if (failOrders) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture order load failure' }) }); return json(url.searchParams.has('id') ? savedOrder : savedOrder ? [savedOrder] : []); }
  throw new Error('Unhandled fixture request: ' + req.method() + ' ' + url.pathname);
});
const errors = [];
const open = async () => { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(customerServer.url, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: 'Add to cart', exact: true }).waitFor(); return page; };
const focused = (page, text) => page.waitForFunction(expected => document.activeElement?.textContent === expected, text);
const account = async page => { await page.getByRole('button', { name: 'Account', exact: true }).click(); const settings = page.getByRole('button', { name: 'Account settings', exact: true }); if (await settings.count()) await settings.click(); else await page.getByRole('button', { name: 'Sign in', exact: true }).click(); };
const signIn = async page => { await page.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor(); };
const prepareCart = async page => {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Browse menu', exact: true }).click();
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByRole('button', { name: /^Cart \(/ }).click();
  await page.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Test Customer');
  await page.getByLabel('Mobile number', { exact: true }).filter({ visible: true }).fill('9876543210');
  await page.getByLabel('Delivery address', { exact: true }).filter({ visible: true }).fill('Synthetic test lane, Khed, Maharashtra');
  await page.getByRole('button', { name: 'Check my delivery location', exact: true }).click();
  await page.getByText('Delivery location confirmed. Refresh if your location changes.', { exact: true }).filter({ visible: true }).waitFor();
};
  const first = await open();
  await first.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await first.getByRole('button', { name: /^Cart \(/ }).click();
  await first.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Guest draft');
  await first.getByRole('button', { name: 'Check my delivery location', exact: true }).click();
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
  const second = await open(); await prepareCart(second);
  await first.getByRole('button', { name: 'Place order', exact: true }).click();
  await first.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
  await second.getByText('Order awaiting confirmation', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Place order', exact: true }).isDisabled(), true);
  await second.getByRole('button', { name: 'Retry order recovery', exact: true }).click();
  await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(requests.length, 2); assert.deepEqual(requests[1], requests[0]);
  await second.getByText('Delivery: ₹20.00 · Total: ₹170.00', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await second.getByText('Delivery: ₹20.00 · Total: ₹170.00', { exact: true }).filter({ visible: true }).count(), 1);
  await second.screenshot({ path: 'dist/browser/customer-confirmed-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: cross-tab lost-response recovery reuses exact key/payload and confirms one server order');

  // Real paths survive reload and back; missing orders are distinct from loading.
  assert.equal(new URL(second.url()).pathname, '/orders/' + orderId);
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).waitFor();
  failOrders = true;
  await second.reload({ waitUntil: 'networkidle' });
  await second.getByText('Could not load your orders', { exact: true }).filter({ visible: true }).waitFor();
  failOrders = false;
  await second.getByRole('button', { name: 'Retry orders', exact: true }).click();
  await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).waitFor();
  await second.goto(customerServer.url + '/orders/90000000-0000-4000-8000-000000000009', { waitUntil: 'networkidle' });
  await second.getByText("We can't show this order", { exact: true }).filter({ visible: true }).waitFor();
  // Drawer traps keyboard focus, dismisses with Escape and restores its opener.
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await focused(second, 'Your account');
  await second.waitForTimeout(250);
  await second.screenshot({ path: 'dist/browser/customer-drawer-mobile.png', fullPage: true });
  await second.keyboard.press('Shift+Tab'); await focused(second, 'Browse menu');
  await second.keyboard.press('Tab'); await focused(second, 'Close');
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
  await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).waitFor();
  await second.goBack();
  assert.equal(new URL(second.url()).pathname, '/cart');
  assert.equal(await second.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), 'Draft stays');
  assert.equal(await second.getByRole('button', { name: /^Cart \(/ }).count(), 1);
  const asset = await context.request.get(customerServer.url + '/orders/missing.js'); assert.equal(asset.status(), 404);
  const worker = await context.request.get(customerServer.url + '/firebase-messaging-worker.js'); assert.match(worker.headers()['content-type'], /javascript/);
  // A signed-out deep link returns to its exact order after authenticating.
  holdOrders = true;
  await second.getByRole('button', { name: 'Account', exact: true }).click();
  await second.getByRole('button', { name: 'Your orders', exact: true }).click();
  await second.getByRole('button', { name: 'Refresh orders', exact: true }).click();
  for (let i = 0; i < 50 && !orderHeld; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(orderHeld, true);
  await account(second); await second.getByRole('button', { name: 'Sign out', exact: true }).click();
  await second.getByLabel('Email', { exact: true }).filter({ visible: true }).waitFor();
  holdOrders = false; releaseOrders();
  await second.waitForTimeout(100);
  assert.equal(await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).count(), 0);
  await second.goto(customerServer.url + '/orders/' + orderId, { waitUntil: 'networkidle' });
  await second.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email);
  await second.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
  await second.getByRole('button', { name: 'Sign in', exact: true }).click();
  await second.getByText('Order ' + orderId.slice(0, 8), { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(new URL(second.url()).pathname, '/orders/' + orderId);
  await second.setViewportSize({ width: 1440, height: 900 });
  await second.screenshot({ path: 'dist/browser/customer-order-desktop.png', fullPage: true });
  console.log('PASS: deep-link reload/login return, missing-order state, browser back with draft retention, drawer keyboard focus and asset exclusions');

  const admin = await context.newPage(); admin.on('pageerror', error => errors.push(error.message));
  await admin.goto(adminServer.url, { waitUntil: 'networkidle' });
  await signIn(admin);
  await admin.getByText('Access denied', { exact: true }).filter({ visible: true }).waitFor();
  adminAllowed = true;
  await admin.reload({ waitUntil: 'networkidle' });
  await admin.getByText('Order queue', { exact: true }).filter({ visible: true }).waitFor();
  await admin.getByRole('button', { name: 'View details', exact: true }).click();
  await admin.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await focused(admin, `Cancel order ${orderId}?`);
  await admin.getByRole('button', { name: 'Keep order', exact: true }).click();
  await focused(admin, 'Cancel order');
  assert.equal(mutations.length, 0);
  await admin.getByRole('button', { name: 'Mark accepted', exact: true }).click();
  await admin.getByText('Order updated to Accepted.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[0].p_status, 'accepted');
  await admin.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await admin.getByText('Order updated to Cancelled.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[1].p_status, 'cancelled');
  await admin.getByRole('button', { name: 'Menu', exact: true }).click();
  await admin.getByRole('button', { name: 'Add item', exact: true }).click();
  await admin.getByLabel('Name', { exact: true }).filter({ visible: true }).fill('Test dish');
  await admin.getByLabel('Category', { exact: true }).filter({ visible: true }).fill('Meals');
  await admin.getByLabel('Price in rupees', { exact: true }).filter({ visible: true }).fill('123.45');
  await admin.getByRole('button', { name: 'Save item', exact: true }).click();
  const addDialog = admin.getByRole('dialog');
  await addDialog.getByRole('alert').getByText(/Fixture save failure/).waitFor();
  assert.equal(await addDialog.getByLabel('Name', { exact: true }).filter({ visible: true }).inputValue(), 'Test dish');
  assert.equal(await addDialog.getByLabel('Category', { exact: true }).filter({ visible: true }).inputValue(), 'Meals');
  assert.equal(await addDialog.getByLabel('Price in rupees', { exact: true }).filter({ visible: true }).inputValue(), '123.45');
  await admin.getByRole('button', { name: 'Save item', exact: true }).click();
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).waitFor();
  assert.equal(mutations[2].price_paise, 12345);
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).click();
  await focused(admin, 'Edit item');
  assert.equal(await admin.getByRole('dialog').getByRole('alert').count(), 0);
  await admin.getByRole('button', { name: 'Cancel', exact: true }).click();
  await focused(admin, 'Edit Test dish');
  await admin.getByRole('button', { name: 'Edit Test dish', exact: true }).click();
  await admin.getByLabel('Price in rupees', { exact: true }).filter({ visible: true }).fill('125.67');
  await admin.getByRole('button', { name: 'Save item', exact: true }).click();
  await admin.getByText('Meals · ₹125.67', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(mutations[3].price_paise, 12567);
  await admin.getByRole('button', { name: 'Delete Test dish', exact: true }).click();
  await focused(admin, 'Delete Test dish?');
  await admin.getByRole('button', { name: 'Keep item', exact: true }).click();
  await focused(admin, 'Delete Test dish');
  await admin.getByRole('button', { name: 'Delete Test dish', exact: true }).click();
  await admin.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await admin.getByRole('dialog').getByRole('alert').getByText(/Fixture delete failure/).waitFor();
  await admin.getByRole('button', { name: 'Keep item', exact: true }).click();
  await admin.getByRole('button', { name: 'Delete Test dish', exact: true }).click();
  assert.equal(await admin.getByRole('dialog').getByRole('alert').count(), 0);
  await admin.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await admin.getByText('Item deleted.', { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(menuItems.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(externalSockets, []);
  permissionRequests += await first.evaluate(() => window.__permissionRequests || 0);
  permissionRequests += await admin.evaluate(() => window.__permissionRequests || 0);
  assert.equal(permissionRequests, 0);
  console.log('PASS: admin membership, order transition, cancellation and menu CRUD');
} finally { await context?.close(); await browser?.close(); await customerServer?.close(); await adminServer?.close(); }
