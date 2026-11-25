import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #182 slice C: offers in the customer cart and order screens, both brands, with the real customer and admin exports and synthetic HTTP.
// The fixture prices carts the way slice A's quote_order does (a 20% offer capped at Rs 100 above Rs 300, plus a few codes) and compares the
// accepted pricing in place_order key for key, so a payload the server would refuse fails here as pricing_changed.
// #193 adds the quote failing or hanging (a fake page clock jumps past the 8 s timeout), a cart edited while a quote is in flight, a code kept below its
// minimum, focus and the live region, and the rate-limit wording at place time.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.OFFER_SHOTS ?? 'dist/browser';
const userId = '18200000-0000-4000-8000-000000000001', orderId = '18200000-0000-4000-8000-000000000002', addressId = '18200000-0000-4000-8000-000000000003';
const autoId = '18200000-0000-4000-8000-0000000000a1', flatId = '18200000-0000-4000-8000-0000000000a2';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'offers@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'offers-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const HOME = { latitude: 17.719, longitude: 73.397 };
const address = { id: addressId, label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Sai Krupa Apartments, Bharne Naka', landmark: null, ...HOME, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 };
const bigId = '18200000-0000-4000-8000-0000000000a3';
const autoOffer = { id: autoId, name: 'Launch offer', code: null, kind: 'percent' }, flatOffer = { id: flatId, name: 'Flat 50', code: 'SAVE50', kind: 'flat' }, bigOffer = { id: bigId, name: 'Big cart', code: 'LOWMIN', kind: 'flat' };
const price = 25000, fee = 2000, minOrder = 0;

// The server's quote for a cart and an optional code.
function quote(items, itemId, code) {
  const lines = items.map(i => ({ menu_item_id: i.menu_item_id, quantity: i.quantity, unit_price_paise: price, line_total_paise: price * i.quantity }));
  const subtotal = lines.reduce((sum, l) => sum + l.line_total_paise, 0);
  let offer = null, discount = 0, offerError = null, nudge = null;
  const auto = () => { if (subtotal >= 30000) { offer = autoOffer; discount = Math.min(Math.floor(subtotal * 20 / 100), 10000); } else nudge = { offer_id: autoId, name: 'Launch offer', kind: 'percent', value: 20, shortfall_paise: 30000 - subtotal }; };
  if (code === 'SAVE50') { offer = flatOffer; discount = 5000; }
  else if (code === 'LOWMIN' && subtotal >= 100000) { offer = bigOffer; discount = 10000; } // valid from Rs 1,000; below that the server reports min_order
  else if (code) {
    offerError = { NOPE: { reason: 'not_found' }, EXPIRED: { reason: 'ended' }, LOWMIN: { reason: 'min_order', shortfall_paise: 100000 - subtotal }, RATE: { reason: 'rate_limited', retry_after_seconds: 600 }, USEDUP: { reason: 'used_up' } }[code] ?? { reason: 'not_found' };
    auto();
  } else auto();
  const pricing = { lines, delivery_fee_paise: fee, min_order_paise: minOrder, subtotal_paise: subtotal, total_paise: subtotal + fee - discount, ...(offer ? { discount_paise: discount, offer } : {}) };
  return { pricing, offerError, nudge, offer, discount };
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const businessId = `18100000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: fee, min_order_paise: minOrder, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const item = { id: '18300000-0000-4000-8000-000000000001', name: 'Offer fixture meal', description: 'Synthetic fixture', category_id: '18400000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: price, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const fx = { quotes: [], orders: [], lists: 0, mode: 'placed', placed: null, pricingChanged: 0, quoteMode: 'ok', hold: null };
    /** Gate the next quote request: it is answered (from the cart it carried) only once `release` is called. */
    const holdNextQuote = () => { let release, arrived; const promise = new Promise(r => { release = r; }), seen = new Promise(r => { arrived = r; }); fx.hold = { promise, arrived }; return { release, seen }; };
    const until = async (check, what) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 100)); assert.ok(check(), what); };
    const errors = [];
    const newContext = async (signedIn, { clock = false } = {}) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...HOME, accuracy: 12 } });
      if (clock) await context.clock.install(); // time still flows; fastForward jumps past the 8 s quote timeout
      if (signedIn) await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
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
        const path = url.pathname;
        if (path === '/auth/v1/token') return json(session);
        if (path === '/auth/v1/user') return json(user);
        if (path === '/rest/v1/businesses') return json(business);
        if (path === '/rest/v1/menu_items') return json([item]);
        if (path === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
        if (path === '/rest/v1/orders') return json(url.searchParams.has('id') ? fx.placed : fx.placed ? [fx.placed] : []);
        if (path === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
        if (path === '/rest/v1/rpc/list_addresses') return json([address]);
        if (path === '/rest/v1/rpc/list_active_offers') { fx.lists++; return json([{ id: autoId, name: 'Launch offer', kind: 'percent', value: 20, max_discount_paise: 10000, min_order_paise: 30000, first_order_only: false, ends_at: null, window: null }]); }
        if (path === '/rest/v1/rpc/quote_order') {
          const body = request.postDataJSON(); fx.quotes.push(body);
          if (fx.quoteMode === 'fail') return json({ message: 'quote exploded' }, 500);
          if (fx.quoteMode === 'hang') return new Promise(() => {}); // never answers: the page's own timeout must end it
          const q = quote(body.p_items, item.id, body.p_offer_code);
          if (fx.hold) { const held = fx.hold; fx.hold = null; held.arrived(); await held.promise; }
          return json({ outcome: 'quoted', pricing: q.pricing, offer_error: q.offerError, nudge: q.nudge });
        }
        if (path === '/rest/v1/rpc/place_order') {
          const body = request.postDataJSON(); fx.orders.push(body);
          if (fx.mode === 'ratelimited') { fx.mode = 'placed'; return json({ outcome: 'offer_changed', reason: 'rate_limited', retry_after_seconds: 600, pricing: quote(body.p_items, item.id, null).pricing }); }
          if (fx.mode === 'repriced') { fx.mode = 'placed'; const p = quote(body.p_items, item.id, null).pricing; return json({ outcome: 'pricing_changed', pricing: { ...p, discount_paise: 5000, total_paise: p.subtotal_paise + p.delivery_fee_paise - 5000 } }); }
          if (fx.mode === 'changed') { fx.mode = 'placed'; return json({ outcome: 'offer_changed', reason: 'used_up', pricing: quote(body.p_items, item.id, null).pricing }); }
          const q = quote(body.p_items, item.id, body.p_offer_code);
          try { assert.deepEqual(body.p_accepted_pricing, q.pricing); } catch { fx.pricingChanged++; return json({ outcome: 'pricing_changed', pricing: q.pricing }); }
          const p = q.pricing;
          fx.placed ??= { id: orderId, business_id: businessId, customer_id: userId, status: 'placed', version: 1, created_at: new Date().toISOString(), subtotal_paise: p.subtotal_paise, delivery_fee_paise: p.delivery_fee_paise, total_paise: p.total_paise, discount_paise: p.discount_paise ?? 0,
            ...(p.offer ? { offer_id: p.offer.id, offer_name: p.offer.name, offer_code: p.offer.code, offer_kind: p.offer.kind } : {}), customer_name: body.p_delivery.name, customer_phone: body.p_delivery.phone, delivery_address_line: 'Flat 3, Sai Krupa Apartments, Bharne Naka',
            order_items: p.lines.map(line => ({ menu_item_id: line.menu_item_id, diet: null, name: item.name, quantity: line.quantity, unit_price_paise: line.unit_price_paise, line_total_paise: line.line_total_paise })), order_status_history: [] };
          if (fx.mode === 'lost') { fx.mode = 'placed'; return route.abort('failed'); }
          return json({ outcome: 'placed', id: orderId, ...(p.discount_paise ? { discount_paise: p.discount_paise } : {}) });
        }
        throw new Error(`Unexpected offers request ${request.method()} ${path}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      const visible = locator => locator.filter({ visible: true });
      return { context, page, visible, button: name => visible(page.getByRole('button', { name, exact: true })), text: value => visible(page.getByText(value, { exact: true })), gone: value => visible(page.getByText(value, { exact: true })).waitFor({ state: 'hidden' }) };
    };
    const resetFx = () => { fx.placed = null; fx.orders.length = 0; fx.quotes.length = 0; fx.mode = 'placed'; fx.quoteMode = 'ok'; fx.hold = null; };
    const reset = async page => { await page.evaluate(key => localStorage.removeItem(`market:checkout:${key}`), slug); resetFx(); };
    try {
      // Signed out: the banner tops the menu and sits in the cart with "Sign in to apply"; there is no code entry and nothing is quoted.
      const out = await newContext(false);
      await out.page.goto(server.url, { waitUntil: 'networkidle' });
      await out.text('20% off up to ₹100 on orders above ₹300').waitFor();
      await out.page.screenshot({ path: `${shots}/${slug}-offers-menu-signed-out.png` });
      await out.button('Add to cart').first().click();
      await out.visible(out.page.getByRole('button', { name: /^Cart \(/ })).click();
      await out.text('Delivery details').waitFor();
      await out.text('20% off up to ₹100 on orders above ₹300').waitFor();
      await out.button('Sign in to apply').waitFor();
      assert.equal(await out.page.getByText('Have a code?').count(), 0, 'no code entry while signed out');
      assert.equal(fx.quotes.length, 0, 'a signed-out cart is not quoted'); assert.ok(fx.lists >= 1);
      await out.context.close();

      // Signed in.
      const kit = c => {
        const { page, visible, button, text } = c;
        const cartLink = () => visible(page.getByRole('button', { name: /^Cart \(/ }));
        const fill = async () => { await visible(page.getByLabel('Name', { exact: true })).fill('Rohan Sawant'); await visible(page.getByLabel('Mobile number', { exact: true })).fill('9876543210'); };
        const toCart = async () => {
          await page.goto(server.url, { waitUntil: 'networkidle' });
          assert.equal(await page.getByText('20% off up to ₹100 on orders above ₹300').count(), 0, 'signed in, the cart (not a banner) carries the offer');
          if (!(await cartLink().count())) await button('Add to cart').first().click();
          await cartLink().click(); await text('Delivery details').waitFor(); await fill(); await text('Deliver to Home').waitFor();
        };
        const apply = async code => { if (await button('Have a code?').count()) await button('Have a code?').click(); await visible(page.getByLabel('Offer code', { exact: true })).fill(code); await button('Apply').click(); };
        const focusedIs = label => page.waitForFunction(value => document.activeElement?.textContent === value, label);
        return { cartLink, toCart, apply, focusedIs, add: () => button('Add one Offer fixture meal').click(), placeDisabled: async () => (await button('Place order').count()) === 0 || button('Place order').isDisabled() };
      };
      const main = await newContext(true);
      const { context, page, visible, button, text, gone } = main;
      const { toCart, apply, focusedIs } = kit(main);
      const lastQuote = () => fx.quotes.at(-1);
      await toCart();

      // One dish (Rs 250) is below the Rs 300 minimum: the server's nudge, no discount, no code sent.
      await text('Add ₹50 more to get 20% off').waitFor();
      assert.equal(lastQuote().p_offer_code, null); assert.equal(await page.getByText('Discount', { exact: true }).count(), 0);
      await text('₹270').first().waitFor();
      await button('Have a code?').waitFor();
      // Two dishes: the automatic offer applies, capped at Rs 100. Total = 500 + 20 - 100.
      await button('Add one Offer fixture meal').click();
      await text('Offer applied: Launch offer').waitFor();
      await text('Saves ₹100').waitFor(); await text('−₹100').waitFor(); await text('You saved ₹100').waitFor();
      await text('₹420').first().waitFor(); assert.equal(await text('To pay').count(), 2, 'To pay in the bill and in the pinned bar');
      assert.equal(lastQuote().p_offer_code, null); assert.equal(lastQuote().p_items[0].quantity, 2);
      await page.screenshot({ path: `${shots}/${slug}-offers-cart-390.png`, fullPage: true });

      // A valid code replaces the automatic offer, shows removable, and is sent with every re-quote; removing it goes back to the automatic offer.
      await apply('save50');
      await text('Offer applied: Flat 50').waitFor(); await text('Code SAVE50').waitFor(); await text('−₹50').waitFor(); await text('₹470').first().waitFor();
      assert.equal(lastQuote().p_offer_code, 'SAVE50');
      await focusedIs('Offer applied: Flat 50'); // focus lands on the applied-offer text, not on the vanished Apply button
      // #204: remove the only dishes with the code applied, press Undo: the re-quote carries the code and the discount returns; then add the second dish back.
      await button('Remove one Offer fixture meal').click(); await text('₹270').first().waitFor();
      await button('Remove one Offer fixture meal').click();
      await text('Your cart is empty').waitFor();
      await button('Undo removing Offer fixture meal').waitFor();
      await button('Undo removing Offer fixture meal').click();
      await text('Offer applied: Flat 50').waitFor(); await text('−₹50').waitFor(); await text('₹220').first().waitFor();
      assert.equal(lastQuote().p_offer_code, 'SAVE50', 'the re-quote after Undo carries the code'); assert.equal(lastQuote().p_items[0].quantity, 1);
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add one Offer fixture meal');
      await button('Add one Offer fixture meal').click(); await text('₹470').first().waitFor();
      await button('Remove code SAVE50').click();
      await text('Offer applied: Launch offer').waitFor(); await text('₹420').first().waitFor();
      await focusedIs('Have a code?'); // and after Remove, on the way to enter another
      assert.equal(lastQuote().p_offer_code, null, 'a removed code is not sent again');

      // Refused codes: friendly text, the code is dropped and never re-sent (each refused lookup counts toward the rate limit).
      for (const [code, message] of [['nope', 'This code isn\'t valid'], ['expired', 'This code isn\'t valid'], ['usedup', 'This offer has run out'], ['rate', 'Too many tries. Try again in 10 min']]) {
        const before = fx.quotes.length;
        await apply(code);
        await text(message).waitFor();
        const region = await page.locator('[role="status"][aria-live="polite"]', { hasText: message }).first().elementHandle(); // the one live region the results are announced in
        assert.ok(region, `${code}: the message sits in a live region`);
        assert.equal(fx.quotes.length, before + 1, `${code}: one lookup`); assert.equal(lastQuote().p_offer_code, code.toUpperCase());
        await text('Offer applied: Launch offer').waitFor(); await text('₹420').first().waitFor(); // still priced with the automatic offer
        await button('Add one Offer fixture meal').click(); await page.waitForTimeout(900); await button('Remove one Offer fixture meal').click(); await page.waitForTimeout(900); // cart edits re-quote
        assert.ok(fx.quotes.length > before + 1, 'the cart was re-quoted after the edit');
        assert.equal(await page.getByText(message, { exact: true }).count(), 0, `${code}: the message is cleared once the cart changes`);
        assert.equal(await region.evaluate(node => node.isConnected), true, `${code}: the live region stays mounted while its text comes and goes`);
        assert.equal(fx.quotes.slice(before + 1).some(q => q.p_offer_code === code.toUpperCase()), false, `${code}: never re-sent after the rejection`);
      }
      await page.screenshot({ path: `${shots}/${slug}-offers-cart-rejected-390.png`, fullPage: true });

      // A valid code below its minimum is kept (the server does not count min_order as a failed try): the shortfall shows, ordering waits only while the
      // quote reports it, and the code is re-sent with each re-quote until the cart reaches the minimum.
      await apply('lowmin');
      await text('Add ₹500 more to use this code').waitFor(); await text('Code LOWMIN').waitFor();
      assert.equal(lastQuote().p_offer_code, 'LOWMIN');
      await text('Offer applied: Launch offer').waitFor(); await text('₹420').first().waitFor(); // meanwhile priced with the automatic offer
      await focusedIs('Code LOWMIN');
      assert.equal(await button('Place order').isDisabled(), true, 'Place order waits while the code is short of its minimum');
      await button('Add one Offer fixture meal').click();
      await text('Add ₹250 more to use this code').waitFor();
      assert.equal(lastQuote().p_offer_code, 'LOWMIN', 'the kept code is re-sent with the re-quote');
      await button('Add one Offer fixture meal').click();
      await text('Offer applied: Big cart').waitFor(); await text('Code LOWMIN').waitFor(); await text('−₹100').waitFor();
      assert.equal(await page.getByText(/more to use this code/).count(), 0, 'the shortfall goes once the cart reaches the minimum');
      assert.equal(await button('Place order').isDisabled(), false, 'Place order is back');
      await button('Remove code LOWMIN').click(); await text('Offer applied: Launch offer').waitFor();
      await button('Remove one Offer fixture meal').click(); await page.waitForTimeout(900); await button('Remove one Offer fixture meal').click();
      await text('₹420').first().waitFor(); // two dishes again

      // Place with the automatic offer: the accepted pricing carries the server's discount and offer (the fixture refuses anything else), no code is sent.
      await reset(page); await toCart();
      await text('Offer applied: Launch offer').waitFor();
      await button('Place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(fx.pricingChanged, 0, 'the server accepted the pricing as sent');
      assert.equal(fx.orders.length, 1); assert.equal(fx.orders[0].p_offer_code, undefined, 'no code, no p_offer_code');
      assert.equal(fx.orders[0].p_accepted_pricing.discount_paise, 10000); assert.equal(fx.orders[0].p_accepted_pricing.offer.id, autoId); assert.equal(fx.orders[0].p_accepted_pricing.total_paise, 42000);
      // The receipt: discount with the offer name, and what was paid in cash.
      await text('Discount (Launch offer)').waitFor(); await text('−₹100').waitFor(); await text('₹420 cash on delivery').waitFor();
      await page.screenshot({ path: `${shots}/${slug}-offers-receipt-390.png`, fullPage: true });
      const receiptRow = fx.placed;

      // A lost response keeps the code in the saved attempt, and the recovery replays the very same request.
      await reset(page); await toCart(); await button('Add one Offer fixture meal').click(); await text('Offer applied: Launch offer').waitFor(); await apply('SAVE50'); await text('Offer applied: Flat 50').waitFor();
      fx.mode = 'lost'; await button('Place order').click();
      await text('The result may be uncertain', { exact: false }).waitFor().catch(() => {});
      await button('Retry order recovery').waitFor();
      const saved = JSON.parse(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`));
      assert.equal(saved.offerCode, 'SAVE50'); assert.equal(fx.orders[0].p_offer_code, 'SAVE50'); assert.equal(fx.orders[0].p_accepted_pricing.total_paise, 47000);
      await button('Retry order recovery').click(); await page.waitForURL(/\/orders\//);
      assert.equal(fx.orders.length, 2); assert.deepEqual(fx.orders[1], fx.orders[0], 'recovery replays the same request, key and code included');
      assert.equal(fx.pricingChanged, 0);
      await text('Discount (Flat 50)').waitFor(); await text('−₹50').waitFor();

      // The offer changes between quote and place: nothing is ordered or retried for the customer, the code is dropped, the reason and new total show.
      await reset(page); await toCart(); await button('Add one Offer fixture meal').click(); await text('Offer applied: Launch offer').waitFor(); await apply('SAVE50'); await text('Offer applied: Flat 50').waitFor();
      fx.mode = 'changed'; await button('Place order').click();
      await text('Your offer changed: the offer has run out. Your total is now ₹420. Tap Place order to confirm.').waitFor();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), null, 'the spent attempt is released');
      await page.waitForTimeout(1200); assert.equal(fx.orders.length, 1, 'never auto-placed');
      await page.screenshot({ path: `${shots}/${slug}-offers-changed-390.png`, fullPage: true });
      await text('Offer applied: Launch offer').waitFor();
      await button('Place order').click(); await page.waitForURL(/\/orders\//);
      assert.equal(fx.orders.length, 2); assert.notEqual(fx.orders[1].p_idempotency_key, fx.orders[0].p_idempotency_key, 'a fresh key');
      assert.equal(fx.orders[1].p_offer_code, undefined); assert.equal(fx.orders[1].p_accepted_pricing.total_paise, 42000); assert.equal(fx.pricingChanged, 0);

      // The revised-order screen names the discount when the offer changed between the two quotes (old → new).
      await reset(page); await toCart(); await button('Add one Offer fixture meal').click(); await text('Offer applied: Launch offer').waitFor();
      fx.mode = 'repriced'; await button('Place order').click();
      await text('Review revised order').waitFor(); await text('Discount (Launch offer): −₹100 → −₹50').waitFor();
      await text('Total: ₹420 → ₹470').waitFor();
      await button('Edit cart').click(); await text('Review revised order').waitFor({ state: 'hidden' });
      await context.close();

      // #193: the quote fails (500) or hangs past the timeout, with and without a code; a cart edited while a quote is in flight; a rate limit at place time.
      for (const mode of ['fail', 'hang']) {
        const hang = mode === 'hang';
        const c = await newContext(true, { clock: hang });
        const k = kit(c), { page: p, button: b, text: t } = c;
        const alertText = "Couldn't check your offer.";
        const timeout = async () => { await until(() => fx.quotes.length >= asked, `${mode}: the quote was asked for`); await c.context.clock.fastForward(9000); }; // past the 8 s abort
        let asked = 0;
        // No code: the cart is priced by itself and can be ordered; the button says why it waits while the quote is pending.
        resetFx(); fx.quoteMode = mode; asked = 1;
        await k.toCart();
        if (hang) { await b('Updating your offer…').waitFor(); assert.equal(await b('Updating your offer…').isDisabled(), true, 'a pending quote disables the button, with its reason'); await timeout(); }
        await b('Place order').waitFor(); assert.equal(await b('Place order').isDisabled(), false, `${mode}: no code, so the client prices stand and ordering is open`);
        assert.equal(await p.getByRole('alert').filter({ hasText: alertText }).count(), 0, `${mode}: nothing to retry without a code`);
        await b('Place order').click(); await p.waitForURL(/\/orders\//);
        assert.equal(fx.orders.length, 1); assert.equal(fx.pricingChanged, 0); assert.equal(fx.orders[0].p_accepted_pricing.total_paise, 27000);
        // With a code: an inline alert with "Try again"; Place order is disabled but never stuck.
        resetFx(); await k.toCart(); await k.add(); await t('Offer applied: Launch offer').waitFor(); await k.apply('SAVE50'); await t('Offer applied: Flat 50').waitFor();
        fx.quoteMode = mode; asked = fx.quotes.length + 1; await k.add();
        if (hang) { await b('Updating your offer…').waitFor(); await timeout(); }
        const alert = p.getByRole('alert').filter({ hasText: alertText });
        await alert.waitFor(); await b('Try again').waitFor(); await t('Code SAVE50').waitFor();
        assert.equal(await b('Place order').isDisabled(), true, `${mode}: ordering waits while the code cannot be confirmed`);
        assert.equal(await alert.getByRole('button', { name: 'Try again', exact: true }).count(), 1, 'the retry sits inside the alert');
        asked = fx.quotes.length + 1; await b('Try again').click(); // still failing: pending, then the alert again
        if (hang) { await b('Updating your offer…').waitFor(); await timeout(); } else await until(() => fx.quotes.length >= asked, 'fail: the retry asked again');
        await alert.waitFor();
        assert.equal(lastQuote().p_offer_code, 'SAVE50', `${mode}: the retry asks about the same code`);
        fx.quoteMode = 'ok'; await b('Try again').click();
        await alert.waitFor({ state: 'hidden' }); await t('Offer applied: Flat 50').waitFor(); await t('₹720').first().waitFor();
        assert.equal(lastQuote().p_offer_code, 'SAVE50'); assert.equal(lastQuote().p_items[0].quantity, 3);
        assert.equal(await b('Place order').isDisabled(), false);
        await b('Place order').click(); await p.waitForURL(/\/orders\//);
        assert.equal(fx.pricingChanged, 0); assert.equal(fx.orders.at(-1).p_offer_code, 'SAVE50'); assert.equal(fx.orders.at(-1).p_accepted_pricing.total_paise, 72000);
        await c.context.close();
      }

      {
        // The cart is edited while a quote is in flight: that answer is never used, and what is asked and ordered is the final cart.
        const c = await newContext(true); const k = kit(c), { page: p, button: b, text: t } = c;
        resetFx(); const gate = holdNextQuote();
        await k.toCart(); await gate.seen;
        assert.equal(fx.quotes.length, 1); assert.equal(fx.quotes[0].p_items[0].quantity, 1);
        assert.equal(await b('Updating your offer…').isDisabled(), true);
        await k.add(); // two dishes while the one-dish quote is still out
        await t('Offer applied: Launch offer').waitFor(); await t('₹420').first().waitFor();
        assert.equal(fx.quotes.length, 2); assert.equal(lastQuote().p_items[0].quantity, 2);
        gate.release(); await p.waitForTimeout(900); // the stale one-dish answer (a nudge, no discount) arrives now
        assert.equal(await p.getByText('Add ₹50 more to get 20% off').count(), 0, 'the stale quote is not shown');
        await t('Offer applied: Launch offer').waitFor(); await t('₹420').first().waitFor();
        assert.equal(fx.quotes.length, 2, 'the stale answer did not trigger more quotes'); assert.equal(await b('Place order').isDisabled(), false);
        await b('Place order').click(); await p.waitForURL(/\/orders\//);
        assert.equal(fx.pricingChanged, 0); assert.equal(fx.orders.length, 1);
        assert.equal(fx.orders[0].p_items[0].quantity, 2, 'the order is for the final cart'); assert.equal(fx.orders[0].p_accepted_pricing.total_paise, 42000); assert.equal(fx.orders[0].p_accepted_pricing.discount_paise, 10000);
        await c.context.close();
      }

      {
        // OFFER_RATE_LIMITED at place time: nothing is ordered, the code is removed, the wording says why and when to try again; a cart change clears it.
        const c = await newContext(true); const k = kit(c), { page: p, button: b, text: t } = c;
        resetFx(); await k.toCart(); await k.add(); await t('Offer applied: Launch offer').waitFor(); await k.apply('SAVE50'); await t('Offer applied: Flat 50').waitFor();
        fx.mode = 'ratelimited'; await b('Place order').click();
        const message = 'Too many code tries, so we removed it. Your total is now ₹420. You can try a code again in 10 min.';
        await t(message).waitFor();
        assert.equal(await p.evaluate(key => localStorage.getItem(key), `market:checkout:${slug}`), null, 'the spent attempt is released');
        assert.equal(await p.getByText('Code SAVE50').count(), 0, 'the code is gone'); await t('Offer applied: Launch offer').waitFor();
        await p.waitForTimeout(1200); assert.equal(fx.orders.length, 1, 'never retried for the customer'); assert.equal(fx.orders[0].p_offer_code, 'SAVE50');
        const seen = fx.quotes.length;
        await b('Add one Offer fixture meal').click(); await t(message).waitFor({ state: 'hidden' }); // the message was about the old cart
        await until(() => fx.quotes.length > seen, 'the edit was re-quoted'); assert.ok(fx.quotes.slice(seen).every(q => q.p_offer_code === null), 'the removed code is not asked about again');
        await c.context.close();
      }

      // Owners: the discount line with the offer name, and "Collect in cash" is the discounted total.
      const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
      const owner = { ...user, id: '18500000-0000-4000-8000-000000000001', email: 'owner@example.test' };
      const ownerSession = { ...session, user: owner, access_token: `${part({ alg: 'HS256' })}.${part({ sub: owner.id, aud: 'authenticated', role: 'authenticated', session_id: owner.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture` };
      const octx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      await octx.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:admin`, value: ownerSession });
      await octx.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === admin.url) return route.fallback();
        assert.equal(url.origin, api, 'no third-party requests');
        const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/auth/v1/token') return json(ownerSession);
        if (url.pathname === '/auth/v1/user') return json(owner);
        if (url.pathname === '/rest/v1/businesses') return json(business);
        if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
        if (url.pathname === '/rest/v1/menu_items' || url.pathname === '/rest/v1/menu_categories') return json([]);
        if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? receiptRow : [{ ...receiptRow, order_number: 'AMS-20261125001' }]);
        throw new Error(`Unexpected owner request ${url.pathname}`);
      });
      const opage = await octx.newPage(); opage.setDefaultTimeout(15000); opage.on('pageerror', error => errors.push(error.message));
      await opage.goto(admin.url, { waitUntil: 'networkidle' });
      await visible(opage.getByRole('button', { name: 'Details for AMS-20261125001', exact: true })).click();
      const heading = visible(opage.getByRole('heading', { name: 'Rohan Sawant', level: 2, exact: true })); await heading.waitFor();
      const panel = heading.locator('xpath=ancestor::*[.//button[@aria-label="Back"]][1]');
      const inPanel = value => visible(panel.getByText(value, { exact: true }));
      await inPanel('Discount (Launch offer)').waitFor(); await inPanel('−₹100').waitFor(); await inPanel('₹500').first().waitFor();
      await inPanel('Collect in cash').waitFor();
      assert.equal(await visible(panel.locator('xpath=//*[normalize-space(text())="Collect in cash"]/ancestor::*[1]')).first().innerText().then(t => t.replace(/\s+/g, ' ')), 'Collect in cash ₹420', 'cash is the discounted total, not subtotal plus delivery (₹520)');
      await opage.screenshot({ path: `${shots}/${slug}-offers-owner-details-390.png`, fullPage: true });
      await octx.close(); await admin.close?.();
      assert.deepEqual(errors, [], `${slug}: no page errors`);
      console.log(`PASS: ${slug} customer offers (#182): banner, nudge, automatic offer, code apply/remove, refused codes dropped and not re-sent, payloads, recovery replay, OFFER_CHANGED re-confirm, revised-order discount, receipt and owner cash; #193: quote failure and timeout with and without a code, stale quote ignored, min_order kept, focus and live region, place-time rate limit`);
    } finally { await server.close?.(); }
  }
} finally { await browser.close(); }
