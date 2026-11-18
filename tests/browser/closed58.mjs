import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// Real customer exports and installed SDK; synthetic HTTP/Phoenix fixtures only.
const api = 'https://market-fixture.supabase.co';
const userId = '58000000-0000-4000-8000-000000000001';
const orderId = '58000000-0000-4000-8000-000000000002';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'closed-fixture@example.test', user_metadata: {}, app_metadata: {} };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${part({ alg: 'HS256' })}.${part({ sub: userId, role: 'authenticated', session_id: '58000000-0000-4000-8000-000000000003', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
const session = { access_token: token, refresh_token: 'closed-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const visible = locator => locator.filter({ visible: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 0.5, longitude: 0.5, accuracy: 10 } });
    const businessId = `58100000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: false };
    const item = { id: '58200000-0000-4000-8000-000000000001', name: 'Closed fixture meal', description: 'Synthetic availability fixture', category_id: '58300000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const historical = { id: orderId, business_id: businessId, customer_id: userId, status: 'delivered', version: 1, created_at: '2026-11-15T10:00:00Z', subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: 'Synthetic customer', customer_phone: '9876543210', delivery_address_line: 'Synthetic Khed address', order_items: [{ menu_item_id: item.id, diet: null, name: item.name, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [] };
    const channels = new Map(), requests = [], errors = [];
    const firstBusiness = deferred();
    let holdAll = firstBusiness.promise, holdOne = null, failBusiness = false, mode = 'closed', placed = null;
    await context.routeWebSocket(/.*/, socket => {
      assert.equal(new URL(socket.url()).origin, 'wss://market-fixture.supabase.co');
      socket.onClose(() => { for (const [topic, channel] of channels) if (channel.socket === socket) channels.delete(topic); });
      socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        const changes = (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 }));
        if (event === 'phx_join' && changes.some(change => change.table === 'businesses')) channels.set(topic, { socket, join, topic, array, changes });
        if (event === 'phx_leave') channels.delete(topic);
        if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) {
          const response = { status: 'ok', response: { postgres_changes: changes } };
          socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
        }
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === server.url) return route.fallback();
      assert.equal(url.origin, api, 'no unconfigured third-party calls');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/rest/v1/businesses') {
        const snapshot = { ...business }, held = holdOne; holdOne = null;
        if (holdAll) await holdAll;
        if (held) { held.arrived.resolve(); await held.release.promise; }
        if (failBusiness) return json({ message: 'Synthetic restaurant-status failure' }, 503);
        await json(snapshot); held?.done.resolve(); return;
      }
      if (url.pathname === '/rest/v1/menu_items') return json([item]);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/rpc/list_addresses') return json([{ id: '48200000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Bharne Naka', landmark: null, latitude: 0.5, longitude: 0.5, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 }]);
      if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? placed ?? historical : [placed ?? historical]);
      if (url.pathname === '/rest/v1/rpc/place_order') {
        const body = request.postDataJSON(); requests.push(body);
        if (mode === 'closed') { business.accepting_orders = false; return json({ code: 'PT409', message: 'restaurant is not accepting orders', details: null, hint: null }, 409); }
        if (mode === 'quote') {
          const original = body.p_accepted_pricing;
          return json({ outcome: 'pricing_changed', pricing: { ...original, delivery_fee_paise: original.delivery_fee_paise + 500, total_paise: original.total_paise + 500 } });
        }
        if (mode === 'lost') return route.abort('failed');
        assert.equal(mode, 'placed');
        const terms = body.p_accepted_pricing;
        placed = { ...historical, status: 'placed', subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: body.p_delivery.address_line ?? 'Flat 3, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })) };
        return json({ outcome: 'placed', id: orderId });
      }
      throw new Error(`Unexpected closed-state fixture ${request.method()} ${url.pathname}`);
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    const text = brand ? "The kitchen isn't taking orders right now. Browse the menu and check back a little later." : 'Not taking orders right now. You can still look at the menu. Check back a little later.';
    const closed = () => visible(page.getByText(text, { exact: true })).first();
    const add = () => visible(page.getByRole('button', { name: 'Add to cart', exact: true }));
    const cart = () => visible(page.getByRole('button', { name: /^Cart \(/ }));
    const field = name => visible(page.getByLabel(name, { exact: true }));
    const button = name => visible(page.getByRole('button', { name, exact: true }));
    const saved = () => page.evaluate(key => localStorage.getItem(key), `market:cart:${slug}`);
    const contents = raw => { const { revision, ...cart } = JSON.parse(raw); return cart; };
    const attempt = () => page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`);
    const send = (channel, event, payload) => channel.socket.send(JSON.stringify(channel.array ? [channel.join, null, channel.topic, event, payload] : { join_ref: channel.join, ref: null, topic: channel.topic, event, payload }));
    const live = async () => {
      await assertEventually(() => channels.size === 1);
      assert.equal(channels.size, 1, 'one guest-safe public subscription');
      for (const channel of channels.values()) send(channel, 'postgres_changes', { ids: channel.changes.filter(change => change.table === 'businesses').map(change => change.id), data: { schema: 'public', table: 'businesses', type: 'UPDATE', commit_timestamp: new Date().toISOString(), columns: [], record: { ...business }, old_record: {} } });
    };
    const setOpen = async open => {
      business.accepting_orders = open; await live();
      if (open) { await closed().waitFor({ state: 'hidden' }); await assertEventually(async () => (await visible(page.getByRole('button', { name: /^(?:Add to cart$|Add · |Cart \(|Place order$|Retry reorder$)/ })).count()) > 0); }
      else await closed().waitFor();
    };
    const fillCheckout = async () => {
      await field('Name').fill('Synthetic checkout name'); await field('Mobile number').fill('9876543210');
      await visible(page.getByText('Deliver to Home', { exact: true })).waitFor();
    };
    try {
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.getByText('Checking whether the restaurant is taking orders…', { exact: true }).waitFor();
      assert.equal(await add().count(), 0); assert.equal(await closed().count(), 0, 'unknown is not labelled closed');
      holdAll = null; firstBusiness.resolve();
      await closed().waitFor();
      // Brand-styled notice (#39 slice 4): a status region with the brand's notice colour, a bold lead, and the saved-cart line.
      const notice = page.getByRole('status').filter({ hasText: text }).last();
      await notice.waitFor();
      assert.equal(await notice.evaluate(node => { let el = node; while (el && getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)') el = el.parentElement; return getComputedStyle(el).backgroundColor; }), brand ? 'rgb(200, 180, 124)' : 'rgb(46, 33, 30)', 'notice uses the brand colour');
      assert.equal(await closed().evaluate(node => Number(getComputedStyle(node.firstElementChild).fontWeight) >= 600 || getComputedStyle(node.firstElementChild).fontFamily !== getComputedStyle(node).fontFamily), true, 'lead is emphasised');
      await notice.getByText('Your saved cart is kept for later.', { exact: true }).waitFor();
      await visible(page.getByText(item.name, { exact: true })).waitFor();
      assert.equal(await add().count(), 0); assert.equal(await cart().count(), 0);
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await closed().scrollIntoViewIfNeeded();
        assert.equal(await closed().evaluate(node => node.scrollWidth <= node.clientWidth), true, 'closed copy wraps');
        await page.screenshot({ path: `dist/browser/${slug}-closed-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const dish = button(`View details for ${item.name}`);
      await dish.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.getByText(text, { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Increase quantity', exact: true }).count(), 0);
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert.equal(await dish.evaluate(node => node === document.activeElement), true, 'dish close restores keyboard focus');
      await setOpen(true); await add().click(); await cart().waitFor();
      const guestCart = await saved();
      await dish.click(); await dialog.getByRole('button', { name: 'Increase quantity', exact: true }).waitFor();
      await setOpen(false); await dialog.getByText(text, { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: /^Add · / }).count(), 0);
      assert.deepEqual(contents(await saved()), contents(guestCart), 'closing inside dish details preserves the saved draft');
      await setOpen(true); await dialog.getByRole('button', { name: /^Add · / }).waitFor();
      await page.keyboard.press('Escape'); await cart().click();
      await field('Name').fill('Retained guest name');
      await setOpen(false);
      assert.equal(await button(`Add one ${item.name}`).count(), 0); assert.equal(await button('Place order').count(), 0);
      assert.equal(await field('Name').inputValue(), 'Retained guest name');
      assert.deepEqual(contents(await saved()), contents(guestCart));
      await setOpen(true); assert.equal(requests.length, 0, 'reopening never submits');
      const publicTopic = [...channels.keys()][0];
      await button('Account').click(); await field('Email').fill(user.email); await field('Password').fill('synthetic-password'); await button('Sign in').click();
      await button('Sign out').waitFor();
      assert.equal([...channels.keys()][0], publicTopic, 'public subscription survives sign-in');
      await cart().click(); await fillCheckout();
      const signedCart = await saved();
      await setOpen(false);
      assert.equal(await field('Name').inputValue(), 'Synthetic checkout name'); assert.deepEqual(contents(await saved()), contents(signedCart)); assert.equal(requests.length, 0);
      await setOpen(true); mode = 'closed'; await button('Place order').click();
      await closed().waitFor(); await assertEventually(async () => await attempt() === null);
      assert.equal(requests.length, 1); assert.deepEqual(contents(await saved()), contents(signedCart));
      await visible(page.getByText('Deliver to Home', { exact: true })).waitFor();
      assert.equal(await visible(page.getByText(/Please check your details and try again/)).count(), 0, 'closed refusal uses the branded notice');
      await setOpen(true); assert.equal(requests.length, 1);
      console.log(`PASS: ${slug} unknown/closed/open guests, keyboard dish details, live cart/form preservation, auth-stable subscription and typed closure refusal`);

      await page.goto(server.url, { waitUntil: 'networkidle' }); await visible(page.getByRole('button', { name: /^(?:Add to cart|Add one )/ })).waitFor(); // a dish already in the cart shows its stepper
      const held = { arrived: deferred(), release: deferred(), done: deferred() }; holdOne = held;
      await live(); await held.arrived.promise;
      business.accepting_orders = false; await live(); await closed().waitFor();
      held.release.resolve(); await held.done.promise; await page.waitForLoadState('networkidle');
      assert.equal(await add().count(), 0); await closed().waitFor();
      await setOpen(true);
      for (const channel of channels.values()) send(channel, 'phx_error', {});
      await visible(page.getByText('Could not confirm whether the restaurant is taking orders', { exact: true })).waitFor();
      assert.equal(await add().count(), 0); await visible(page.getByText(item.name, { exact: true })).waitFor();
      failBusiness = true; await button('Refresh restaurant status').click();
      await visible(page.getByText(/Synthetic restaurant-status failure/)).waitFor();
      assert.equal(await add().count(), 0);
      failBusiness = false; business.accepting_orders = false; await button('Refresh restaurant status').click(); await closed().waitFor();
      await setOpen(true); assert.equal(requests.length, 1);
      console.log(`PASS: ${slug} older open refresh cannot override closure; disconnected/failed refresh is distinct from closure; explicit reconnect restores live updates`);

      await page.goto(`${server.url}/orders/${orderId}`, { waitUntil: 'networkidle' });
      await button('Order this again for order 000002').click(); await dialog.getByRole('button', { name: 'Replace cart', exact: true }).waitFor();
      const beforeReorder = await saved(); await setOpen(false);
      await dialog.getByText(text, { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Add to cart', exact: true }).count(), 0); assert.equal(await dialog.getByRole('button', { name: 'Replace cart', exact: true }).count(), 0);
      assert.deepEqual(contents(await saved()), contents(beforeReorder));
      business.accepting_orders = true; await live(); await dialog.getByRole('button', { name: 'Retry reorder', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Retry reorder', exact: true }).click(); await dialog.getByRole('button', { name: 'Replace cart', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      await cart().click(); await fillCheckout(); mode = 'quote'; await button('Place order').click();
      await visible(page.getByText('Review revised order', { exact: true })).waitFor();
      const quoteRequests = requests.length;
      await setOpen(false); assert.equal(await button('Accept revised total and place order').count(), 0);
      assert.equal(await attempt(), null); assert.equal(requests.length, quoteRequests);
      business.accepting_orders = true; await live(); await button('Accept revised total and place order').waitFor();
      await button('Edit cart').click(); await visible(page.getByText('Review revised order', { exact: true })).waitFor({ state: 'hidden' });
      await fillCheckout(); mode = 'lost'; await button('Place order').click();
      await button('Retry order recovery').waitFor(); await assertEventually(() => button('Retry order recovery').isEnabled());
      const uncertain = await attempt(), sent = requests.at(-1), beforeRecovery = requests.length;
      assert.ok(uncertain); await setOpen(false); assert.equal(await attempt(), uncertain);
      assert.equal(await button('Retry order recovery').isEnabled(), true, 'closure cannot disable an existing-order recovery');
      mode = 'placed'; await button('Retry order recovery').click();
      await visible(page.getByText('Your order is with the restaurant', { exact: true })).waitFor();
      assert.equal(requests.length, beforeRecovery + 1); assert.deepEqual(requests.at(-1), sent, 'recovery resends the original frozen request despite closing');
      await assertEventually(async () => await attempt() === null);
      assert.equal(JSON.parse(await saved()).lines.length, 0);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} close/reopen in reorder and revised pricing; pending recovery stays usable while closed and retains frozen payload`);
    } catch (error) {
      await page.screenshot({ path: `dist/browser/${slug}-closed-failure.png`, fullPage: true }); throw error;
    } finally { firstBusiness.resolve(); await context.close(); await server.close(); }
  }
} finally { await browser.close(); }

async function assertEventually(check) {
  for (let index = 0; index < 200; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
