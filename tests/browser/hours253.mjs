import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #253 slice 2, customer apps: opening hours. Real built exports of both brands, installed SDK, synthetic HTTP only.
// Every restaurant here has explicit hours and the page's clock is set per journey (the shared test seed has none), so nothing
// depends on the real time of day: all other journeys keep null hours.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W253_SHOTS || 'dist/browser';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const userId = '25300000-0000-4000-8000-000000000001', orderId = '25300000-0000-4000-8000-000000000002';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'hours-fixture@example.test', user_metadata: {}, app_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: '25300000-0000-4000-8000-000000000003', exp: Math.floor(Date.now() / 1000) + 86400 * 3 })}.fixture`, refresh_token: 'hours-fixture', expires_in: 86400 * 3, expires_at: Math.floor(Date.now() / 1000) + 86400 * 3, token_type: 'bearer', user };
const visible = locator => locator.filter({ visible: true });
const ist = (clock, day = '2026-12-02') => Date.parse(`${day}T${clock}+05:30`);
const brands = [
  { slug: 'ammu-sammu', name: 'Ammu Sammu', opens: '09:00:00', closes: '19:30:00', fact: /^Open 9 am to 7:30 pm · /, closedLead: 'Closed now · Opens at 9 am', rest: 'You can still look at the menu.', before: '08:59:48', after: '19:29:48', earlyMorning: '06:00:00' },
  { slug: 'kokani-dine-inn', name: 'Kokani Dine Inn', opens: '11:00:00', closes: '00:00:00', fact: /^Open 11 am to 12 am \(midnight\) · /, closedLead: 'Closed now · Opens at 11 am', rest: 'Browse the menu and order when the kitchen opens.', before: '10:59:48', after: '23:59:48', earlyMorning: '06:00:00' },
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [], pages = [];
try {
  for (const [index, brand] of brands.entries()) {
    const { slug } = brand, server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const businessId = `25100000-0000-4000-8000-00000000000${index + 1}`;
    const item = { id: '25200000-0000-4000-8000-000000000001', name: 'Hours fixture meal', description: 'Synthetic availability fixture', category_id: '25300000-0000-4000-8000-000000000011', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const business = { id: businessId, slug, name: brand.name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true, opens_at: brand.opens, closes_at: brand.closes };
    const state = { businesses: 0, placed: [], quotes: 0, outside: false, order: null };
    const outsideError = { code: 'PT409', message: 'restaurant is outside its opening hours', details: 'OUTSIDE_HOURS', hint: brand.opens };
    const historical = { id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, created_at: '2026-12-02T06:30:00Z', subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: 'Synthetic customer', customer_phone: '9876543210', delivery_address_line: 'Flat 3, Bharne Naka', order_items: [{ menu_item_id: item.id, diet: null, name: item.name, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [] };
    /** A fresh browser page whose clock is `clock` o'clock India time on 2 Dec 2026 and keeps running. */
    const open = async (clock, { signedIn = false } = {}) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: 0.5, longitude: 0.5, accuracy: 10 } });
      if (signedIn) await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, i) => ({ ...change, id: i + 1 })) } };
        socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === server.url) return route.fallback();
        assert.equal(url.origin, api, 'no unconfigured third-party calls');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        switch (url.pathname) {
          case '/auth/v1/token': return json(session);
          case '/auth/v1/user': return json(user);
          case '/rest/v1/businesses': state.businesses++; return json(business);
          case '/rest/v1/menu_items': return json([item]);
          case '/rest/v1/menu_categories': return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
          case '/rest/v1/customer_businesses': return json([]);
          case '/rest/v1/rpc/list_active_offers': return json([]);
          case '/rest/v1/rpc/customer_notification_unread_count': return json(0);
          case '/rest/v1/rpc/quote_order': state.quotes++; return state.outside ? json(outsideError, 409) : json({ outcome: 'quoted', pricing: null, offer_error: null, nudge: null });
          case '/rest/v1/rpc/list_addresses': return json([{ id: '25400000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Bharne Naka', landmark: null, latitude: 0.5, longitude: 0.5, location_source: 'pin', version: 1, updated_at: '2026-12-01T10:00:00Z', in_area: true, distance_m: 1200 }]);
          case '/rest/v1/orders': return json(url.searchParams.has('id') ? state.order ?? historical : [state.order ?? historical]);
          case '/rest/v1/rpc/place_order': {
            const body = request.postDataJSON(); state.placed.push(body);
            if (state.outside) return json(outsideError, 409);
            const terms = body.p_accepted_pricing;
            state.order = { ...historical, subtotal_paise: terms.subtotal_paise, delivery_fee_paise: terms.delivery_fee_paise, total_paise: terms.total_paise, order_items: terms.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })) };
            return json({ outcome: 'placed', id: orderId });
          }
          default: throw new Error(`Unexpected hours fixture ${request.method()} ${url.pathname}`);
        }
      });
      const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: ist(clock) });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      return { context, page };
    };
    const ui = page => ({
      notice: () => visible(page.getByText(brand.closedLead, { exact: true })).first(),
      add: () => visible(page.getByRole('button', { name: 'Add to cart', exact: true })),
      cart: () => visible(page.getByRole('button', { name: /^Cart \(/ })),
      button: name => visible(page.getByRole('button', { name, exact: true })),
      field: name => visible(page.getByLabel(name, { exact: true })),
      dish: () => visible(page.getByText(item.name, { exact: true })),
      saved: () => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), `market:cart:${slug}`),
    });
    const fillCheckout = async u => { await u.field('Name').fill('Synthetic checkout name'); await u.field('Mobile number').fill('9876543210'); await visible(u.field('Name').page().getByText('Deliver to Home', { exact: true })).waitFor(); };
    const place = async u => { await u.button('Place order').click(); const yes = u.button('Yes, place order'); if (await yes.waitFor({ timeout: 2000 }).then(() => true, () => false)) await yes.click(); };
    try {
      // 1. Closed by hours: the menu stays browsable, "Closed now · Opens at ..." says when, ordering is blocked.
      {
        const { context, page } = await open(brand.earlyMorning), u = ui(page);
        await u.notice().waitFor();
        await visible(page.getByText(brand.rest)).first().waitFor();
        await visible(page.getByText('Your saved cart is kept for later.', { exact: true })).first().waitFor();
        await u.dish().waitFor();
        await visible(page.getByText(brand.fact)).first().waitFor();
        assert.equal(await u.add().count(), 0, 'no Add buttons while closed by hours'); assert.equal(await u.cart().count(), 0);
        assert.equal(await visible(page.getByText('Not taking orders right now.')).count() + await visible(page.getByText("The kitchen isn't taking orders right now.")).count(), 0, 'it is the hours notice, not the owner switch notice');
        for (const width of [320, 390, 1440]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
          assert.equal(await u.notice().evaluate(node => node.parentElement.scrollWidth <= node.parentElement.clientWidth), true, 'notice wraps');
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await u.notice().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/${slug}-closed-by-hours.png`, fullPage: true });
        const dialogOpen = u.button(`View details for ${item.name}`); await dialogOpen.click();
        const dialog = page.getByRole('dialog'); await dialog.getByText(`${brand.closedLead}. ${brand.rest}`, { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: /^Add · / }).count(), 0, 'dish details cannot add while closed by hours');
        await page.keyboard.press('Escape');
        assert.equal(state.placed.length, 0);
        await context.close();
      }
      // 2. The page re-evaluates at the opening and closing instants by itself: no reload, no polling, same restaurant fetches.
      {
        const { context, page } = await open(brand.before), u = ui(page);
        await u.notice().waitFor(); assert.equal(await u.add().count(), 0);
        await u.dish().waitFor(); const loads = state.businesses;
        await u.notice().waitFor({ state: 'hidden' }); await u.add().first().waitFor(); // the page's own timer, about 12 seconds of real time after the clock was set
        assert.equal(state.businesses, loads, 'opening is a timer, not a reload');
        await visible(page.getByText(brand.fact)).first().waitFor();
        await u.add().first().click(); await u.cart().waitFor(); await u.cart().click();
        await u.button('Place order').waitFor(); assert.equal(await u.button('Place order').isDisabled(), false, 'open: Place order is enabled');
        await context.close();
      }
      {
        // Closing: a customer with a cart is looking at the page when the closing instant passes.
        const { context, page } = await open(brand.after), u = ui(page);
        await u.add().first().click(); await u.cart().waitFor(); await u.cart().click();
        await u.button('Place order').waitFor(); assert.equal(await u.button('Place order').isDisabled(), false, 'open: Place order is enabled');
        const cart = await u.saved(), loads = state.businesses;
        await u.notice().waitFor(); await eventually(async () => await u.button('Place order').isDisabled());
        assert.equal(await u.button(`Add one ${item.name}`).count(), 0, 'no stepper while closed');
        assert.deepEqual((({ revision, ...rest }) => rest)(await u.saved()), (({ revision, ...rest }) => rest)(cart), 'the saved cart is kept');
        await visible(page.getByText('Your saved cart is kept for later.', { exact: true })).first().waitFor();
        assert.equal(state.placed.length, 0, 'closing never submits anything'); assert.equal(state.businesses, loads, 'closing is a timer, not a reload');
        await page.screenshot({ path: `${shots}/${slug}-closed-by-hours-cart.png`, fullPage: true });
        // Showing the app again re-checks the clock (a device that slept through the boundary): the time moves on a day, nothing else happens.
        await page.clock.setSystemTime(ist(brand.opens, '2026-12-03') + 2000);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await u.notice().waitFor({ state: 'hidden' }); await eventually(async () => (await u.button('Place order').isDisabled()) === false);
        assert.equal(state.placed.length, 0);
        await context.close();
      }
      // 3. Within hours, a signed-in customer orders normally (no notice, nothing blocked).
      {
        const { context, page } = await open('12:00:00', { signedIn: true }), u = ui(page);
        await u.add().first().waitFor(); assert.equal(await u.notice().count(), 0);
        await visible(page.getByText(brand.fact)).first().waitFor();
        await u.add().first().click(); await u.cart().click(); await fillCheckout(u);
        await place(u);
        await visible(page.getByText('Your order is with the restaurant', { exact: true })).waitFor();
        assert.equal(state.placed.length, 1); await context.close();
      }
      // 4. The server refuses (the device clock is wrong: it says open): the notice appears and stays. No reload loop, no resubmit.
      {
        state.placed.length = 0; state.order = null; state.outside = false;
        const { context, page } = await open('12:00:00', { signedIn: true }), u = ui(page);
        await u.add().first().click(); await u.cart().click(); await fillCheckout(u);
        await eventually(async () => (await u.button('Place order').isDisabled()) === false);
        state.outside = true; const loads = state.businesses;
        await place(u);
        await u.notice().waitFor(); assert.equal(await u.button('Place order').isDisabled(), true);
        assert.equal(state.placed.length, 1, 'refused once');
        await u.notice().waitFor(); assert.equal(await u.button('Place order').isDisabled(), true, 'the reload does not reopen it');
        let settled = -1; for (let i = 0; i < 40 && settled !== state.businesses; i++) { settled = state.businesses; await new Promise(resolve => setTimeout(resolve, 600)); } // the reload that follows a refusal finishes
        await new Promise(resolve => setTimeout(resolve, 1500));
        assert.equal(state.businesses, settled, `the restaurant is not re-read over and over (${settled - loads} reads after the refusal, then none)`);
        assert.equal(state.businesses, settled, `the restaurant is not re-read over and over (${settled - loads} reads after the refusal, then none)`);
        await u.notice().waitFor(); assert.equal(await u.button('Place order').isDisabled(), true);
        assert.equal(state.placed.length, 1, 'nothing is resent'); assert.equal((await u.saved()).lines.length, 1, 'the cart is kept');
        assert.equal(await visible(page.getByText(/Please check your details and try again/)).count(), 0);
        await page.screenshot({ path: `${shots}/${slug}-closed-by-server-hours.png`, fullPage: true });
        await context.close();
      }
      // 5. Prices are not silently dropped when the quote is refused outside hours: the reason is shown instead.
      {
        state.outside = true; state.quotes = 0;
        const { context, page } = await open('12:00:00', { signedIn: true }), u = ui(page);
        await u.add().first().click(); await u.cart().click();
        await u.notice().waitFor(); assert.ok(state.quotes >= 1, 'the cart asked for a quote');
        assert.equal(await visible(page.getByText(/Couldn.t check your offer/)).count(), 0);
        await visible(page.getByText('₹100', { exact: false })).first().waitFor();
        assert.equal(await u.button('Place order').isDisabled(), true);
        await context.close(); state.outside = false;
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} opening hours (#253): hours fact, closed-by-hours notice and blocked ordering, timer-driven opening and closing, in-hours order, server OUTSIDE_HOURS refusal without a loop, refused quote shows the reason`);
    } catch (error) {
      for (const [n, page] of pages.entries()) await page.screenshot({ path: `${shots}/${slug}-hours-failure-${n}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await server.close(); }
  }
} finally { await browser.close(); }

async function eventually(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
