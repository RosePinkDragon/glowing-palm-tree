import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { profilesUnavailable } from './otp-login.mjs';

// #57 (slice A): no internet, server and sign-in failures on the menu, the empty cart, no orders and no saved addresses, in both brands.
// Real customer exports and the installed SDK, with deterministic synthetic HTTP. Offline is a refused connection (and Playwright's setOffline), never a real outage.
const api = 'https://market-fixture.supabase.co';
const userId = '57100000-0000-4000-8000-000000000001';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'states@example.test', app_metadata: {}, user_metadata: { full_name: 'Rohan Sawant' }, phone: '+919876543210', identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'states-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const meals = { id: '57300000-0000-4000-8000-000000000001', name: 'Meals', sort_order: 1 };
const drinks = { id: '57300000-0000-4000-8000-000000000002', name: 'Drinks', sort_order: 2 };
const dish = (n, name, price, category = meals) => ({ id: `57400000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name, description: 'Synthetic fixture dish for browser checks.', diet: 'veg', category_id: category.id, menu_categories: { name: category.name, sort_order: category.sort_order }, price_paise: price, available: true, is_demo: false, is_featured: false, sort_order: n, image_url: null });
const menu = [dish(1, 'Kanda poha', 5000), dish(2, 'Misal pav', 9000), dish(3, 'Sol kadhi', 4000, drinks)];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', other = brand ? 'Ammu Sammu' : 'Kokani Dine Inn';
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const errors = [], orderCalls = [];
    const state = { fail: null, delay: 0, orders: [], addresses: [] };
    const business = { id: `57200000-0000-4000-8000-00000000000${brand + 1}`, slug, name, delivery_fee_paise: 3000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
    await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
      const data = JSON.parse(String(message)), array = Array.isArray(data);
      const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
      const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
      if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
    }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.fallback();
      assert.equal(url.origin, api, 'no third-party requests');
      if (state.delay && url.pathname === '/rest/v1/businesses') await new Promise(done => setTimeout(done, state.delay)); // a slow network
      if (state.fail === 'offline') return route.abort('internetdisconnected');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      const catalog = ['/rest/v1/businesses', '/rest/v1/menu_items', '/rest/v1/menu_categories'].includes(url.pathname);
      if (catalog && state.fail === 'server') return json({ code: 'PT503', message: 'Synthetic upstream outage', details: null, hint: null }, 503);
      if (catalog && state.fail === 'auth') return json({ code: 'PGRST301', message: 'JWT expired', details: null, hint: null }, 401);
      const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json(menu);
      if (url.pathname === '/rest/v1/menu_categories') return json([meals, drinks]);
      if (url.pathname === '/rest/v1/orders') return json(state.orders);
      if (url.pathname === '/rest/v1/rpc/list_addresses') return json(state.addresses);
      if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
      if (url.pathname === '/rest/v1/customer_businesses') return json([]);
      if (url.pathname === '/rest/v1/rpc/place_order') { orderCalls.push(request.postDataJSON()); return json({ code: 'PT500', message: 'must never be called' }, 500); }
      if (url.pathname === '/rest/v1/profiles') return profilesUnavailable(route); // the drawer reads the profile (#45): unavailable here
      throw new Error(`Unexpected states request ${request.method()} ${url.pathname}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const visible = locator => locator.filter({ visible: true });
    const button = label => visible(page.getByRole('button', { name: label, exact: true }));
    const text = value => visible(page.getByText(value, { exact: true }));
    const heading = (value, level) => visible(page.getByRole('heading', { name: value, exact: true, ...(level ? { level } : {}) }));
    const shot = async label => { await page.waitForTimeout(500); return page.screenshot({ path: `dist/browser/${slug}-states57-${label}.png`, fullPage: true }); };
    const bar = () => visible(page.getByRole('status').filter({ hasText: "You're offline" }));
    const savedCart = () => page.evaluate(key => localStorage.getItem(key), `market:cart:${slug}`);
    const contents = raw => { const { revision, ...rest } = JSON.parse(raw); return rest; }; // a reload bumps the revision counter only
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    try {
      // Online first: put a dish in the cart and leave an order attempt waiting for confirmation, so offline can be shown to keep both.
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await heading(name, 1).waitFor();
      assert.equal(await bar().count(), 0, 'no offline bar while online');
      await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click();
      await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '{"lines":[]}').lines.length === 1, `market:cart:${slug}`);
      const cartBefore = await savedCart();
      const attempt = JSON.stringify({ version: 2, businessId: slug, userId, idempotencyKey: '57500000-0000-4000-8000-000000000001', lines: JSON.parse(cartBefore).lines, pricing: { delivery_fee_paise: 3000, min_order_paise: 0, subtotal_paise: 5000, total_paise: 8000, discount_paise: 0, offer_id: null }, delivery: { name: 'Rohan', phone: '9876543210' }, savedAddress: { id: '57600000-0000-4000-8000-000000000001', version: 1 }, location: null });
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: `market:checkout:${slug}`, value: attempt });

      // 1. No internet: the menu cannot load.
      state.fail = 'offline';
      await page.reload({ waitUntil: 'domcontentloaded' });
      await heading('No internet connection', 2).waitFor();
      await bar().waitFor();
      assert.equal(await bar().first().getAttribute('aria-live'), 'polite', "the offline bar is a polite live region");
      const keptLine = brand ? 'Your order is kept on this phone.' : 'Your cart is kept on this phone.';
      await text(`We couldn't load today's menu. Check your mobile data or Wi-Fi, then try again. ${keptLine}`).waitFor();
      assert.equal(await page.getByText('Could not confirm whether the restaurant is taking orders').count(), 0, 'offline is not shown as a server problem');
      assert.equal(await page.getByText('Something went wrong on our side').count(), 0);
      await noOverflow(); await shot('offline');
      const retry = button('Try again'); await retry.waitFor();
      await retry.focus(); assert.equal(await retry.evaluate(node => node === document.activeElement), true, 'Try again takes keyboard focus');
      state.delay = 1200; await page.keyboard.press('Enter');
      // Pressing it keeps the screen and the focused button in place (no "Loading menu" swap), and says it is busy.
      await button('Trying again…').waitFor();
      assert.equal(await page.getByText('Loading menu', { exact: true }).count(), 0, 'Try again does not replace the screen with Loading menu');
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Trying again…', 'keyboard focus stays on the same button');
      await button('Try again').waitFor(); state.delay = 0; // still offline: the screen comes back, nothing else changes
      await heading('No internet connection', 2).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Try again', 'focus is still on Try again');
      assert.deepEqual(contents(await savedCart()), contents(cartBefore), 'the saved cart is kept while offline');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), attempt, 'checkout recovery is kept while offline');
      await page.setViewportSize({ width: 320, height: 700 }); await noOverflow(); await page.setViewportSize({ width: 390, height: 844 });

      // 2. The connection returns: the bar goes and the menu loads without Try again. Ammu Sammu relies on the quiet background check, Kokani Dine Inn on the browser's "online" event.
      // Ammu Sammu: the network is slow (7 s, longer than the 6 s check), so the background check must not be cancelled by the next one.
      state.fail = null; state.delay = brand ? 0 : 7000;
      if (brand) await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await heading(name, 1).waitFor({ timeout: 40000 }); state.delay = 0;
      await bar().waitFor({ state: 'hidden' });
      assert.equal(await page.getByText('No internet connection').count(), 0);
      await button(/^Cart \(1\)/).waitFor();
      assert.deepEqual(contents(await savedCart()), contents(cartBefore), 'the cart is unchanged after reconnecting');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), attempt, 'reconnecting does not discard checkout recovery');
      assert.equal(orderCalls.length, 0, 'reconnecting never places or resends an order');
      await text('Order awaiting confirmation').waitFor();

      // 3. The browser itself going offline shows the bar over a menu that is already on screen.
      await context.setOffline(true);
      await bar().waitFor(); await heading(name, 1).waitFor(); await shot('offline-bar-over-menu');
      await context.setOffline(false);
      await bar().waitFor({ state: 'hidden' });
      assert.equal(orderCalls.length, 0);

      // A browser that wrongly says "offline" while requests work: the bar clears itself after the next quiet check, which also stops further checks.
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await bar().waitFor(); await bar().waitFor({ state: 'hidden', timeout: 15000 });
      await heading(name, 1).waitFor();

      // Reconnecting while on the cart never flips ordering to "Checking whether the restaurant is taking orders…".
      await button(/^Cart \(1\)/).click(); await button(/^(?:Place order|Add a delivery address)$/).waitFor();
      state.delay = 1500; await page.evaluate(() => window.dispatchEvent(new Event('online')));
      for (let i = 0; i < 12; i++) { assert.equal(await page.getByText('Checking whether the restaurant is taking orders…').count(), 0, 'an online event reloads quietly'); await page.waitForTimeout(100); }
      state.delay = 0; await page.waitForTimeout(1600);
      assert.equal(orderCalls.length, 0);
      await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await heading(name, 1).waitFor();

      // 4. A server fault and an expired sign-in are not "offline".
      state.fail = 'server'; await page.reload({ waitUntil: 'domcontentloaded' });
      await heading("We can't load the menu right now", 2).waitFor();
      assert.equal(await bar().count(), 0, 'a server fault is not the offline bar'); assert.equal(await page.getByText('No internet connection').count(), 0);
      await shot('server-error');
      state.fail = 'auth'; await button('Try again').click();
      await heading('Please sign in again', 2).waitFor(); assert.equal(await bar().count(), 0); await shot('sign-in-expired');
      state.fail = null; await page.reload({ waitUntil: 'domcontentloaded' }); await heading(name, 1).waitFor();
      await page.evaluate(key => { localStorage.removeItem(key); }, `market:checkout:${slug}`);

      // 5. Empty cart at checkout.
      await page.evaluate(key => localStorage.removeItem(key), `market:cart:${slug}`);
      await page.goto(`${server.url}/cart`, { waitUntil: 'domcontentloaded' });
      const emptyTitle = brand ? 'Nothing ordered yet' : 'Your plate is empty';
      await heading(emptyTitle, 2).waitFor();
      await text(brand ? "Pick a signature dish or something from the à la carte menu, and it'll show up here." : "Add a thali, a snack or something sweet from today's menu, and it'll show up here.").waitFor();
      await noOverflow(); await shot('empty-cart');
      await button(brand ? 'See the menu' : 'Browse the menu').click();
      await heading(name, 1).waitFor();

      // 6. No orders in the account drawer.
      await button('Account').click();
      await heading('No orders yet', 3).waitFor();
      await text(`Your orders from ${name} will show here, so you can track them and reorder in one tap.`).waitFor();
      await shot('no-orders-drawer');
      await button('Browse the menu').first().click();
      await heading(name, 1).waitFor();
      await heading('No orders yet').waitFor({ state: 'hidden', timeout: 10000 }); // the drawer closes on Browse the menu

      // 7. No saved addresses.
      await page.goto(`${server.url}/addresses`, { waitUntil: 'domcontentloaded' });
      await heading('No saved addresses yet', 3).waitFor();
      await text(`Use your current location or add an address. It's saved for next time, in this app and the ${other} app.`).waitFor();
      await button('Add address').waitFor(); await noOverflow(); await shot('no-addresses');
      // 8. Below the minimum order (items only, delivery not counted): bar, progress, suggestions, a disabled main button that says why, and it follows the cart live.
      business.min_order_paise = 15000;
      await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await heading(name, 1).waitFor();
      await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click();
      await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) || '{"lines":[]}').lines.length === 1, `market:cart:${slug}`);
      await button(/^Cart \(1\)/).click();
      const minBar = page.locator('#minimum-order-bar').filter({ visible: true });
      await minBar.getByText('Add ₹100 more to order.', { exact: false }).waitFor();
      await minBar.getByText('The minimum order is ₹150, not counting delivery.', { exact: false }).waitFor();
      await minBar.getByText('₹50 of ₹150', { exact: true }).waitFor();
      assert.equal(await minBar.getAttribute('aria-live'), 'polite');
      assert.equal(await minBar.getByRole('progressbar').getAttribute('aria-valuenow'), '33');
      assert.deepEqual(await page.getByRole('button', { name: /^Add (?!one|more)/ }).filter({ visible: true }).evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')).filter(label => /^Add (Misal pav|Sol kadhi|Kanda poha)$/.test(label))), ['Add Misal pav', 'Add Sol kadhi']);
      const main = button('Add ₹100 more to order'); await main.waitFor();
      assert.equal(await main.isDisabled(), true, 'the main button is disabled below the minimum');
      assert.equal(await main.getAttribute('aria-describedby'), 'minimum-order-text', 'and its reason is in text');
      assert.equal(await page.locator('#minimum-order-text').filter({ visible: true }).count(), 1);
      await text(brand ? 'Dishes' : 'Items').last().waitFor();
      await noOverflow(); await shot('below-minimum');
      await button('Add Misal pav').scrollIntoViewIfNeeded(); await shot('below-minimum-suggestions');
      await button('Add Misal pav').click();
      await minBar.getByText('Add ₹10 more to order.', { exact: false }).waitFor(); await button('Add ₹10 more to order').waitFor();
      assert.equal(await button('Add Misal pav').count(), 0, 'a dish already in the cart is no longer suggested');
      await button('Add Sol kadhi').click();
      await page.locator('#minimum-order-bar').filter({ visible: true }).waitFor({ state: 'detached' });
      assert.equal(await page.getByRole('button', { name: /more to order$/ }).count(), 0, 'at the minimum nothing blocks');
      assert.equal(await button('Add a delivery address').isDisabled(), false);
      await button('Remove one Sol kadhi').click(); await button('Add ₹10 more to order').waitFor(); // takes the minimum away again, live
      business.min_order_paise = 0; await page.reload({ waitUntil: 'domcontentloaded' });
      await button(/^(?:Place order|Add a delivery address)$/).waitFor(); assert.equal(await page.locator('#minimum-order-bar').count(), 0, 'a minimum of 0 never blocks');
      await page.evaluate(key => localStorage.removeItem(key), `market:cart:${slug}`);

      // 9. Menu search with no match: the brand's words, category chips as suggestions, and a way to clear it.
      await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await heading(name, 1).waitFor();
      const search = page.getByLabel('Search dishes', { exact: true });
      await search.fill('poha'); await heading(name, 1).waitFor();
      assert.deepEqual(await page.locator('#regular-menu').getByRole('heading', { level: brand ? 4 : 3 }).allTextContents(), ['Kanda poha']);
      await search.fill(brand ? 'lollipop' : 'paneer');
      const none = brand ? 'Nothing matches “lollipop”' : 'No dishes match “paneer”';
      await heading(none, 2).waitFor();
      await text(brand ? 'Check the spelling, or look through a section:' : 'Check the spelling, or try one of these:').waitFor();
      await button('Show Meals').waitFor(); await button('Show Drinks').waitFor(); await noOverflow(); await shot('search-no-match');
      await button('Show Drinks').click();
      assert.equal(await search.inputValue(), '', 'a chip clears the search'); await text('Sol kadhi').waitFor();
      await search.fill('zzz'); await heading('Nothing matches “zzz”'.replace('Nothing matches', brand ? 'Nothing matches' : 'No dishes match'), 2).waitFor();
      await button('Clear search').last().click(); assert.equal(await search.inputValue(), ''); await text('Kanda poha').waitFor();
      assert.deepEqual(errors, []); assert.equal(orderCalls.length, 0);
      console.log(`PASS: ${slug} offline screen and bar, auto-recovery (${brand ? 'online event' : 'background check'}), cart and checkout recovery kept, server and sign-in errors told apart, empty cart, no orders, no saved addresses, below-minimum bar, search with no match`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
