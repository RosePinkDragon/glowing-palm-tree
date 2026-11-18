import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// Actual exports → installed SDK → deterministic scoped HTTP fixture → drawer/detail.
const api = 'https://market-fixture.supabase.co';
const userId = '51000000-0000-4000-8000-000000000001';
const otherUser = '51000000-0000-4000-8000-000000000002';
const orderId = n => `52000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Support shows the order number, or the order page's short reference (last 6 of the id) for older orders.
const ref = n => n === 25 || n === 2 ? `TEST-202611150${String(n).padStart(2, '0')}` : orderId(n).slice(-6);
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'account-fixture@example.test', user_metadata: {}, app_metadata: {} };
const token = part({ alg: 'HS256' }) + '.' + part({ sub: userId, role: 'authenticated', session_id: '53000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now()/1000)+3600 }) + '.fixture';
const session = { access_token: token, refresh_token: 'account-fixture', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, token_type: 'bearer', user };

async function supportScenarios({ page, context, server, slug, rows, fixture, queries }) {
  const selected = page.locator('#support-order');
  const privacy = () => page.getByRole('heading', { name: 'Draft privacy policy', exact: true });
  const login = async () => {
    await page.goto(server.url + '/help', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Sign in to see orders', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(fixture.authSession?.user.email ?? user.email); await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh active orders', exact: true }).waitFor();
  };
  assert.equal((await page.goto(server.url + '/help', { waitUntil: 'networkidle' })).status(), 200);
  const script = await page.locator('script[src]').first().getAttribute('src');
  for (const path of [script, '/firebase-messaging-worker.js']) {
    const asset = await context.request.get(new URL(path, server.url).href);
    assert.equal(asset.status(), 200); assert.match(asset.headers()['content-type'], /javascript/);
  }
  assert.equal((await context.request.get(server.url + '/missing-support-fixture.js')).status(), 404, 'unknown assets cannot return the SPA document');
  await page.getByRole('button', { name: 'Sign in to see orders', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/help');
  assert.equal(await page.getByRole('button', { name: 'Call restaurant', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'WhatsApp restaurant', exact: true }).count(), 0);
  await page.getByText('Contact number not available yet.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Good food starts here.', { exact: true }).filter({ visible: true }).count(), 0);
  const questions = [
    ['Where do you deliver?', 'device’s current location'],
    ['How can I pay?', 'cash on delivery'],
    ['Can I cancel or change my order?', 'does not currently offer customer cancellation'],
    ['What if a dish is unavailable?', 'Reorder skips dishes'],
    ['Why have I not received a login code?', 'Phone login codes are not available'],
    ['How do I delete my account?', 'Account deletion is not yet available'],
  ];
  for (const [question, answer] of questions) {
    const disclosure = page.getByRole('button', { name: question, exact: true });
    await disclosure.focus(); await page.keyboard.press('Enter');
    await page.getByRole('region').getByText(answer, { exact: false }).waitFor();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Space'); await page.getByRole('region').waitFor({ state: 'hidden' }); assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  }
  await page.getByRole('button', { name: 'Privacy policy', exact: true }).click(); await privacy().waitFor();
  assert.equal(new URL(page.url()).pathname, '/privacy');
  await page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement?.textContent === 'Privacy policy');
  await page.goBack(); await page.getByRole('heading', { name: 'Common questions', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Terms', exact: true }).click();
  await page.getByRole('heading', { name: 'Draft terms', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to Help & support', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in to see orders', exact: true }).waitFor();
  for (const path of ['/privacy', '/terms']) {
    assert.equal((await page.goto(server.url + path, { waitUntil: 'networkidle' })).status(), 200);
    await page.getByText('Draft · owner review required before deployment', { exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, path);
    await page.getByRole('button', { name: 'Back to Help & support', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/help');
  }
  fixture.supportRows = [];
  await login(); await page.getByText('No active orders right now.', { exact: false }).waitFor();
  fixture.supportRows = rows.map(row => ({ ...row, status: 'preparing' }));
  fixture.failActive = true;
  await page.getByRole('button', { name: 'Refresh active orders', exact: true }).click();
  await page.getByRole('button', { name: 'Retry active orders', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Common questions', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Call restaurant', exact: true }).isDisabled(), true);
  fixture.failActive = false; await page.getByRole('button', { name: 'Retry active orders', exact: true }).click();
  await selected.getByText(ref(25), { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Select order reference / }).count(), 20);
  assert.ok(queries.some(url => url.searchParams.get('status') === 'in.(placed,accepted,preparing,out_for_delivery)'), 'Help uses the independent active-only API');
  await page.getByRole('button', { name: `Select order reference ${ref(24)}`, exact: true }).click();
  await selected.getByText(ref(24), { exact: true }).waitFor();
  fixture.failActiveMore = true;
  await page.getByRole('button', { name: 'Load more active orders', exact: true }).click();
  await page.getByRole('button', { name: 'Retry more active orders', exact: true }).waitFor();
  await selected.getByText(ref(24), { exact: true }).waitFor();
  fixture.failActiveMore = false; await page.getByRole('button', { name: 'Retry more active orders', exact: true }).click();
  await page.getByRole('button', { name: `Select order reference ${ref(1)}`, exact: true }).waitFor();
  const live = async changed => {
    for (const channel of fixture.orderChannels.values()) {
      const payload = { ids: [1], data: { schema: 'public', table: 'orders', type: 'UPDATE', commit_timestamp: new Date().toISOString(), columns: [], record: changed, old_record: {} } };
      channel.socket.send(JSON.stringify(channel.array ? [channel.join, null, channel.topic, 'postgres_changes', payload] : { join_ref: channel.join, ref: null, topic: channel.topic, event: 'postgres_changes', payload }));
    }
  };
  const changed = fixture.supportRows.find(row => row.id === orderId(24));
  changed.status = 'out_for_delivery'; changed.version++;
  await live(changed); await selected.getByText('Status: out for delivery', { exact: true }).waitFor();
  changed.status = 'delivered'; changed.version++;
  await live(changed); await selected.getByText(ref(25), { exact: true }).waitFor();
  await page.getByText('The previously selected order is no longer active.', { exact: false }).waitFor();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await selected.scrollIntoViewIfNeeded();
    assert.equal(await selected.evaluate(node => node.scrollWidth <= node.clientWidth), true, 'full UUID wraps at narrow widths');
    await page.screenshot({ path: `dist/browser/${slug}-support-${width}.png`, fullPage: true });
  }
  await page.goto(server.url + '/orders/' + orderId(25), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Help & support', exact: true }).click();
  await page.getByText('You opened Help for this order reference:', { exact: true }).waitFor();
  await selected.getByText(ref(25), { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('id'), orderId(25));
  assert.equal(await page.getByText('You opened Help for this order reference:', { exact: true }).locator('xpath=following-sibling::*[1]').innerText(), ref(25), 'the opened-from line shows the order number');
  assert.equal(await page.getByText(orderId(25), { exact: true }).count(), 0, 'the raw order id is never shown');
  // A delivered order is not in the active list: Help still shows its order number, not the short fallback.
  await page.goto(server.url + '/orders/' + orderId(2), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Help & support', exact: true }).click();
  await page.getByText('You opened Help for this order reference:', { exact: true }).waitFor();
  await page.getByText('You opened Help for this order reference:', { exact: true }).locator('xpath=following-sibling::*[1]').getByText(ref(2), { exact: true }).waitFor();
  assert.equal(await page.getByText(orderId(2), { exact: true }).count(), 0, 'the raw order id is never shown for a delivered order');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Help & support', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(new URL(page.url()).pathname, '/help');
  assert.equal(await page.getByText('You opened Help for this order reference:', { exact: true }).count(), 0, 'general Help clears the originating reference');
  await page.goto(server.url + '/orders/' + orderId(25), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Help & support', exact: true }).click();
  await page.getByText('You opened Help for this order reference:', { exact: true }).waitFor();
  await selected.getByText(ref(25), { exact: true }).waitFor();
  let release, arrived;
  const pending = new Promise(resolve => { arrived = resolve; });
  fixture.holdActive = { gate: new Promise(resolve => { release = resolve; }), arrived };
  await page.getByRole('button', { name: 'Refresh active orders', exact: true }).click(); await pending;
  const other = await context.newPage(); await other.goto(server.url + '/account', { waitUntil: 'networkidle' });
  await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in to see orders', exact: true }).waitFor();
  assert.equal(await selected.count(), 0, 'logout removes private support data before pending requests resolve');
  assert.equal(await page.getByText('You opened Help for this order reference:', { exact: true }).count(), 0, 'logout also removes the originating private reference');
  release(); await page.getByRole('heading', { name: 'Common questions', exact: true }).waitFor();
  fixture.authSession = { ...session, access_token: part({ alg: 'HS256' }) + '.' + part({ sub: otherUser, role: 'authenticated', session_id: '53000000-0000-4000-8000-000000000002', exp: Math.floor(Date.now()/1000)+3600 }) + '.fixture', user: { ...user, id: otherUser, email: 'other-fixture@example.test' } };
  fixture.supportRows = []; await login();
  await page.getByText('No active orders right now.', { exact: false }).waitFor();
  assert.equal(await selected.count(), 0, 'a different account cannot restore the prior account’s selected order');
  await other.reload({ waitUntil: 'networkidle' }); await other.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in to see orders', exact: true }).waitFor();
  await other.close(); fixture.supportRows = null; fixture.authSession = null;
  console.log(`PASS: ${slug} public support/FAQ/legal/back, independent active paging/retry/selection, realtime terminal transition, identity isolation, mobile/desktop layouts`);
}

async function reorderScenarios({ page, context, server, slug, item, rows, fixture }) {
  const key = `market:cart:${slug}`, checkoutKey = `market:checkout:${slug}`;
  const target = rows.find(row => row.id === orderId(24));
  target.order_items = [{ ...target.order_items[0], quantity: 2, line_total_paise: 20000 }, { ...target.order_items[0], menu_item_id: '55000000-0000-4000-8000-000000000099', name: 'Removed curry' }];
  const raw = () => page.evaluate(key => localStorage.getItem(key), key);
  const saved = async () => JSON.parse(await raw());
  const seed = async lines => {
    await page.evaluate(({ key, lines }) => {
      const old = JSON.parse(localStorage.getItem(key));
      const value = JSON.stringify({ ...old, revision: old.revision + 1, lines });
      localStorage.setItem(key, value); window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    }, { key, lines });
    await page.waitForFunction(({ count }) => {
      const cart = Array.from(document.querySelectorAll('[role="button"]')).find(node => /^Cart \(/.test(node.textContent));
      return count ? cart?.textContent?.startsWith(`Cart (${count})`) : !cart;
    }, { count: lines.reduce((n, line) => n + line.quantity, 0) });
  };
  const detail = async () => { await page.goto(server.url + '/orders/' + target.id, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: 'Order this again for order 000024', exact: true }).waitFor(); };
  // The account drawer's card says Reorder; the order page says Order this again (#47).
  const reorder = () => page.getByRole('button', { name: /^(Reorder order|Order this again for order) 000024$/ }).click();
  const panelFocused = () => page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement?.textContent === 'Reorder');
  const choice = async () => { await reorder(); await page.getByRole('button', { name: 'Replace cart', exact: true }).waitFor(); await panelFocused(); };
  const cancel = async () => { await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await page.getByRole('heading', { name: 'Reorder', exact: true }).waitFor({ state: 'hidden' }); };
  const heldMenu = () => {
    let release, arrived;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { arrived = resolve; });
    fixture.holdMenu = { gate, arrived }; return { pending, release };
  };
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.goto(server.url, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Meals', exact: true }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click(); await settledDrawer(page);
  const initial = await raw(), gate = heldMenu();
  await reorder(); await gate.pending;
  await page.getByText('Checking the current menu', { exact: true }).waitFor();
  await panelFocused();
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reorder order 000024');
  gate.release(); assert.equal(await raw(), initial, 'cancel while fetching preserves draft and restores the drawer trigger');
  const freshItem = { ...item, price_paise: 17500, category_id: '56000000-0000-4000-8000-000000000002', menu_categories: { name: 'Fresh meals', sort_order: 0 } };
  fixture.menu = [freshItem];
  await reorder();
  await page.getByText(/Reorder added to your cart at current menu prices/).waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Reorder added to your cart'));
  let current = await saved(); assert.equal(current.lines[0].quantity, 2); assert.equal(current.lines[0].item.pricePaise, 17500);
  await page.getByText(/Skipped unavailable dishes: Removed curry/).waitFor();
  await page.goBack(); await page.getByRole('button', { name: 'Fresh meals', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'All dishes', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.locator('#regular-menu').getByText('Account fixture meal', { exact: true }).waitFor();
  await page.goForward(); await page.getByRole('button', { name: 'Add one Account fixture meal', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add one Account fixture meal', exact: true }).click();
  // The cart page has no separate cart bar; wait until the added dish is saved (three in total).
  for (let i = 0; i < 100 && (await saved()).lines.reduce((total, line) => total + line.quantity, 0) !== 3; i++) await page.waitForTimeout(100);
  current = await saved(); assert.equal(current.lines[0].item.pricePaise, 17500, 'cached-menu reconciliation cannot restore the old price after import');
  await detail();
  const existing = await raw(); await choice();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.getByRole('button', { name: 'Cancel', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `dist/browser/${slug}-reorder-choice-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await cancel(); assert.equal(await raw(), existing, 'Cancel leaves existing cart byte-for-byte unchanged');
  await choice(); await page.keyboard.press('Escape'); await page.getByRole('heading', { name: 'Reorder', exact: true }).waitFor({ state: 'hidden' }); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Order this again for order 000024');
  assert.equal(await raw(), existing, 'Escape leaves existing cart unchanged');
  await choice(); await page.evaluate(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await page.getByRole('heading', { name: 'Reorder', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Order this again for order 000024');
  assert.equal(await raw(), existing, 'browser back dismissal leaves the cart unchanged');
  await choice(); await page.getByRole('button', { name: 'Add to cart', exact: true }).evaluate(button => { button.click(); button.click(); });
  await page.getByText(/Reorder added to your cart at current menu prices/).filter({ visible: true }).waitFor();
  assert.equal((await saved()).lines[0].quantity, 5);
  await detail(); await choice(); await page.getByRole('button', { name: 'Replace cart', exact: true }).click();
  await page.getByText(/Reorder replaced your cart/).waitFor(); assert.equal((await saved()).lines[0].quantity, 2);
  // With the same mounted cached catalog, all unavailable leaves the existing draft intact.
  await detail(); fixture.menu = []; const unavailable = await raw(); await reorder();
  await page.getByText('No dishes available to reorder', { exact: true }).waitFor(); assert.equal(await raw(), unavailable); await cancel();
  fixture.menu = [freshItem];
  const base = (await saved()).lines[0]; await seed([{ ...base, quantity: 9 }]);
  await choice(); const overQuantity = await raw(); await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByText(/Quantity must be a whole number from 1 to 10/).waitFor(); assert.equal(await raw(), overQuantity);
  assert.equal(await page.getByRole('button', { name: 'Replace cart', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Replace cart', exact: true }).click(); await page.getByText(/Reorder replaced your cart/).waitFor();
  await detail(); const twenty = Array.from({ length: 20 }, (_, n) => ({ item: { ...base.item, id: `synthetic-distinct-${n}`, name: `Existing dish ${n}` }, quantity: 1 }));
  await seed(twenty); await choice(); const overDistinct = await raw(); await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await page.getByText(/at most 20 distinct items/).waitFor(); assert.equal(await raw(), overDistinct); await cancel();
  await seed([base]); await choice(); const beforeFailure = await raw();
  await page.evaluate(() => { window.__failCartWrites = true; }); await page.getByRole('button', { name: 'Replace cart', exact: true }).click();
  await page.getByText('Reorder not saved', { exact: true }).waitFor(); assert.equal(await raw(), beforeFailure); assert.equal(new URL(page.url()).pathname, '/orders/' + target.id);
  await page.evaluate(() => { window.__failCartWrites = false; }); await cancel();
  await page.getByRole('button', { name: 'Retry saved cart', exact: true }).click();
  // An unresolved submitted checkout blocks reorder, without rewriting its frozen key/snapshot.
  const attempt = { version: 2, businessId: slug, userId, idempotencyKey: 'frozen-reorder-fixture', lines: [base], delivery: target.delivery ?? { name: 'Synthetic', phone: '9000000000' }, savedAddress: { id: '48200000-0000-4000-8000-000000000001', version: 1 }, location: { latitude: 17.7, longitude: 73.4, accuracy: 5, capturedAtISO: '2026-11-15T00:00:00Z' }, pricing: { lines: [], delivery_fee_paise: 0, min_order_paise: 0, subtotal_paise: 0, total_paise: 0 } };
  const frozen = JSON.stringify(attempt);
  await page.evaluate(({ key, value }) => { localStorage.setItem(key, value); window.dispatchEvent(new StorageEvent('storage', { key, newValue: value })); }, { key: checkoutKey, value: frozen });
  const pendingCart = await raw(); await reorder(); await page.getByText(/Recover your order awaiting confirmation before reordering/).waitFor();
  assert.equal(await raw(), pendingCart); assert.equal(await page.evaluate(key => localStorage.getItem(key), checkoutKey), frozen); await cancel();
  await page.evaluate(key => { localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage', { key, newValue: null })); }, checkoutKey);
  // A second tab changes the reviewed cart. Both visible events and delayed events must fail closed.
  const other = await context.newPage(); await other.goto(server.url + '/orders/' + target.id, { waitUntil: 'networkidle' });
  await other.getByRole('button', { name: 'Order this again for order 000024', exact: true }).waitFor();
  await choice();
  const addInOther = () => other.evaluate(key => { const value = JSON.parse(localStorage.getItem(key)); value.revision++; value.lines[0].quantity++; localStorage.setItem(key, JSON.stringify(value)); }, key);
  await addInOther(); await page.getByRole('button', { name: 'Review current cart', exact: true }).waitFor();
  const crossTab = await raw(); assert.equal(await page.getByRole('button', { name: 'Replace cart', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Review current cart', exact: true }).click(); await page.getByRole('button', { name: 'Replace cart', exact: true }).waitFor();
  await page.evaluate(() => { window.__delayCartEvents = true; }); await addInOther(); const delayed = await raw();
  await page.getByRole('button', { name: 'Replace cart', exact: true }).click(); await page.getByRole('button', { name: 'Review current cart', exact: true }).waitFor();
  assert.notEqual(delayed, crossTab); assert.equal(await raw(), delayed, 'locked revision check rejects a delayed cross-tab event'); await cancel();
  await page.evaluate(() => { window.__delayCartEvents = false; });
  // A tab can add while a menu request started from an empty cart is outstanding.
  await seed([]); const raced = heldMenu(); await reorder(); await raced.pending;
  await other.evaluate(({ key, line }) => { const value = JSON.parse(localStorage.getItem(key)); value.revision++; value.lines = [line]; localStorage.setItem(key, JSON.stringify(value)); }, { key, line: base });
  raced.release(); await page.getByRole('button', { name: 'Review current cart', exact: true }).waitFor();
  assert.deepEqual((await saved()).lines, [base]); await cancel();
  await seed([]); await page.evaluate(() => { window.__delayCartEvents = true; });
  const delayedEmpty = heldMenu(); await reorder(); await delayedEmpty.pending;
  await other.evaluate(({ key, line }) => { const value = JSON.parse(localStorage.getItem(key)); value.revision++; value.lines = [line]; localStorage.setItem(key, JSON.stringify(value)); }, { key, line: base });
  delayedEmpty.release(); await page.getByRole('button', { name: 'Replace cart', exact: true }).waitFor();
  assert.deepEqual((await saved()).lines, [base], 'fresh locked review prompts instead of replacing an unseen addition'); await cancel();
  await page.evaluate(() => { window.__delayCartEvents = false; });
  // Logout while a fresh-menu fetch is outstanding cannot resurrect the old account's cart.
  const identityGate = heldMenu(); await reorder(); await identityGate.pending;
  await other.getByRole('button', { name: 'Account', exact: true }).click();
  await other.getByRole('button', { name: 'Account options', exact: true }).click(); await other.getByRole('button', { name: 'Log out', exact: true }).first().click();
  identityGate.release(); await page.getByRole('heading', { name: 'Reorder', exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).ownerId === null, key);
  assert.deepEqual((await saved()).lines, []); await other.close();
  console.log(`PASS: ${slug} reorder fresh prices/skips, drawer layer/focus, empty/Add/Replace/Cancel, atomic limits/storage, pending checkout, identity and cross-tab races`);
}

const settledDrawer = async page => {
  const phone = page.getByText('Phone not added', { exact: true });
  await phone.scrollIntoViewIfNeeded();
  await phone.evaluate(node => new Promise((resolve, reject) => {
    let last = null, stable = 0;
    const timeout = setTimeout(() => reject(new Error('Drawer did not settle in the viewport')), 5000);
    const frame = () => {
      const rect = node.getBoundingClientRect();
      stable = last !== null && Math.abs(rect.x - last) < 0.1 && rect.left >= 0 && rect.right <= innerWidth ? stable + 1 : 0;
      last = rect.x;
      if (stable >= 4) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(frame);
    }; frame();
  }));
};
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const errors = [], queries = [];
    const businessId = `54000000-0000-4000-8000-00000000000${brand+1}`;
    const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const item = { id: '55000000-0000-4000-8000-000000000001', name: 'Account fixture meal', description: '', category_id: '56000000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const fixture = { menu: [item], holdMenu: null, supportRows: null, failActive: false, failActiveMore: false, holdActive: null, authSession: null, orderChannels: new Map() };
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: orderId(index+1), ...(index === 24 || index === 1 ? { order_number: ref(index + 1) } : {}), business_id: businessId, customer_id: userId, status: index === 24 ? 'preparing' : 'delivered', version: 1, created_at: '2026-11-15T10:00:00.123456Z', subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: 'Synthetic', customer_phone: '9000000000', delivery_address_line: 'Synthetic Khed address', order_items: [{ menu_item_id: item.id, diet: null, name: `History meal ${index+1}`, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [] }));
    let failOlder = true, failDetail = false, holdOrders = false, held, release;
    await context.routeWebSocket(/.*/, socket => {
      socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index + 1 })) } };
        if (event === 'phx_join' && payload?.config?.postgres_changes?.some(value => value.table === 'orders')) fixture.orderChannels.set(topic, { socket, join, topic, array });
        if (event === 'phx_leave') fixture.orderChannels.delete(topic);
        if (event === 'phx_join' || event === 'heartbeat' || event === 'phx_leave') socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.fallback();
      assert.equal(url.origin, api, 'no third-party requests without consent');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/auth/v1/token') return json(fixture.authSession ?? session);
      if (url.pathname === '/auth/v1/user') return json(fixture.authSession?.user ?? user);
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') { const hold = fixture.holdMenu; fixture.holdMenu = null; if (hold) { hold.arrived(); await hold.gate; } return json(fixture.menu); }
      if (url.pathname === '/rest/v1/rpc/list_addresses') return json([]);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/orders') {
        queries.push(url);
        assert.equal(url.searchParams.get('business_id'), 'eq.' + businessId);
        assert.equal(url.searchParams.get('customer_id'), 'eq.' + (fixture.authSession?.user.id ?? userId));
        if (holdOrders) { holdOrders = false; held?.(); await new Promise(resolve => { release = resolve; }); }
        const id = url.searchParams.get('id');
        if (id) return failDetail ? json({ message: 'Detail fixture unavailable' }, 400) : json(rows.find(row => row.id === id.slice(3)) ?? null);
        const cursor = url.searchParams.get('or');
        const active = url.searchParams.has('status');
        const capturedRows = [...(active && fixture.supportRows !== null ? fixture.supportRows : rows)].filter(row => row.customer_id === (fixture.authSession?.user.id ?? userId));
        if (active) {
          assert.equal(url.searchParams.get('status'), 'in.(placed,accepted,preparing,out_for_delivery)');
          const hold = fixture.holdActive; fixture.holdActive = null; if (hold) { hold.arrived(); await hold.gate; }
          if (fixture.failActive || cursor && fixture.failActiveMore) return json({ message: 'Active order fixture unavailable' }, 400);
        }
        if (!active && cursor && failOlder) return json({ message: 'Older history fixture unavailable' }, 400);
        let result = capturedRows;
        if (active) result = result.filter(row => ['placed', 'accepted', 'preparing', 'out_for_delivery'].includes(row.status));
        if (cursor) {
          const parts = /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)\)$/.exec(cursor);
          assert.ok(parts); result = result.filter(row => row.created_at < parts[1] || (row.created_at === parts[1] && row.id < parts[3]));
        }
        assert.equal(url.searchParams.get('order'), 'created_at.desc,id.desc');
        result.sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        return json(result.slice(0, Number(url.searchParams.get('limit'))));
      }
      if (url.pathname === '/rest/v1/customer_businesses') return json([]);
      throw new Error(`Unexpected account request ${url.pathname}`);
    });
    await context.addInitScript(() => {
      const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window), listeners = new WeakMap();
      window.addEventListener = function(type, listener, options) {
        if (type !== 'storage' || !listener) return add(type, listener, options);
        const wrapped = event => { if (window.__delayCartEvents && event.key?.startsWith('market:cart:')) return; if (typeof listener === 'function') listener.call(window, event); else listener.handleEvent(event); };
        listeners.set(listener, wrapped); return add(type, wrapped, options);
      };
      window.removeEventListener = function(type, listener, options) { return remove(type, type === 'storage' && listener ? listeners.get(listener) ?? listener : listener, options); };
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('market:cart:') && window.__failCartWrites) throw new DOMException('Synthetic cart storage failure', 'QuotaExceededError'); return set.call(this, key, value); };
    });
    try {
      if (process.env.SUPPORT_ONLY === '1') {
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        try { await supportScenarios({ page, context, server, slug, rows, fixture, queries }); }
        catch (error) { await page.screenshot({ path: `dist/browser/${slug}-support-failure.png`, fullPage: true }); throw error; }
        assert.deepEqual(errors, []); continue;
      }
      if (process.env.REORDER_ONLY === '1') {
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        try { await reorderScenarios({ page, context, server, slug, item, rows, fixture }); }
        catch (error) {
          await page.screenshot({ path: `dist/browser/${slug}-reorder-failure.png`, fullPage: true });
          console.error('Reorder focus at failure:', await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.slice(0, 180), label: document.activeElement?.getAttribute('aria-label') })));
          throw error;
        }
        assert.deepEqual(errors, []); continue;
      }
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByLabel('Email', { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/login');
      assert.equal(await page.getByText('Past orders', { exact: true }).count(), 0);
      await page.getByLabel('Email', { exact: true }).fill(user.email);
      await page.getByLabel('Password', { exact: true }).fill('synthetic-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByText('Phone not added', { exact: true }).waitFor();
      await page.getByText('20 orders loaded', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === 'Your account');
      await page.keyboard.press('Shift+Tab');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Browse menu');
      await page.keyboard.press('Tab'); await page.waitForFunction(() => document.activeElement?.textContent === '×');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => document.activeElement?.textContent === 'Account');
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByText('Phone not added', { exact: true }).waitFor();
      await settledDrawer(page);
      await page.screenshot({ path: `dist/browser/${slug}-account-mobile.png`, fullPage: true });
      // With a next cursor still present, background refresh owns the window:
      // paging stays disabled and cannot cancel it or remove already visible cards.
      const backgroundHeld = new Promise(resolve => { held = resolve; }); holdOrders = true;
      await page.getByRole('button', { name: 'Refresh orders', exact: true }).click(); await backgroundHeld;
      await page.getByText('20 orders loaded', { exact: true }).waitFor();
      const paging = page.getByRole('button', { name: /^(Load|Retry) older orders$/ });
      assert.equal(await paging.isDisabled(), true);
      const heldCount = queries.length;
      await paging.evaluate(node => node.click());
      await page.waitForTimeout(50);
      assert.equal(queries.length, heldCount, 'disabled paging cannot supersede an in-flight refresh');
      assert.equal(await page.getByText('1 × History meal 25 · ₹100', { exact: true }).count(), 1);
      release?.();
      await page.waitForFunction(() => { const button = Array.from(document.querySelectorAll('[role="button"]')).find(node => /^(Load|Retry) older orders$/.test(node.textContent)); return button && button.getAttribute('aria-disabled') !== 'true'; });
      await page.getByRole('button', { name: /^(Load|Retry) older orders$/ }).scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: 'Retry older orders', exact: true }).waitFor();
      await page.getByText('History meal 25', { exact: false }).waitFor();
      failOlder = false;
      await page.getByRole('button', { name: 'Retry older orders', exact: true }).click();
      await page.getByText('25 orders loaded', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Track order/ }).count(), 1);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.goto(server.url + '/orders/' + orderId(1), { waitUntil: 'networkidle' });
      await page.getByText('1 × History meal 1', { exact: false }).first().waitFor();
      assert.ok(queries.some(url => url.searchParams.get('id') === 'eq.' + orderId(1)));
      failDetail = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('Detail fixture unavailable', { exact: false }).waitFor();
      failDetail = false;
      await page.getByRole('button', { name: 'Retry orders', exact: true }).click();
      await page.getByText('1 × History meal 1', { exact: false }).first().waitFor();
      await page.goto(server.url + '/orders/' + orderId(999), { waitUntil: 'networkidle' });
      await page.getByText("We can't show this order", { exact: true }).waitFor();
      for (const [label, text] of [['Saved addresses', 'No saved addresses yet'], ['Notifications', 'Your notification inbox is not available yet.'], ['Help & support', 'Contact number not available yet.']]) {
        await page.getByRole('button', { name: 'Account', exact: true }).click();
        await page.getByRole('button', { name: label, exact: true }).click();
        await page.getByText(text, { exact: false }).waitFor();
      }
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByRole('button', { name: 'Account options', exact: true }).click();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
      await page.getByText('Profile editing is not available yet.', { exact: false }).waitFor();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByText('Phone not added', { exact: true }).waitFor();
      await settledDrawer(page);
      await page.screenshot({ path: `dist/browser/${slug}-account-desktop.png`, fullPage: true });
      await page.getByRole('button', { name: 'Account options', exact: true }).click();
      await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Edit profile', exact: true }).waitFor({ state: 'hidden' });
      await page.getByText('Phone not added', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === '⋮');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Account');
      await page.goBack();
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.textContent === 'Account');
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      const waitForHeld = new Promise(resolve => { held = resolve; }); holdOrders = true;
      await page.getByRole('button', { name: 'Refresh orders', exact: true }).click(); await waitForHeld;
      await page.getByRole('button', { name: 'Account options', exact: true }).click();
      await page.getByRole('button', { name: 'Log out', exact: true }).first().click();
      release?.();
      await page.waitForTimeout(100);
      assert.equal(await page.getByText('Phone not added', { exact: true }).count(), 0);
      assert.equal(await page.getByText('1 × History meal 25 · ₹100', { exact: true }).filter({ visible: true }).count(), 0);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByLabel('Email', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} guest login, scoped paged drawer, retry, old detail, focus, placeholders and logout isolation`);
      await supportScenarios({ page, context, server, slug, rows, fixture, queries });
      await reorderScenarios({ page, context, server, slug, item, rows, fixture });
      assert.deepEqual(errors, []);
    } finally { release?.(); await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
