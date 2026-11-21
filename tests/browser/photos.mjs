import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn, ownerOtpSignIn } from './otp-login.mjs';
import { assertDishSheet } from './dish-sheet.mjs';

// Optional focused reuse: --brand=kokani-dine-inn --owners-only
const selectedBrand = process.argv.find(arg => arg.startsWith('--brand='))?.slice(8);
const ownersOnly = process.argv.includes('--owners-only');
const customersOnly = process.argv.includes('--customers-only');
assert.ok(!(ownersOnly && customersOnly), 'Choose only one photo test audience');
if (selectedBrand) assert.ok(['ammu-sammu', 'kokani-dine-inn'].includes(selectedBrand), 'Unknown photo test brand');
const origin = 'https://market-fixture.supabase.co';
// A neutral one-pixel fixture, never represented as a restaurant's food.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
let browser;
try {
  await mkdir('dist/browser', { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    if (selectedBrand && selectedBrand !== slug) continue;
    const customer = await serveWeb(`apps/${slug}-customer/dist/web`);
    const owner = await serveWeb(`apps/${slug}-admin/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const businessId = `10000000-0000-4000-8000-00000000000${brand + 1}`;
    const user = { id: `30000000-0000-4000-8000-00000000000${brand + 1}`, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
    const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user.id, role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.${part('fixture')}`;
    const session = { access_token: token, refresh_token: 'fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
    const item = (index, values) => {
      const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return { id, business_id: businessId, category_id: '14300000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, name: `Later dish ${index}`, description: 'Neutral synthetic test description.', diet: 'veg', price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: index,
        image_url: `${businessId}/${id}/40000000-0000-4000-8000-000000000001/card.webp`, ...values };
    };
    const menu = [item(0, { name: 'Photo dish', diet: 'egg', is_featured: true, price_paise: 15000 }), item(1, { name: 'No photo dish', image_url: null }), item(2, { name: 'Unavailable dish', available: false, diet: 'non_veg' }), item(3, { name: 'Broken photo dish' }), ...Array.from({ length: 60 }, (_, i) => item(i + 4, {}))];
    const feature = brand ? 'Signature dishes' : "Today's special";
    const requests = [], errors = [], external = [], ownerActions = [];
    let ownerFailure = true;
    await context.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('market:cart:') && window.__failCartWrites) throw new DOMException('Synthetic cart write failure', 'QuotaExceededError');
        return set.call(this, key, value);
      };
      window.__photoBlobs = { created: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const uri = create(value); window.__photoBlobs.created.push(uri); return uri; };
      URL.revokeObjectURL = uri => { window.__photoBlobs.revoked.push(uri); return revoke(uri); };
    });
    await context.routeWebSocket(/.*/, socket => {
      if (new URL(socket.url()).origin !== 'wss://market-fixture.supabase.co') { external.push(socket.url()); socket.close(); return; }
      socket.onMessage(message => {
        const value = JSON.parse(String(message)), array = Array.isArray(value);
        const [join, ref, topic, event, payload] = array ? value : [value.join_ref, value.ref, value.topic, value.event, value.payload];
        if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) {
          const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, i) => ({ ...change, id: i + 1 })) } };
          socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
        }
      });
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if ([customer.url, owner.url].includes(url.origin)) return route.fallback();
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/businesses') return json({ id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
      if (url.pathname === '/rest/v1/menu_items') return json(menu);
      if (url.pathname === '/rest/v1/menu_categories') return json([{ id: menu[0].category_id, name: 'Meals', sort_order: 0 }]);
      if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
      if (url.pathname === '/rest/v1/orders') return json([]);
      if (url.pathname.startsWith('/storage/v1/object/public/menu-images/')) {
        requests.push(url.pathname);
        if (url.pathname.includes(`/${menu[3].id}/`)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Synthetic missing photo' });
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      }
      if (url.pathname === '/functions/v1/menu-photos') {
        const headers = req.headers(), action = headers['x-photo-action'];
        assert.equal(headers['x-business-slug'], slug); assert.equal(headers.authorization, `Bearer ${token}`);
        ownerActions.push(action);
        if (action === 'upload') {
          assert.equal(headers['x-menu-item'], menu[0].id); assert.equal(headers['x-photo-expected'], menu[0].image_url ?? ''); assert.deepEqual(req.postDataBuffer(), png);
          if (ownerFailure) { ownerFailure = false; return json({ message: 'This photo is damaged. Choose another JPEG, PNG or WebP.' }, 400); }
          menu[0].image_url = `${businessId}/${menu[0].id}/40000000-0000-4000-8000-000000000002/card.webp`;
        }
        if (action === 'remove') menu[0].image_url = null;
        return json({ saved: true, cleanupComplete: action === 'cleanup' });
      }
      if (url.pathname === '/rest/v1/rpc/list_addresses') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); // signed-in carts read saved addresses (#48)
      if (url.pathname === '/rest/v1/customer_businesses') return json([]);
      throw new Error(`Unhandled photo fixture: ${req.method()} ${url.pathname}`);
    });
    try {
      if (!ownersOnly) {
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.goto(customer.url, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: 'Photo dish', exact: true }).first().waitFor();
        const open = async name => {
          const button = page.getByRole('button', { name: `View details for ${name}`, exact: true }).first();
          await button.focus(); await page.keyboard.press('Enter');
          await page.waitForFunction(expected => document.activeElement?.textContent === expected, name);
          return page.getByRole('dialog');
        };
        const close = async name => { await page.keyboard.press('Escape'); await page.waitForFunction(expected => document.activeElement?.getAttribute('aria-label') === `View details for ${expected}`, name); };
        const saved = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), `market:cart:${slug}`);
        const firstImage = page.locator('#featured-menu img').first();
        assert.equal(await firstImage.getAttribute('alt'), 'Photo dish'); assert.equal(await firstImage.getAttribute('loading'), 'lazy');
        assert.ok((await firstImage.getAttribute('src')).endsWith('/card.webp'));
        assert.equal(requests.some(path => path.endsWith('/detail.webp')), false);
        assert.equal(requests.some(path => path.includes(`/${menu.at(-1).id}/`)), false, 'offscreen image loaded before scrolling');
        let dialog = await open('Photo dish');
        await assertDishSheet(page, 'Photo dish');
        await dialog.getByRole('img', { name: 'Photo dish', exact: true }).waitFor();
        assert.ok((await dialog.locator('img').getAttribute('src')).endsWith('/detail.webp'));
        assert.equal(await dialog.locator('img').getAttribute('loading'), 'eager');
        await dialog.getByRole('img', { name: 'Contains egg', exact: true }).waitFor();
        await dialog.getByText(brand ? 'Signature dish' : feature, { exact: true }).waitFor();
        await dialog.getByText('Neutral synthetic test description.', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: 'Decrease quantity' }).isDisabled(), true);
        await dialog.getByRole('button', { name: 'Increase quantity' }).click();
        await dialog.getByRole('button', { name: 'Add · ₹300', exact: true }).waitFor();
        await page.screenshot({ path: `dist/browser/${slug}-dish-details-mobile.png` });
        await dialog.getByRole('button', { name: 'Add · ₹300', exact: true }).click();
        await eventually(async () => !(await page.getByRole('dialog').count()));
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View details for Photo dish');
        assert.equal((await saved()).lines[0].quantity, 2);
        // A second writer can change persisted storage before its storage event is
        // delivered. The actual add must validate that latest record under the lock.
        dialog = await open('Photo dish');
        await dialog.getByRole('button', { name: 'Increase quantity' }).click(); await dialog.getByRole('button', { name: 'Increase quantity' }).click();
        await page.evaluate(key => { const cart = JSON.parse(localStorage.getItem(key)); cart.revision++; cart.lines[0].quantity = 9; localStorage.setItem(key, JSON.stringify(cart)); }, `market:cart:${slug}`);
        await dialog.getByRole('button', { name: 'Add · ₹450', exact: true }).click();
        await dialog.getByText('Could not add this dish', { exact: true }).waitFor();
        assert.equal((await saved()).lines[0].quantity, 9); await dialog.getByLabel('Quantity: 3', { exact: true }).waitFor();
        await close('Photo dish'); await page.reload({ waitUntil: 'networkidle' });
        dialog = await open('Photo dish'); assert.equal(await dialog.getByRole('button', { name: 'Increase quantity' }).isDisabled(), true);
        await dialog.getByRole('button', { name: 'Add · ₹150', exact: true }).click(); await eventually(async () => !(await page.getByRole('dialog').count()));
        assert.equal((await saved()).lines[0].quantity, 10);
        dialog = await open('Photo dish'); await dialog.getByText('10 already in your cart. You have reached the limit of 10 for this dish.', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: 'Add · ₹150', exact: true }).isDisabled(), true); await close('Photo dish');
        dialog = await open('No photo dish'); await dialog.getByRole('img', { name: 'No photo dish: no photo available', exact: true }).waitFor();
        await page.evaluate(() => { window.__failCartWrites = true; });
        await dialog.getByRole('button', { name: 'Add · ₹100', exact: true }).click(); await dialog.getByText('Could not add this dish', { exact: true }).waitFor();
        assert.equal((await saved()).lines.length, 1); await dialog.getByLabel('Quantity: 1', { exact: true }).waitFor();
        await page.screenshot({ path: `dist/browser/${slug}-dish-cart-error.png` });
        await close('No photo dish'); await page.evaluate(() => { window.__failCartWrites = false; });
        await page.getByRole('button', { name: 'Retry saved cart', exact: true }).click();
        await eventually(async () => !(await page.getByRole('button', { name: 'Retry saved cart', exact: true }).count()));
        dialog = await open('No photo dish'); await dialog.getByRole('button', { name: 'Add · ₹100', exact: true }).click(); await eventually(async () => !(await page.getByRole('dialog').count()));
        assert.deepEqual((await saved()).lines.map(line => line.quantity), [10, 1]);
        dialog = await open('Unavailable dish'); await dialog.getByText('Currently unavailable', { exact: true }).waitFor();
        await dialog.getByRole('img', { name: 'Non-vegetarian', exact: true }).waitFor(); assert.equal(await dialog.getByRole('button', { name: /^Add ·/ }).count(), 0); await close('Unavailable dish');
        dialog = await open('Broken photo dish'); await dialog.getByRole('img', { name: 'Broken photo dish: no photo available', exact: true }).waitFor(); await close('Broken photo dish');
        dialog = await open('No photo dish');
        await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: null })));
        await dialog.getByText('Your cart is paused. Finish recovery or retry your saved cart before adding dishes.', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: 'Add · ₹100', exact: true }).isDisabled(), true);
        await close('No photo dish'); await page.reload({ waitUntil: 'networkidle' });
        const distant = page.getByRole('button', { name: `View details for ${menu.at(-1).name}`, exact: true });
        await distant.scrollIntoViewIfNeeded();
        // Kokani's a la carte rows are text only (#39): a dish that is not featured never loads a photo in the list; its photo is in the details dialog.
        if (brand) { await page.waitForTimeout(500); assert.equal(requests.some(path => path.includes(`/${menu.at(-1).id}/`)), false, 'text rows request no photo'); } else await eventually(() => requests.some(path => path.includes(`/${menu.at(-1).id}/`)));
        assert.ok(requests.every(path => /\/(card|detail)\.webp$/.test(path)), 'unoptimized/original image requested');
        await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual((await saved()).lines.map(line => line.quantity), [10, 1]);
        await page.setViewportSize({ width: 1280, height: 900 }); dialog = await open('Photo dish'); await page.screenshot({ path: `dist/browser/${slug}-dish-details-desktop.png` }); await close('Photo dish');
        await open('No photo dish');
        const account = await context.newPage(); account.on('pageerror', e => errors.push(e.message));
        await account.goto(customer.url + '/login', { waitUntil: 'networkidle' });
        await otpSignIn(account, { email: user.email }); await account.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
        await eventually(async () => !(await page.getByRole('dialog').count()));
        assert.deepEqual((await saved()).lines.map(line => line.quantity), [10, 1]); await account.close();
        console.log(`PASS ${slug} customer: lazy optimized photos/alt/fallback, metadata/details/focus, quantity totals/latest cart limit, failed-write recovery, unavailable state, persisted cart, checkout lock and identity change`);

      }
      // Keep the owner UI introduced with the upload backend covered in CI too.
      if (!customersOnly) {
      const admin = await context.newPage(); admin.on('pageerror', e => errors.push(e.message));
      await admin.goto(owner.url, { waitUntil: 'networkidle' });
      await ownerOtpSignIn(admin, { email: user.email }); await admin.getByRole('navigation', { name: 'Owner sections' }).getByRole('button', { name: 'Menu', exact: true }).click();
      // Photos are managed from the Edit dish screen (#102); the photo editor opens above it.
      await admin.getByRole('button', { name: 'Edit Photo dish', exact: true }).click(); await admin.waitForFunction(() => document.activeElement?.textContent === 'Edit dish');
      const openPhoto = async () => { await admin.getByRole('dialog').last().getByRole('button', { name: /^(Add|Change) photo$/ }).click(); await admin.waitForFunction(() => document.activeElement?.textContent === 'Photo for Photo dish'); };
      const choose = async (name, buffer) => { const chooser = admin.waitForEvent('filechooser'); await admin.getByRole('button', { name: /^Choose (photo|another photo)$/ }).click(); await (await chooser).setFiles({ name, mimeType: 'image/png', buffer }); };
      await openPhoto(); await choose('oversized.png', Buffer.alloc(5 * 1024 * 1024 + 1)); await admin.getByText('Choose a photo up to 5 MB.', { exact: true }).waitFor(); assert.equal(ownerActions.length, 0);
      await choose('neutral-test.png', png); await admin.getByText('Selected: neutral-test.png', { exact: true }).waitFor(); await admin.getByRole('button', { name: 'Replace photo', exact: true }).click();
      await admin.getByText('This photo is damaged. Choose another JPEG, PNG or WebP.', { exact: true }).waitFor(); await admin.getByRole('button', { name: 'Reload dish photo', exact: true }).click();
      await admin.getByText('Current photo reloaded.', { exact: true }).waitFor(); await openPhoto(); await choose('neutral-test.png', png); await admin.getByRole('button', { name: 'Replace photo', exact: true }).click();
      await admin.getByText('Photo saved. Old photos are queued for cleanup; use Retry photo cleanup.', { exact: true }).waitFor();
      await admin.waitForFunction(() => document.activeElement?.textContent === 'Change photo');
      await openPhoto(); await admin.getByRole('button', { name: 'Remove photo', exact: true }).click(); await admin.getByText('Photo removed. Old photos are queued for cleanup; use Retry photo cleanup.', { exact: true }).waitFor();
      await admin.getByRole('dialog').last().getByRole('button', { name: 'Add photo', exact: true }).waitFor();
      await admin.getByRole('button', { name: 'Close', exact: true }).click(); await admin.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Edit Photo dish');
      await admin.getByRole('button', { name: 'Retry photo cleanup', exact: true }).click(); await admin.getByText('Unused photo cleanup completed.', { exact: true }).waitFor();
      assert.deepEqual(ownerActions, ['upload', 'upload', 'remove', 'cleanup']);
      assert.deepEqual(await admin.evaluate(() => ({ created: window.__photoBlobs.created.length, revoked: window.__photoBlobs.revoked.length })), { created: 3, revoked: 3 });
      console.log(`PASS ${slug} owner: picker/oversize/preview/rejection/reload/replace/remove/cleanup and blob URL lifecycle`);
      }
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await context.close(); await customer.close(); await owner.close(); }
  }
} finally { await browser?.close(); }
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
