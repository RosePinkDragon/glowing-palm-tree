import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// Installed SDK and real owner/customer exports, with synthetic HTTP/Phoenix only.
const api = 'https://market-fixture.supabase.co';
const visible = locator => locator.filter({ visible: true });
const users = ['owner-a', 'owner-b', 'other-owner', 'customer'].map((name, index) => ({ id: `58500000-0000-4000-8000-00000000000${index + 1}`, email: `${name}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function actor(request) { const token = request.headers().authorization?.replace('Bearer ', ''); try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; } catch { return null; } }
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`), customer = await serveWeb(`apps/${slug}-customer/dist/web`);
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', businessId = `58600000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: false };
    const item = { id: '58700000-0000-4000-8000-000000000001', business_id: businessId, name: 'Owner switch fixture meal', description: 'Synthetic availability fixture', category_id: '58800000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const order = { id: '58900000-0000-4000-8000-000000000001', business_id: businessId, customer_id: users[3].id, status: 'placed', version: 1, created_at: '2026-11-15T10:00:00Z', subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: 'Synthetic customer', customer_phone: '9876543210', delivery_address_line: 'Synthetic address', order_items: [{ menu_item_id: item.id, name: item.name, diet: null, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [] };
    const contexts = [], channels = new Map(), errors = [], writes = [], transitions = [];
    let nextWrite = 'ok', writeGate = null, readGate = null, failReads = null;
    const send = (channel, event, payload) => channel.socket.send(JSON.stringify(channel.array ? [channel.join, null, channel.topic, event, payload] : { join_ref: channel.join, ref: null, topic: channel.topic, event, payload }));
    const broadcast = (table = 'businesses') => {
      for (const channel of channels.values()) {
        const matching = channel.changes.filter(change => change.table === table);
        if (matching.length) send(channel, 'postgres_changes', { ids: matching.map(change => change.id), data: { schema: 'public', table, type: 'UPDATE', commit_timestamp: new Date().toISOString(), columns: [], record: { ...(table === 'businesses' ? business : order) }, old_record: {} } });
      }
    };
    const open = async (user, audience = 'admin') => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); contexts.push(context);
      if (user) await context.addInitScript(({ slug, session }) => { const key = `market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:admin`; if (!sessionStorage.getItem('owner-fixture-initialized')) { sessionStorage.setItem('owner-fixture-initialized', 'yes'); localStorage.setItem(key, JSON.stringify(session)); } }, { slug, session: session(user) });
      await context.routeWebSocket(/.*/, socket => {
        assert.equal(new URL(socket.url()).origin, 'wss://market-fixture.supabase.co');
        socket.onClose(() => { for (const [topic, channel] of channels) if (channel.socket === socket) channels.delete(topic); });
        socket.onMessage(message => {
          const data = JSON.parse(String(message)), array = Array.isArray(data);
          const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
          const changes = (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 }));
          if (event === 'phx_join') channels.set(topic, { context, socket, join, topic, array, changes });
          if (event === 'phx_leave') channels.delete(topic);
          if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) {
            const response = { status: 'ok', response: { postgres_changes: changes } };
            socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
          }
        });
      });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), who = actor(request);
        if ([admin.url, customer.url].includes(url.origin)) return route.fallback();
        assert.equal(url.origin, api, 'no unconfigured third-party requests');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/auth/v1/token') { const input = request.postDataJSON(); return json(session(users.find(value => value.email === input.email || value.id === input.refresh_token) ?? users[0])); }
        if (url.pathname === '/auth/v1/user') return json(users.find(value => value.id === who) ?? users[0]);
        if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
        if (url.pathname === '/rest/v1/businesses') {
          assert.equal(request.method(), 'GET', 'owners must not directly update business columns');
          const snapshot = { ...business }, held = readGate?.context === context ? readGate : null;
          if (held) { readGate = null; held.arrived.resolve(); await held.release.promise; }
          if (failReads === context) return json({ message: 'Synthetic restaurant-status refresh failure' }, 503);
          await json(snapshot); held?.done.resolve(); return;
        }
        if (url.pathname === '/rest/v1/business_memberships') return json([users[0].id, users[1].id].includes(who) ? { role: 'admin' } : null);
        if (url.pathname === '/rest/v1/menu_items') return json([item]);
        if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
        if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? order : [order]);
        if (url.pathname === '/rest/v1/rpc/set_accepting_orders') {
          const body = request.postDataJSON(); assert.deepEqual(Object.keys(body).sort(), ['p_accepting', 'p_business_slug']); assert.equal(body.p_business_slug, slug);
          assert.ok([users[0].id, users[1].id].includes(who), 'only same-business owner calls the mutation');
          writes.push({ actor: who, body }); const mode = nextWrite; nextWrite = 'ok'; const held = writeGate; writeGate = null;
          if (held) { held.arrived.resolve(); await held.release.promise; }
          if (mode === 'fail') return json({ code: '42501', message: 'Synthetic owner mutation refusal' }, 403);
          business.accepting_orders = body.p_accepting; broadcast();
          if (mode === 'lost') return route.abort('failed');
          return json({ business_id: businessId, accepting_orders: business.accepting_orders });
        }
        if (url.pathname === '/rest/v1/rpc/transition_order') {
          const body = request.postDataJSON(); transitions.push(body); assert.equal(body.p_expected_version, order.version);
          order.status = body.p_status; order.version++; broadcast('orders'); return json({ id: order.id });
        }
        throw new Error(`Unexpected owner fixture ${request.method()} ${url.pathname}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(audience === 'admin' ? admin.url : customer.url, { waitUntil: 'networkidle' });
      return { context, page };
    };
    const control = page => page.getByRole('switch', { name: `Take new orders at ${name}`, exact: true });
    const text = (page, label) => visible(page.getByText(label, { exact: true }));
    const button = (page, label) => visible(page.getByRole('button', { name: label, exact: true }));
    const status = async (page, open) => { await text(page, open ? 'Open · taking orders' : 'Closed · not taking orders').waitFor(); await eventually(async () => await control(page).isEnabled() && await control(page).isChecked() === open); };
    const toggle = async (page, open) => { await status(page, !open); await control(page).click(); await status(page, open); };
    let first, second, guest;
    try {
      first = await open(users[0]); second = await open(users[1]); guest = await open(null, 'customer');
      await status(first.page, false); await status(second.page, false);
      const customerClosed = brand ? "The kitchen isn't taking orders right now. Browse the menu and check back a little later." : 'Not taking orders right now. You can still look at the menu. Check back a little later.';
      await text(guest.page, customerClosed).waitFor();
      const pending = { arrived: deferred(), release: deferred() }; writeGate = pending;
      await control(first.page).focus(); await first.page.keyboard.press('Space'); await pending.arrived.promise;
      await text(first.page, 'Saving restaurant status…').waitFor(); assert.equal(await control(first.page).isDisabled(), true);
      await first.page.keyboard.press('Space'); assert.equal(writes.length, 1, 'pending control cannot submit twice');
      assert.equal(business.accepting_orders, false, 'no client-side success before server confirmation');
      pending.release.resolve(); await status(first.page, true); await status(second.page, true);
      await button(guest.page, 'Add to cart').waitFor();
      await toggle(second.page, false); await status(first.page, false); await text(guest.page, customerClosed).waitFor();
      assert.equal(await button(guest.page, 'Add to cart').count(), 0); assert.equal(business.ordering_enabled, true);
      for (const width of [320, 390, 1440]) {
        await first.page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        const card = text(first.page, 'Orders placed before closing carry on as normal.').locator('..');
        await card.evaluate(node => node.scrollIntoView({ block: 'start' }));
        assert.equal(await text(first.page, 'Closed · not taking orders').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'status wraps');
        await card.screenshot({ path: `dist/browser/${slug}-owner-closed-${width}.png` });
      }
      await first.page.setViewportSize({ width: 390, height: 844 });
      await button(first.page, 'View details').click(); await button(first.page, 'Mark accepted').click();
      await text(first.page, 'Order updated to Accepted.').waitFor(); assert.equal(transitions.length, 1); assert.equal(business.accepting_orders, false);
      console.log(`PASS: ${slug} keyboard owner switch confirms one pending request, synchronizes another owner and guest customer, and leaves earlier orders actionable`);

      nextWrite = 'fail'; const beforeFailure = writes.length; await control(first.page).click();
      await text(first.page, 'The change request was not confirmed. The latest restaurant status is shown.').waitFor(); await status(first.page, false);
      assert.equal(writes.length, beforeFailure + 1, 'failed write is not repeated automatically');
      nextWrite = 'lost'; const beforeLost = writes.length; await control(first.page).click();
      await text(first.page, 'The change request was not confirmed. The latest restaurant status is shown.').waitFor(); await status(first.page, true); await status(second.page, true);
      assert.equal(writes.length, beforeLost + 1, 'committed lost response is followed by reads, not a second mutation');
      const held = { context: first.context, arrived: deferred(), release: deferred(), done: deferred() }; readGate = held; broadcast(); await held.arrived.promise;
      await eventually(() => control(first.page).isDisabled());
      await toggle(second.page, false); await status(first.page, false);
      held.release.resolve(); await held.done.promise; await first.page.waitForLoadState('networkidle'); await status(first.page, false);
      console.log(`PASS: ${slug} refused/lost mutations refresh actual truth without replay, and an older held read cannot overwrite a newer owner change`);

      for (const channel of channels.values()) if (channel.context === first.context && channel.changes.some(change => change.table === 'businesses')) send(channel, 'phx_error', {});
      await text(first.page, 'Restaurant status unavailable').waitFor(); assert.equal(await control(first.page).isDisabled(), true);
      const beforeReconnect = writes.length; failReads = first.context; await button(first.page, 'Refresh restaurant status').click();
      await visible(first.page.getByText(/Synthetic restaurant-status refresh failure/)).first().waitFor(); assert.equal(await control(first.page).isDisabled(), true);
      failReads = null; await button(first.page, 'Refresh restaurant status').click(); await status(first.page, false); assert.equal(writes.length, beforeReconnect);
      business.ordering_enabled = false; business.accepting_orders = true; broadcast();
      await text(first.page, 'Kitchen marked open · ordering setup pending').waitFor(); await eventually(() => control(first.page).isEnabled());
      assert.equal(await control(first.page).isChecked(), true); assert.equal(await button(guest.page, 'Add to cart').count(), 0);
      await control(first.page).click(); await status(first.page, false); assert.equal(business.ordering_enabled, false, 'kitchen control never enables setup');
      business.ordering_enabled = true; broadcast(); await status(first.page, false);
      const beforeDenied = writes.length;
      for (const outsider of [users[2], users[3]]) { const denied = await open(outsider); await text(denied.page, 'Access denied').waitFor(); assert.equal(await control(denied.page).count(), 0); await denied.context.close(); }
      assert.equal(writes.length, beforeDenied);
      console.log(`PASS: ${slug} disconnect/retry uses reads only, setup remains developer-controlled, and customer/other-business owners never receive the switch`);

      const late = { arrived: deferred(), release: deferred() }; writeGate = late; await control(first.page).click(); await late.arrived.promise;
      await button(first.page, 'Sign out').click(); await button(first.page, 'Sign in').waitFor(); assert.equal(await control(first.page).count(), 0);
      await visible(first.page.getByLabel('Email', { exact: true })).fill(users[3].email); await visible(first.page.getByLabel('Password', { exact: true })).fill('synthetic-password');
      await button(first.page, 'Sign in').click(); await text(first.page, 'Access denied').waitFor(); late.release.resolve();
      await status(second.page, true); assert.equal(await control(first.page).count(), 0); await text(first.page, 'Access denied').waitFor();
      assert.equal(await text(first.page, 'Restaurant status updated.').count(), 0, 'old owner completion cannot appear in the next identity');
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} logout/account switch isolates a held old-owner mutation and its late completion`);
    } catch (error) {
      if (first) await first.page.screenshot({ path: `dist/browser/${slug}-owner-switch-failure.png`, fullPage: true }); throw error;
    } finally { readGate?.release.resolve(); writeGate?.release.resolve(); for (const context of contexts) await context.close(); await admin.close(); await customer.close(); }
  }
} finally { await browser.close(); }

async function eventually(check) {
  for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
