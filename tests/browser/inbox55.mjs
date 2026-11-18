import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #55 notifications inbox: list, paging, unread -> read, badge, empty, error + retry, signed out; both brands.
// Real customer exports and the installed SDK, with deterministic synthetic RPC responses.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.SHOTS_DIR;
const userId = '55100000-0000-4000-8000-000000000001';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'inbox@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'inbox-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
// One fixed instant (default 12:00 in India) for every timestamp and the browser clock, so day grouping never depends on when the test runs.
// INBOX_NOW overrides it (e.g. just after IST midnight) to prove the grouping follows the anchor.
const anchor = Date.parse(process.env.INBOX_NOW ?? '2026-11-18T06:30:00Z'); assert.ok(Number.isFinite(anchor), 'INBOX_NOW must be an ISO instant');
const at = () => new Date(anchor).toISOString();
const istDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const notificationId = n => `55200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const orderId = n => `55300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir('dist/browser', { recursive: true }); if (shots) await mkdir(shots, { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', prefix = brand ? 'KDI' : 'AMS';
    const businessId = `55400000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    // 2 unread + 1 read recent, then 22 older read rows (25 in all, so a second page of 5 exists).
    const recent = [5, 10, 15].map(minutes => new Date(anchor - minutes * 60000).toISOString());
    const recentDays = new Set(recent.map(iso => istDay(Date.parse(iso)))).size;
    const seed = () => [
      { id: notificationId(25), order_id: orderId(25), event_status: 'preparing', title: 'Your food is being prepared', body: `${name} accepted order ${prefix}-2026111025 and started cooking.`, read_at: null, created_at: recent[0] },
      { id: notificationId(24), order_id: orderId(24), event_status: 'placed', title: 'Order placed', body: `We've sent order ${prefix}-2026111024 to ${name}, cash on delivery.`, read_at: null, created_at: recent[1] },
      { id: notificationId(23), order_id: orderId(23), event_status: 'delivered', title: 'Delivered', body: `Order ${prefix}-2026111023 has arrived.`, read_at: recent[2], created_at: recent[2] },
      ...Array.from({ length: 22 }, (_, i) => ({ id: notificationId(22 - i), order_id: orderId(22 - i), event_status: 'delivered', title: `Delivered ${22 - i}`, body: `Order ${prefix}-20261104${String(22 - i).padStart(2, '0')} has arrived.`, read_at: '2026-11-04T09:00:00Z', created_at: `2026-11-04T08:${String(59 - i).padStart(2, '0')}:00Z` })),
    ].map(row => ({ ...row, user_id: userId, business_id: businessId }));
    const fixture = { rows: seed(), failList: false, failMore: false, calls: [], reads: [], readAll: 0, pushOn: true };
    const unread = () => fixture.rows.filter(row => !row.read_at).length;
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const errors = [];
    const open = async (signedIn, viewport) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', timezoneId: 'Asia/Kolkata' });
      await context.clock.install({ time: anchor });
      if (signedIn) await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
        if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        // The static test server only rewrites known routes to the app; /notifications is served as the app document here.
        if (url.origin === server.url && url.pathname === '/notifications') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: await readFile(`apps/${slug}-customer/dist/web/index.html`, 'utf8') });
        if (url.origin === server.url) return route.fallback();
        assert.equal(url.origin, api, 'no third-party requests');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname === '/auth/v1/token') return json(session);
        if (url.pathname === '/auth/v1/user') return json(user);
        if (url.pathname === '/rest/v1/businesses') return json(business);
        if (['/rest/v1/menu_items', '/rest/v1/menu_categories', '/rest/v1/orders'].includes(url.pathname)) return json([]);
        if (url.pathname === '/rest/v1/rpc/list_addresses') return json([]);
        if (url.pathname.startsWith('/rest/v1/rpc/') && /notification/.test(url.pathname)) {
          const body = request.postDataJSON(), rpc = url.pathname.split('/').pop();
          assert.equal(body.p_business_slug, slug, 'only this restaurant');
          if (rpc === 'customer_notification_unread_count') return json(unread());
          if (rpc === 'mark_all_customer_notifications_read') { fixture.readAll++; const n = unread(); fixture.rows.forEach(row => { row.read_at ??= at(); }); return json(n); }
          if (rpc === 'mark_customer_notification_read') { fixture.reads.push(body.p_notification_id); const row = fixture.rows.find(item => item.id === body.p_notification_id); const was = !!row && !row.read_at; if (row) row.read_at ??= at(); return json(was); }
          if (rpc === 'list_customer_notifications') {
            fixture.calls.push(body);
            if (fixture.failList || (fixture.failMore && body.p_before_id)) return json({ code: 'XX000', message: 'raw internal failure detail' }, 500);
            const sorted = [...fixture.rows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
            const after = body.p_before_id ? sorted.filter(row => row.created_at < body.p_before_created_at || (row.created_at === body.p_before_created_at && row.id < body.p_before_id)) : sorted;
            return json(after.slice(0, body.p_limit + 1));
          }
        }
        throw new Error(`Unexpected inbox fixture ${request.method()} ${url.pathname}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      return { context, page };
    };
    const visible = locator => locator.filter({ visible: true });
    try {
      const { context, page } = await open(true, { width: 390, height: 844 });
      const button = label => visible(page.getByRole('button', { name: label, exact: true }));
      const text = value => visible(page.getByText(value, { exact: true }));
      const shot = async (file, full = false, p = page) => { if (!shots) return; await p.waitForTimeout(500); await p.screenshot({ path: `${shots}/${slug}-${file}.png`, fullPage: full }); };
      // Reached from the account drawer, which shows the unread count.
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await button('Account').click();
      await button('Notifications (2 unread)').waitFor();
      const badge = visible(page.getByTestId('unread-badge')); await badge.waitFor();
      const bb = await badge.boundingBox(), lb = await badge.locator('xpath=preceding-sibling::*[1]').boundingBox();
      assert.ok(bb.width >= 21.5 && bb.height >= 21.5 && bb.x - (lb.x + lb.width) >= 6, JSON.stringify({ bb, lb }) + ' ' + 'rounded pill badge with a gap from the label');
      await shot('drawer-badge-390');
      await button('Notifications (2 unread)').click();
      await text('Your food is being prepared').waitFor();
      assert.equal(await visible(page.getByRole('heading', { name: 'Notifications', exact: true })).count(), 1, 'one Notifications heading (the navigation header), no in-page duplicate');
      assert.equal(new URL(page.url()).pathname, '/notifications');
      // List: newest first, grouped by day, unread marked, 20 of 25 on the first page.
      await text('Your food is being prepared').waitFor();
      await text(`${name} accepted order ${prefix}-2026111025 and started cooking.`).waitFor();
      await text('4 November').waitFor();
      await text('Updates from the last 30 days are kept here.').waitFor();
      await text('2 unread').waitFor();
      assert.equal(await visible(page.getByTestId('unread-dot')).count(), 2, 'only unread rows carry the dot');
      assert.equal(await visible(page.getByRole('button', { name: /^Unread\. /, })).count(), 2);
      assert.equal(await visible(page.getByTestId('notification-day')).count(), recentDays + 1, 'one grouped list per day');
      assert.equal(await visible(page.getByTestId('status-icon')).count(), 20, 'a status icon on every row');
      assert.equal(await visible(page.getByRole('button', { name: 'Refresh', exact: true })).count(), 0, 'no separate Refresh button');
      const titles = await visible(page.getByRole('button', { name: /Opens your order\.$/ })).count();
      assert.equal(titles, 20, 'first page');
      assert.equal(fixture.calls.at(-1).p_limit, 20); assert.equal(fixture.calls.at(-1).p_before_id, null);
      await shot('inbox-390', true);
      // Paging: Load more uses the keyset cursor of the last row; nothing is duplicated.
      await button('Load more').focus(); await page.keyboard.press('Enter');
      await text('Delivered 1').waitFor();
      assert.equal(fixture.calls.at(-1).p_before_id, notificationId(6), 'cursor is the last row of page one');
      assert.equal(await visible(page.getByRole('button', { name: /Opens your order\.$/ })).count(), 25);
      assert.equal(await button('Load more').count(), 0, 'no more pages');
      // Tap: opens the order and marks exactly that row read; the badge count follows.
      await page.evaluate(() => window.scrollTo(0, 0));
      await visible(page.getByRole('button', { name: /^Unread\. Order placed/ })).click();
      await page.waitForURL(url => url.pathname === `/orders/${orderId(24)}`);
      await page.waitForTimeout(300);
      assert.deepEqual(fixture.reads, [notificationId(24)], 'the RPC marks only the tapped notification');
      await page.goBack(); await text('1 unread').waitFor();
      assert.equal(await visible(page.getByTestId('unread-dot')).count(), 1);
      assert.equal(unread(), 1, 'server and screen agree');
      await button('Account').click(); await button('Notifications (1 unread)').waitFor();
      await button('Notifications (1 unread)').click(); await text('1 unread').waitFor();
      // Mark all read: nothing unread afterwards, badge gone.
      await button('Mark all read').click(); await text('All caught up').waitFor();
      assert.equal(fixture.readAll, 1); assert.equal(await visible(page.getByTestId('unread-dot')).count(), 0);
      assert.equal(await button('Mark all read').count(), 0);
      await button('Account').click(); await button('Notifications').waitFor();
      await button('Close').click();
      // Opening the screen again picks up a new update without realtime.
      fixture.rows.unshift({ id: notificationId(30), order_id: orderId(30), event_status: 'accepted', title: 'Order accepted', body: `${name} accepted your order.`, read_at: null, created_at: at(), user_id: userId, business_id: businessId });
      await page.reload({ waitUntil: 'networkidle' }); await text('Order accepted').waitFor(); await text('1 unread').waitFor();
      // Error with fixed copy and a retry.
      fixture.failList = true; await page.reload({ waitUntil: 'networkidle' });
      await text('We could not load your notifications. Check your connection and try again.').waitFor();
      assert.equal(await page.getByText('raw internal failure detail').count(), 0, 'no raw errors');
      await button('Retry notifications').waitFor();
      fixture.failList = false; await button('Retry notifications').click(); await text('Order accepted').waitFor(); await button('Retry notifications').waitFor({ state: 'hidden' });
      await context.close();

      // Wide layout, keyboard: Tab reaches an update and Enter opens its order.
      const wide = await open(true, { width: 1280, height: 800 });
      fixture.rows = seed(); fixture.reads.length = 0;
      await wide.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(wide.page.getByText('Your food is being prepared', { exact: true })).waitFor();
      const target = visible(wide.page.getByRole('button', { name: /^Unread\. Your food is being prepared/ }));
      const box = await target.boundingBox(); assert.ok(box.height >= 44 && box.width >= 44, 'target size');
      await shot('inbox-1280', false, wide.page);
      await target.focus(); await wide.page.keyboard.press('Enter');
      await wide.page.waitForURL(url => url.pathname === `/orders/${orderId(25)}`);
      await wide.page.waitForTimeout(300); assert.deepEqual(fixture.reads, [notificationId(25)]);
      await wide.context.close();

      // Empty and signed-out.
      fixture.rows = [];
      const empty = await open(true, { width: 390, height: 844 });
      await empty.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(empty.page.getByText('No notifications yet', { exact: true })).waitFor();
      await visible(empty.page.getByText(`Order updates from ${name} will appear here for 30 days.`, { exact: true })).waitFor();
      await shot('empty-390', false, empty.page);
      await empty.context.close();
      const emptyWide = await open(true, { width: 1280, height: 800 });
      await emptyWide.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(emptyWide.page.getByText('No notifications yet', { exact: true })).waitFor(); await shot('empty-1280', false, emptyWide.page);
      fixture.failList = true; await emptyWide.page.reload({ waitUntil: 'networkidle' });
      await visible(emptyWide.page.getByText('Could not load notifications', { exact: true })).waitFor(); await shot('error-1280', false, emptyWide.page);
      await emptyWide.context.close();
      const failing = await open(true, { width: 390, height: 844 });
      await failing.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(failing.page.getByText('Could not load notifications', { exact: true })).waitFor();
      await shot('error-390', false, failing.page);
      fixture.failList = false; await visible(failing.page.getByRole('button', { name: 'Retry notifications', exact: true })).click();
      await visible(failing.page.getByText('No notifications yet', { exact: true })).waitFor();
      await failing.context.close();
      fixture.calls.length = 0;
      const out = await open(false, { width: 390, height: 844 });
      await out.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(out.page.getByRole('heading', { name: 'Sign in', exact: true }).or(out.page.getByText('Sign in', { exact: true }))).first().waitFor();
      assert.equal(new URL(out.page.url()).pathname, '/login'); assert.deepEqual(fixture.calls, [], 'signed out sends no notification requests');
      await out.context.close();
      // Page-two failure keeps page one and retries.
      fixture.rows = seed(); fixture.failMore = true;
      const more = await open(true, { width: 390, height: 844 });
      await more.page.goto(server.url + '/notifications', { waitUntil: 'networkidle' });
      await visible(more.page.getByRole('button', { name: 'Load more', exact: true })).click();
      await visible(more.page.getByText('We could not load older notifications. Please try again.', { exact: true })).waitFor();
      fixture.failMore = false; await visible(more.page.getByRole('button', { name: 'Retry older notifications', exact: true })).click();
      await visible(more.page.getByText('Delivered 1', { exact: true })).waitFor();
      assert.equal(await visible(more.page.getByRole('button', { name: /Opens your order\.$/ })).count(), 25);
      await more.context.close();
    } finally { /* contexts closed above */ }
    assert.deepEqual(errors, [], 'no uncaught page errors');
    await server.close();
    console.log(`#55 inbox passed: ${slug}`);
  }
} finally { await browser.close(); }
