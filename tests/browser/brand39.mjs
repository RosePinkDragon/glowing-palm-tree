import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #39 slice 1: first-launch welcome -> dismissed for good -> branded top bar, for both restaurants. Synthetic fixtures only.
// Set SHOTS_DIR to also write screenshots.
const api = 'https://market-fixture.supabase.co';
const userId = '39000000-0000-4000-8000-000000000001';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'brand-fixture@example.test', user_metadata: {}, app_metadata: {} };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${part({ alg: 'HS256' })}.${part({ sub: userId, role: 'authenticated', session_id: '39000000-0000-4000-8000-000000000002', exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`;
const session = { access_token: token, refresh_token: 'brand-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
if (shots) await mkdir(shots, { recursive: true });
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu';
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const businessId = `39100000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
    const item = { id: '39200000-0000-4000-8000-000000000001', name: 'Brand fixture meal', description: 'Synthetic fixture', category_id: '39300000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
    const address = { id: '39400000-0000-4000-8000-000000000001', label: 'home', custom_label: null, house: 'Flat 3', street_area: 'Bharne Naka', landmark: null, latitude: 0.5, longitude: 0.5, location_source: 'pin', version: 1, updated_at: '2026-11-15T10:00:00Z', in_area: true, distance_m: 1200 };
    const errors = [];
    const open = async (signedIn, viewport) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      if (signedIn) await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:customer`, value: session });
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
        if (url.pathname === '/auth/v1/user') return json(user);
        if (url.pathname === '/rest/v1/businesses') return json(business);
        if (url.pathname === '/rest/v1/menu_items') return json([item]);
        if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
        if (url.pathname === '/rest/v1/rpc/list_addresses') return json([address]);
        if (url.pathname === '/rest/v1/orders') return json([]);
        throw new Error(`Unexpected brand fixture ${route.request().method()} ${url.pathname}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(server.url, { waitUntil: 'networkidle' });
      return { context, page };
    };
    try {
      // Guest on first launch: welcome, then a neutral address prompt in the top bar.
      let { context, page } = await open(false, { width: 390, height: 844 });
      await page.getByRole('heading', { name }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Account', exact: true }).count(), 0, 'welcome comes before the app');
      if (shots) { await page.screenshot({ path: `${shots}/${slug}-welcome-mobile-390x844.png` }); await page.setViewportSize({ width: 1280, height: 800 }); await page.screenshot({ path: `${shots}/${slug}-welcome-desktop-1280x800.png` }); await page.setViewportSize({ width: 390, height: 844 }); }
      await page.getByRole('button', { name: 'Browse the menu' }).click();
      await page.getByRole('button', { name: 'Add delivery address', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
      assert.equal(await page.getByRole('img', { name }).count(), 1, 'logo avatar is labelled');
      const box = await page.getByRole('button', { name: 'Add delivery address', exact: true }).boundingBox();
      assert.ok(box && box.height >= 44, 'address control keeps a 44px target');
      // Dismissal persists across a reload.
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Account', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Browse the menu' }).count(), 0);
      await context.close();
      // Signed in: selected saved address in the top bar, welcome dismissed once.
      for (const [label, viewport] of [['mobile-390x844', { width: 390, height: 844 }], ['desktop-1280x800', { width: 1280, height: 800 }]]) {
        ({ context, page } = await open(true, viewport));
        await page.getByRole('button', { name: 'Browse the menu' }).click();
        const line = page.getByRole('button', { name: 'Delivery address: Home · Flat 3, Bharne Naka. Change', exact: true });
        await line.waitFor();
        await page.getByText('Brand fixture meal').first().waitFor();
        if (shots) await page.screenshot({ path: `${shots}/${slug}-menu-topbar-${label}.png` });
        await context.close();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} welcome on first launch, dismissal persists, top bar shows logo avatar, address prompt and saved address`);
    } finally { await server.close(); }
  }
} finally { await browser.close(); }
