import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// Actual exports → installed SDK → deterministic scoped HTTP fixture → drawer/detail.
const api = 'https://market-fixture.supabase.co';
const userId = '51000000-0000-4000-8000-000000000001';
const otherUser = '51000000-0000-4000-8000-000000000002';
const orderId = n => `52000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'account-fixture@example.test', user_metadata: {}, app_metadata: {} };
const token = part({ alg: 'HS256' }) + '.' + part({ sub: userId, role: 'authenticated', session_id: '53000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now()/1000)+3600 }) + '.fixture';
const session = { access_token: token, refresh_token: 'account-fixture', expires_in: 3600, expires_at: Math.floor(Date.now()/1000)+3600, token_type: 'bearer', user };
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
    const rows = Array.from({ length: 25 }, (_, index) => ({ id: orderId(index+1), business_id: businessId, customer_id: userId, status: index === 24 ? 'preparing' : 'delivered', version: 1, created_at: '2026-11-15T10:00:00.123456Z', subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: 'Synthetic', customer_phone: '9000000000', delivery_address_line: 'Synthetic Khed address', order_items: [{ menu_item_id: item.id, diet: null, name: `History meal ${index+1}`, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [] }));
    let failOlder = true, failDetail = false, holdOrders = false, held, release;
    await context.routeWebSocket(/.*/, socket => {
      socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((value, index) => ({ ...value, id: index + 1 })) } };
        if (event === 'phx_join' || event === 'heartbeat' || event === 'phx_leave') socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.fallback();
      assert.equal(url.origin, api, 'no third-party requests without consent');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json([item]);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/orders') {
        queries.push(url);
        assert.equal(url.searchParams.get('business_id'), 'eq.' + businessId);
        assert.equal(url.searchParams.get('customer_id'), 'eq.' + userId);
        if (holdOrders) { holdOrders = false; held?.(); await new Promise(resolve => { release = resolve; }); }
        const id = url.searchParams.get('id');
        if (id) return failDetail ? json({ message: 'Detail fixture unavailable' }, 400) : json(rows.find(row => row.id === id.slice(3)) ?? null);
        const cursor = url.searchParams.get('or');
        if (cursor && failOlder) return json({ message: 'Older history fixture unavailable' }, 400);
        let result = [...rows];
        if (cursor) {
          const parts = /^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)\)$/.exec(cursor);
          assert.ok(parts); result = result.filter(row => row.created_at < parts[1] || (row.created_at === parts[1] && row.id < parts[3]));
        }
        assert.equal(url.searchParams.get('order'), 'created_at.desc,id.desc');
        result.sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        return json(result.slice(0, Number(url.searchParams.get('limit'))));
      }
      throw new Error(`Unexpected account request ${url.pathname}`);
    });
    try {
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
      assert.equal(await page.getByText('1 × History meal 25 · ₹100.00', { exact: true }).count(), 1);
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
      await page.getByText('1 × History meal 1 · ₹100.00', { exact: true }).waitFor();
      assert.ok(queries.some(url => url.searchParams.get('id') === 'eq.' + orderId(1)));
      failDetail = true;
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText('Detail fixture unavailable', { exact: false }).waitFor();
      failDetail = false;
      await page.getByRole('button', { name: 'Retry orders', exact: true }).click();
      await page.getByText('1 × History meal 1 · ₹100.00', { exact: true }).waitFor();
      await page.goto(server.url + '/orders/' + orderId(999), { waitUntil: 'networkidle' });
      await page.getByText("We can't show this order", { exact: true }).waitFor();
      for (const [label, text] of [['Saved addresses', 'Saved addresses are not available yet.'], ['Notifications', 'Your notification inbox is not available yet.'], ['Help & support', 'Restaurant support details will be added here before launch.']]) {
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
      assert.equal(await page.getByText('1 × History meal 25 · ₹100.00', { exact: true }).filter({ visible: true }).count(), 0);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await page.getByLabel('Email', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} guest login, scoped paged drawer, retry, old detail, focus, placeholders and logout isolation`);
    } finally { release?.(); await context.close(); await server.close(); }
  }
} finally { await browser.close(); }
