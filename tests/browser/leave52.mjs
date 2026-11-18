import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #52 customer screen slice: "Leave [restaurant]" in Account settings, in both brands. Real customer exports and the
// installed SDK, with deterministic synthetic HTTP (the leave/join/place_order RPCs are fixtures).
const api = 'https://market-fixture.supabase.co';
const userId = '52600000-0000-4000-8000-000000000001';
const orderId = '52600000-0000-4000-8000-000000000002';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'leave@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'leave-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const HOME = { latitude: 17.719, longitude: 73.397 };
const shots = process.env.LEAVE_SHOTS ?? 'dist/browser';
const names = { 'ammu-sammu': 'Ammu Sammu', 'kokani-dine-inn': 'Kokani Dine Inn' };
const ids = { 'ammu-sammu': '52700000-0000-4000-8000-000000000001', 'kokani-dine-inn': '52700000-0000-4000-8000-000000000002' };
const generations = { 'ammu-sammu': '52800000-0000-4000-8000-000000000001', 'kokani-dine-inn': '52800000-0000-4000-8000-000000000002' };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const luminance = rgb => { const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(n => { const c = Number(n) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
try {
  for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
    const name = names[slug], other = names[slug === 'ammu-sammu' ? 'kokani-dine-inn' : 'ammu-sammu'], otherSlug = slug === 'ammu-sammu' ? 'kokani-dine-inn' : 'ammu-sammu';
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
    const business = { id: ids[slug], slug, name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const link = (s, state = 'active') => ({ business_id: ids[s], generation: generations[s], state, businesses: { slug: s, name: names[s] } });
    // The fixture owns the "server": links, leave behaviour, and every call it saw.
    const fixture = { links: [link(slug)], leave: [], leaveMode: 'ok', leaveDelay: 0, joins: 0, orders: 0, keys: [], created: 0, placeMode: 'ok', logouts: [], authed: true, errors: [] };
    const requestKey = `market:leave:${slug}:${encodeURIComponent(userId)}`, cartStorageKey = `market:cart:${slug}`, prefKey = `market:preferences:${slug}:customer:${encodeURIComponent(userId)}`, sessionKey = `market:${encodeURIComponent(api)}:${slug}:customer`;
    const item = { id: '52900000-0000-4000-8000-000000000001', name: 'Leave fixture meal', description: 'Synthetic fixture', category_id: '52900000-0000-4000-8000-000000000002', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const cartItem = { id: item.id, businessId: slug, name: item.name, categoryId: item.category_id, categorySortOrder: 0, description: '', category: 'Meals', pricePaise: 10000, isAvailable: true, isDemo: false };
    await context.addInitScript(({ key, value, cart, cartKey, pKey }) => {
      if (sessionStorage.getItem('leave52-seeded')) return; // seed once per tab so a later sign-out sticks
      sessionStorage.setItem('leave52-seeded', '1');
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem(cartKey, JSON.stringify(cart));
      localStorage.setItem(pKey, JSON.stringify({ analytics: false, push: false }));
    }, { key: sessionKey, value: session, cartKey: cartStorageKey, pKey: prefKey, cart: { version: 1, revision: 1, businessId: slug, ownerId: userId, lines: [{ item: cartItem, quantity: 2 }] } });
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
      const rpc = url.pathname.replace('/rest/v1/rpc/', ''), method = request.method();
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/auth/v1/logout') { fixture.logouts.push(url.searchParams.get('scope')); return route.fulfill({ status: 204 }); }
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json([item]);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/customer_businesses') return json(fixture.links);
      if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? placed : []);
      if (rpc === 'list_addresses') return json([{ id: '53000000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 }]);
      if (rpc === 'leave_business') {
        const body = request.postDataJSON(); fixture.leave.push(body);
        if (fixture.leaveDelay) await new Promise(done => setTimeout(done, fixture.leaveDelay));
        const refuse = details => json({ code: 'PT409', message: 'RAW SERVER TEXT', details, hint: null }, 409);
        if (fixture.leaveMode === 'active') return refuse('ACTIVE_ORDERS');
        if (fixture.leaveMode === 'last') return refuse('LAST_BUSINESS');
        if (fixture.leaveMode === 'pending') return refuse('BUSINESS_LIFECYCLE_PENDING');
        if (fixture.leaveMode === 'network') return route.abort('failed');
        if (fixture.leaveMode === 'lost') { fixture.links = [link(slug, 'left'), link(otherSlug)]; fixture.leaveMode = 'ok'; return route.abort('failed'); } // committed; the response was lost
        fixture.links = [link(slug, 'left'), link(otherSlug)];
        return json({ customer_id: userId, business_id: ids[slug], request_id: body.p_request_id, generation: body.p_generation, state: 'left', started_at: '2026-11-18T10:00:00.123456+00:00', completed_at: '2026-11-18T10:00:00.123457+00:00' });
      }
      if (rpc === 'join_business') { fixture.joins++; fixture.links = [link(slug), link(otherSlug)]; return json({ customer_id: userId, business_id: ids[slug], generation: generations[slug], state: 'active', joined_at: '2026-11-18T11:00:00.123456+00:00' }); }
      if (rpc === 'place_order') {
        fixture.orders++; const body = request.postDataJSON();
        if (fixture.placeMode === 'join-required') return json({ code: 'PT403', message: 'RAW SERVER TEXT', details: 'BUSINESS_JOIN_REQUIRED', hint: null }, 403);
        fixture.keys.push(body.p_idempotency_key);
        const terms = body.p_accepted_pricing;
        if (!placed) fixture.created++;
        placed ??= { id: orderId, business_id: ids[slug], customer_id: userId, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka', order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
        if (fixture.placeMode === 'lost') return route.abort('failed'); // committed; the response was lost
        return json({ outcome: 'placed', id: orderId });
      }
      if (method === 'GET' && /notifications|device_tokens|unread/.test(url.pathname)) return json(rpc.includes('count') ? 0 : []);
      fixture.errors.push(`${method} ${url.pathname}`); return json({ code: 'XX000', message: 'unexpected fixture request' }, 500);
    });
    let placed = null;
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    const visible = locator => locator.filter({ visible: true });
    const button = label => visible(page.getByRole('button', { name: label, exact: true }));
    const text = value => visible(page.getByText(value, { exact: true }));
    const shot = async file => { await page.waitForTimeout(500); return page.screenshot({ path: `${shots}/${slug}-leave-${file}.png` }); };
    const stored = key => page.evaluate(k => localStorage.getItem(k), key);
    const signedIn = () => page.waitForFunction(() => document.body.innerText.includes('Your account'));
    try {
      // 1. One restaurant: the option is hidden (customer-business read happens, nothing is offered).
      await page.goto(`${server.url}/account`, { waitUntil: 'networkidle' }); await signedIn();
      await text('Sign out').waitFor();
      await page.waitForTimeout(400);
      assert.equal(await button(`Leave ${name}`).count(), 0, 'hidden while linked to one restaurant only');
      assert.equal(await visible(page.getByText(/Your account stays for the/)).count(), 0);

      // 2. Two restaurants, reached through the drawer's Account settings: shown with the other restaurant's real name.
      fixture.links = [link(slug), link(otherSlug)];
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await button('Account').click(); await button('Account settings').click(); await signedIn();
      const leave = button(`Leave ${name}`); await leave.waitFor();
      await text(`Your account stays for the ${other} app`).waitFor();
      const box = await leave.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44, 'Leave is at least 44px');
      assert.ok((await text('Sign out').boundingBox()).y < box.y, 'Leave sits below Sign out, ahead of any later Delete my account');
      await leave.evaluate(node => node.scrollIntoView({ block: 'center' })); await shot('account');
      await page.setViewportSize({ width: 1280, height: 800 }); await shot('account-desktop');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 1280');
      await page.setViewportSize({ width: 390, height: 844 });

      // 3. The sheet: honest list, focus on its heading, Escape/Cancel return focus to the trigger.
      await leave.focus(); await page.keyboard.press('Enter');
      const heading = visible(page.getByRole('heading', { name: `Leave ${name}?`, exact: true })); await heading.waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent?.startsWith('Leave ') && document.activeElement.textContent.endsWith('?'));
      for (const line of [`You'll stop getting updates and notifications from ${name} on your devices.`, 'Your saved cart here is cleared.', 'Your past orders and saved addresses stay.', `You'll be signed out of this app only. Your account stays for the ${other} app.`]) await text(line).waitFor();
      await shot('sheet');
      const confirmButton = button(`Leave ${name}`).last();
      const colours = await confirmButton.evaluate(node => { const label = node.querySelector('div,span') ?? node; return { bg: getComputedStyle(node).backgroundColor, fg: getComputedStyle(label).color }; });
      assert.ok(contrast(colours.bg, colours.fg) >= 4.5, `destructive confirm contrast ${contrast(colours.bg, colours.fg).toFixed(2)}`);
      for (const control of [confirmButton, button('Cancel')]) { const b = await control.boundingBox(); assert.ok(b.height >= 44, 'sheet buttons are at least 44px tall'); }
      await page.keyboard.press('Escape'); await heading.waitFor({ state: 'hidden' });
      await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label || document.activeElement?.textContent === label, `Leave ${name}`);
      await leave.click(); await heading.waitFor(); await button('Cancel').click(); await heading.waitFor({ state: 'hidden' });
      assert.equal(fixture.leave.length, 0, 'cancel and Escape never call the server');

      // 4. Refusals and failures show fixed copy and never raw server text.
      const attempt = async mode => { fixture.leaveMode = mode; await leave.click(); await heading.waitFor(); await confirmButton.click(); };
      await attempt('active');
      await text(`You have an order with ${name} that is not delivered or cancelled yet. You can leave once it is.`).waitFor();
      await shot('error-active-order');
      assert.equal(await stored(requestKey), null, 'a definite refusal drops the stored request ID');
      assert.equal(await button(`Try again to leave ${name}`).count(), 0, 'no retry button for a refusal that cannot change by retrying');
      await button('Close').click();
      await attempt('last'); await visible(page.getByText(/is the only restaurant on your account/)).waitFor(); await button('Close').click();
      // Pending: the second tap while the first is in flight must not send a second request (no double submit).
      fixture.leaveDelay = 500; fixture.leaveMode = 'pending'; const before = fixture.leave.length;
      await leave.click(); await heading.waitFor(); await confirmButton.evaluate(node => { node.click(); node.click(); });
      await text('Your account is being updated. Try again shortly.').waitFor();
      assert.equal(fixture.leave.length - before, 1, 'one request despite a double tap');
      fixture.leaveDelay = 0;
      const pendingId = fixture.leave.at(-1).p_request_id; assert.equal(JSON.parse(await stored(requestKey)).requestId, pendingId, 'request ID persisted before the call');
      // Network failure: fixed retry copy, same request ID reused on retry.
      fixture.leaveMode = 'network'; await button(`Try again to leave ${name}`).click();
      await text('We could not finish leaving just now. Check your connection and try again.').waitFor();
      assert.equal(fixture.leave.at(-1).p_request_id, pendingId, 'retry after a failure reuses the request ID');
      assert.doesNotMatch(await page.locator('body').innerText(), /RAW SERVER TEXT|Failed to fetch/);
      await shot('error-retry');

      // 5. Lost response (the leave committed) then Retry: same request ID, then local cleanup and local sign-out.
      fixture.leaveMode = 'lost'; await button(`Try again to leave ${name}`).click();
      await text('We could not finish leaving just now. Check your connection and try again.').waitFor();
      assert.equal(JSON.parse(await stored(cartStorageKey)).lines.length, 1, 'nothing is cleared on this phone before the server receipt');
      assert.deepEqual(fixture.logouts, [], 'not signed out before the receipt');
      await button(`Try again to leave ${name}`).focus(); await page.keyboard.press('Enter');
      await page.getByRole('status').filter({ hasText: `You left ${name}. Your account stays for the ${other} app.` }).waitFor();
      assert.equal(new Set(fixture.leave.slice(-3).map(call => call.p_request_id)).size, 1, 'every retry carried the same request ID');
      assert.deepEqual(fixture.leave.at(-1), { p_business_slug: slug, p_request_id: pendingId, p_generation: generations[slug] });
      assert.equal(JSON.parse(await stored(cartStorageKey)).lines.length, 0, 'this restaurant\'s saved cart is cleared');
      assert.equal(await stored(prefKey), null, 'this restaurant\'s preferences are cleared');
      assert.equal(await stored(requestKey), null, 'the request record is dropped once local cleanup is done');
      assert.equal(await stored(sessionKey), null, 'this app\'s session is gone');
      assert.deepEqual(fixture.logouts, ['local'], 'signed out of this app only (scope local)');
      await visible(page.getByRole('heading', { name: 'Sign in', exact: true })).waitFor();
      await shot('signed-out');

      // 6. Signing in again: Leave is not offered for the left restaurant, and checkout rejoins on request.
      await visible(page.getByLabel('Email', { exact: true })).fill('leave@example.test'); await visible(page.getByLabel('Password', { exact: true })).fill('synthetic-password');
      await button('Sign in').click(); await signedIn();
      await page.waitForTimeout(400);
      assert.equal(await button(`Leave ${name}`).count(), 0, 'a left restaurant offers no Leave');
      await page.goto(server.url, { waitUntil: 'networkidle' });
      assert.equal(await visible(page.getByText(`You left ${name}.`, { exact: false })).count(), 0, 'the post-leave notice clears on the next sign-in');
      await button('Add to cart').first().click();
      await visible(page.getByRole('button', { name: /^Cart \(/ })).click(); await text('Delivery details').waitFor();
      await visible(page.getByLabel('Name', { exact: true })).fill('Rohan Sawant'); await visible(page.getByLabel('Mobile number', { exact: true })).fill('9876543210');
      // The order is committed but its response is lost; the customer then leaves and returns, so the replay hits the relationship gate first.
      const attemptKey = `market:checkout:${slug}`;
      fixture.placeMode = 'lost'; await button('Place order').click();
      await visible(page.getByText(/The result may be uncertain/)).waitFor();
      const saved = await stored(attemptKey); assert.ok(saved, 'the attempt is saved');
      assert.equal(fixture.created, 1);
      fixture.placeMode = 'join-required'; await button('Retry order recovery').click();
      const note = page.getByRole('status').filter({ hasText: `You're back at ${name}. Press Retry order recovery to finish your order; it will not be placed twice.` }); await note.waitFor();
      assert.equal(fixture.joins, 1, 'the replay asked the server to rejoin once');
      assert.equal(await stored(attemptKey), saved, 'the saved attempt is kept, not released');
      assert.equal(await page.getByRole('alert').filter({ hasText: /back at/ }).count(), 0, 'the rejoin note is a status, not an error');
      assert.doesNotMatch(await page.locator('body').innerText(), /RAW SERVER TEXT|not been placed yet/);
      await shot('rejoin');
      fixture.placeMode = 'ok'; await button('Retry order recovery').click(); await page.waitForURL(/\/orders\//);
      assert.equal(fixture.created, 1, 'recovery returned the existing order: no second order');
      assert.equal(new Set(fixture.keys).size, 1, 'every send used the same idempotency key');
      assert.equal(fixture.orders, 3);
      assert.deepEqual(fixture.errors, [], 'no unexpected requests');
      assert.deepEqual(pageErrors, [], 'no page errors');
      console.log(`PASS: ${slug} leave hidden/shown, honest sheet, refusals, no double submit, request ID reuse, receipt-gated local cleanup, local sign-out, rejoin at checkout`);
    } finally { await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
