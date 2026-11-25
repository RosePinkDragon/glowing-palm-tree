import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #204: removing a dish's last unit offers an accessible Undo, in the menu and in the cart, in both brands.
// Synthetic fixtures only; the cart is the guest cart in localStorage.
const api = 'https://market-fixture.supabase.co';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const category = { id: '20400000-0000-4000-8000-000000000001', name: 'Meals', sort_order: 1 };
const dish = (n, name) => ({ id: `20400000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name, description: 'Synthetic fixture dish for browser checks.', diet: 'veg', category_id: category.id, menu_categories: { name: category.name, sort_order: 1 }, price_paise: 10000 + n * 1000, available: true, is_demo: false, is_featured: false, sort_order: n, image_url: null });
const menu = [dish(1, 'Veg thali'), dish(2, 'Chicken thali'), dish(3, 'Misal pav')];
const [A, B, C] = menu.map(item => item.name);

for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
  const name = slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn';
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const business = { id: '20400000-0000-4000-8000-0000000000aa', slug, name, delivery_fee_paise: 3000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.clock.install();
  await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const data = JSON.parse(String(message)), array = Array.isArray(data);
    const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
    const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
    if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
  }));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === server.url) return route.fallback();
    assert.equal(url.origin, api, 'no unconfigured third-party calls');
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
    if (url.pathname === '/rest/v1/businesses') return json(business);
    if (url.pathname === '/rest/v1/menu_items') return json(menu);
    if (url.pathname === '/rest/v1/menu_categories') return json([category]);
    if (url.pathname === '/auth/v1/user' || url.pathname === '/rest/v1/orders') return json(url.pathname === '/rest/v1/orders' ? [] : null);
    throw new Error(`Unexpected fixture ${route.request().method()} ${url.pathname}`);
  });
  const open = async () => { const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); await page.goto(server.url, { waitUntil: 'networkidle' }); await page.getByRole('heading', { name, level: 1 }).waitFor(); return page; };
  const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{"lines":[]}').lines.map(line => [line.item.name, line.quantity]), `market:cart:${slug}`);
  // The cart is saved a moment after the tap, so wait for the expected contents before asserting them.
  const expectCart = async (page, expected, message) => { let seen; for (let i = 0; i < 50; i++) { seen = await saved(page); if (JSON.stringify(seen) === JSON.stringify(expected)) break; await page.waitForTimeout(100); } assert.deepEqual(seen, expected, message); };
  const undoButton = (page, dishName) => page.getByRole('button', { name: `Undo removing ${dishName}`, exact: true });
  const announcer = page => page.locator('[role="status"][aria-live="polite"]').filter({ hasText: /Removed|Restored/ }).filter({ visible: true });
  const add = async (page, count) => { for (let i = 0; i < count; i++) { await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click(); await page.waitForFunction(expected => JSON.parse(localStorage.getItem(`market:cart:${expected.slug}`) || '{"lines":[]}').lines.length === expected.n, { slug, n: i + 1 }); } };
  const menuRemove = async (page, dishName) => { await page.getByRole('button', { name: `Remove one ${dishName}`, exact: true }).first().click(); };
  try {
    const page = await open();
    // Menu: add two dishes, then take the last unit of the first away.
    await add(page, 2);
    await expectCart(page, [[A, 1], [B, 1]]);
    await page.getByRole('button', { name: `Add one ${A}`, exact: true }).click();
    await page.getByRole('button', { name: `Remove one ${A}`, exact: true }).click();
    assert.equal(await undoButton(page, A).count(), 0, 'a quantity above one is not a removal');
    await menuRemove(page, A);
    await expectCart(page, [[B, 1]]);
    const undo = undoButton(page, A); await undo.waitFor();
    const box = await undo.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, `Undo target ${box.width}x${box.height}`);
    await announcer(page).filter({ hasText: `Removed ${A}` }).waitFor({ state: 'attached' });
    assert.equal(await announcer(page).first().getAttribute('aria-live'), 'polite');
    // Stays at least five seconds, and never expires while it has focus.
    await context.clock.fastForward(6000);
    assert.equal(await undo.count(), 1, 'Undo lasts past five seconds');
    await undo.focus(); await context.clock.fastForward(60000);
    assert.equal(await undo.count(), 1, 'no auto-dismiss while focused');
    await page.evaluate(() => document.activeElement?.blur()); await context.clock.fastForward(9000);
    await undo.waitFor({ state: 'detached' }); assert.equal(await announcer(page).count(), 0, 'announcement cleared with the notice');
    await expectCart(page, [[B, 1]], 'expiry changes nothing');
    // Undo by keyboard restores the dish where it was, with its quantity.
    await menuRemove(page, B); await undoButton(page, B).waitFor();
    await undoButton(page, B).focus(); await page.keyboard.press('Enter');
    await page.getByText(`Restored ${B} to your cart.`).waitFor({ state: 'attached' });
    await page.getByRole('group', { name: `${B} quantity` }).waitFor();
    await expectCart(page, [[B, 1]]);
    // Other cart changes are not overwritten: remove B, add A (first Add), then Undo B -> both, B back in its place.
    await menuRemove(page, B); await undoButton(page, B).waitFor();
    await add(page, 1);
    await undoButton(page, B).click();
    await page.waitForFunction(slugName => JSON.parse(localStorage.getItem(`market:cart:${slugName}`)).lines.length === 2, slug);
    assert.deepEqual((await saved(page)).map(([n]) => n).sort(), [A, B].sort());
    // Repeated remove and undo.
    for (let i = 0; i < 3; i++) { await menuRemove(page, A); await undoButton(page, A).click(); await page.getByRole('group', { name: `${A} quantity` }).waitFor(); }
    assert.deepEqual((await saved(page)).map(([n, q]) => `${n}:${q}`).sort(), [`${A}:1`, `${B}:1`].sort());
    // A newer removal replaces the older notice.
    await menuRemove(page, A); await menuRemove(page, B);
    await undoButton(page, B).waitFor(); assert.equal(await undoButton(page, A).count(), 0);
    await undoButton(page, B).click(); await page.getByRole('group', { name: `${B} quantity` }).waitFor();

    // Multi-tab: another tab adds the dish back with a bigger quantity; Undo here keeps that cart.
    await menuRemove(page, B); await undoButton(page, B).waitFor();
    const other = await open();
    await add(other, 2); await other.getByRole('button', { name: `Add one ${B}`, exact: true }).click();
    await other.waitForFunction(slugName => JSON.parse(localStorage.getItem(`market:cart:${slugName}`)).lines.some(line => line.quantity === 2), slug);
    const before = await saved(other);
    await page.bringToFront(); await undoButton(page, B).click();
    await page.waitForTimeout(300);
    await expectCart(page, before, 'Undo does not add a second unit over the other tab');
    await other.close();

    // Cart page: the notice sits with the dishes, never over the Place order button, and works there too.
    await page.getByRole('button', { name: /^Cart/ }).first().click();
    await page.getByRole('button', { name: `Remove one ${A}`, exact: true }).waitFor();
    const quantity = async dishName => (await saved(page)).find(([n]) => n === dishName)?.[1] ?? 0;
    while (await quantity(A) > 1) { await page.getByRole('button', { name: `Remove one ${A}`, exact: true }).click(); await page.waitForTimeout(100); }
    await page.getByRole('button', { name: `Remove one ${A}`, exact: true }).click();
    await undoButton(page, A).waitFor();
    const place = await page.getByRole('button', { name: /Place order|delivery address/ }).last().boundingBox(), notice = await undoButton(page, A).boundingBox();
    assert.ok(place && (notice.y + notice.height <= place.y || notice.y >= place.y + place.height), `Undo does not cover the checkout button ${JSON.stringify({ place, notice })}`);
    await announcer(page).filter({ hasText: `Removed ${A}` }).waitFor({ state: 'attached' });
    await undoButton(page, A).click();
    await page.getByRole('group', { name: new RegExp(`^${A}:`) }).waitFor();
    assert.ok((await saved(page)).some(([n]) => n === A));
    // Emptying the cart: the notice stays in the empty state and brings the dish back.
    for (const dishName of [A, B]) { while (await quantity(dishName) > 0) { await page.getByRole('button', { name: `Remove one ${dishName}`, exact: true }).click(); await page.waitForTimeout(150); } }
    await page.getByText('Your cart is empty', { exact: true }).waitFor();
    await undoButton(page, B).click(); await page.getByRole('group', { name: new RegExp(`^${B}:`) }).waitFor();
    assert.ok((await saved(page)).some(([n, q]) => n === B && q >= 1));
    // Changing the restaurant scope (here: an order receipt would) is covered by the unit tests; a reload never offers Undo.
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByRole('button', { name: /^Undo removing/ }).count(), 0, 'Undo does not survive a reload');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS: ${slug} last-unit removal offers a polite, keyboard-reachable Undo in the menu and the cart (timing, focus hold, repeat, other changes, other tab)`);
  } finally { await server.close(); }
}
await browser.close();
