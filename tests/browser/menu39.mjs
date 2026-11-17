import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #39 slice 2: Ammu Sammu photo-grid menu (search, Today's special, add -> stepper, category chips) plus a Kokani sanity pass (its menu is tested in kokani39.mjs).
// Synthetic fixtures only. Set SHOTS_DIR to also write screenshots.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
if (shots) await mkdir(shots, { recursive: true });
const category = (n, name) => ({ id: `39300000-0000-4000-8000-00000000000${n}`, name, sort_order: n });
const categories = [category(1, 'Thalis'), category(2, 'Snacks'), category(3, 'Sweets & drinks')];
const dish = (n, categoryIndex, name, price, extra = {}) => ({ id: `39200000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name, description: 'Synthetic fixture dish for browser checks.', diet: 'veg', category_id: categories[categoryIndex].id, menu_categories: { name: categories[categoryIndex].name, sort_order: categories[categoryIndex].sort_order }, price_paise: price, available: true, is_demo: false, is_featured: false, sort_order: n, image_url: `39100000-0000-4000-8000-000000000001/photo-${n}/card.webp`, ...extra });
const menu = [
  dish(1, 0, 'Veg thali', 18000), dish(2, 0, 'Chicken thali', 26000, { diet: 'non_veg' }), dish(3, 0, 'Fish thali', 32000, { diet: 'non_veg', is_featured: true }),
  dish(4, 1, 'Misal pav', 9000), dish(5, 1, 'Kanda poha', 5000, { diet: 'veg' }), dish(6, 1, 'Kothimbir vadi', 7000, { available: false }),
  dish(7, 2, 'Ukadiche modak', 12000, { diet: 'veg' }), dish(8, 2, 'Sol kadhi', 4000),
];
let fixtureMenu = menu, fixtureCategories = categories;
const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#E9C9B8"/><circle cx="160" cy="120" r="80" fill="#F6EEE8"/><circle cx="160" cy="120" r="46" fill="#C65A3A"/></svg>';

for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
  const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu';
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const business = { id: '39100000-0000-4000-8000-000000000001', slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const errors = [];
  const open = async viewport => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
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
      if (url.pathname.startsWith('/storage/v1/object/public/menu-images/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photo });
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json(fixtureMenu);
      if (url.pathname === '/rest/v1/menu_categories') return json(fixtureCategories);
      if (url.pathname === '/auth/v1/user' || url.pathname === '/rest/v1/orders') return json(url.pathname === '/rest/v1/orders' ? [] : null);
      throw new Error(`Unexpected menu fixture ${route.request().method()} ${url.pathname}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url, { waitUntil: 'networkidle' });
    return { context, page };
  };
  const shot = (page, file) => shots ? page.screenshot({ path: `${shots}/${slug}-${file}.png` }) : Promise.resolve();
  const dishHeadings = page => page.locator('#regular-menu').getByRole('heading', { level: 3 });
  const scroller = page => page.evaluateHandle(() => [...document.querySelectorAll('div')].find(node => node.scrollHeight > node.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.querySelector('#regular-menu')));
  const settle = async (page, handle) => { let last = -1; for (let i = 0; i < 40; i++) { const now = await handle.evaluate(node => node.scrollTop); if (now === last) return now; last = now; await page.waitForTimeout(150); } return last; };
  try {
    if (brand) {
      // Kokani's own menu (carousel, a la carte list) is covered by kokani39.mjs; here: still no search and still orderable.
      const { context, page } = await open({ width: 390, height: 844 });
      await page.getByRole('heading', { name: 'À la carte', level: 2 }).waitFor();
      assert.equal(await page.getByLabel('Search dishes').count(), 0);
      assert.equal(await page.getByRole('heading', { name: 'Signature dishes', exact: true }).count(), 1);
      await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click();
      await page.getByRole('button', { name: /^Cart \(1\)/ }).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS: kokani-dine-inn menu has no search and can add to cart');
      continue;
    }
    for (const [label, viewport] of [['mobile-390x844', { width: 390, height: 844 }], ['desktop-1280x800', { width: 1280, height: 800 }]]) {
      const { context, page } = await open(viewport);
      const mobile = viewport.width < 760;
      await page.getByRole('heading', { name, level: 1 }).waitFor();
      await page.getByText('Min. order ₹150 · Delivery ₹30 · Cash on delivery', { exact: true }).waitFor();
      // Today's special comes from the owner's featured flag only.
      const special = page.locator('#featured-menu');
      await special.getByRole('heading', { name: "Today's special", exact: true }).waitFor();
      await special.getByRole('heading', { name: 'Fish thali', exact: true }).waitFor();
      assert.equal(await special.getByRole('heading').count(), 2, 'one special');
      await page.locator('#regular-menu img').first().waitFor();
      assert.equal(await dishHeadings(page).count(), 8);
      assert.deepEqual(await page.locator('#regular-menu').getByRole('heading', { level: 2 }).allTextContents(), ['Thalis', 'Snacks', 'Sweets & drinks']);
      // Two columns on mobile; on desktop the three dishes of a section share one row of a wider grid.
      const tops = await page.locator('#regular-menu').getByRole('button', { name: /^View details for / }).evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
      const perRow = tops.filter(top => top === tops[0]).length;
      assert.equal(perRow, mobile ? 2 : 3, `${label} columns in a row`);
      await shot(page, `menu-top-${label}`);

      // Unavailable dish: no add control, stated in text.
      await page.getByText('Currently unavailable', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Add to cart', exact: true }).count(), 8, '7 available dishes plus the special card');

      // Add becomes a stepper that uses the real cart; focus follows the control, and touch targets are at least 44px.
      const add = page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first();
      const box = await add.boundingBox(); assert.ok(box && box.height >= 44 && box.width >= 44, 'Add target');
      await page.keyboard.press('Tab'); // keyboard path is live
      await add.focus(); await page.keyboard.press('Enter');
      const plus = page.getByRole('button', { name: 'Add one Veg thali', exact: true });
      await plus.waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add one Veg thali');
      const group = page.getByRole('group', { name: 'Veg thali quantity' });
      assert.equal(await group.getByText('1', { exact: true }).count(), 1);
      for (const control of [plus, page.getByRole('button', { name: 'Remove one Veg thali', exact: true })]) { const size = await control.boundingBox(); assert.ok(size && size.width >= 44 && size.height >= 44, 'stepper target'); }
      await plus.click(); await group.getByText('2', { exact: true }).waitFor();
      await page.getByRole('button', { name: /^Cart \(2\)/ }).waitFor();
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('market:cart:ammu-sammu')));
      assert.deepEqual((await saved()).lines.map(line => [line.item.name, line.quantity]), [['Veg thali', 2]]);
      await shot(page, `menu-stepper-${label}`);
      await page.getByRole('button', { name: 'Remove one Veg thali', exact: true }).click(); await group.getByText('1', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Remove one Veg thali', exact: true }).click();
      await page.getByRole('button', { name: 'Add to cart', exact: true }).first().waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add to cart');
      assert.equal(await page.getByRole('button', { name: /^Cart \(/ }).count(), 0); assert.deepEqual((await saved()).lines, []);
      // The special card adds the same dish; the grid copy shows the stepper too.
      await special.getByRole('button', { name: 'Add to cart', exact: true }).click();
      await page.getByRole('group', { name: 'Fish thali quantity' }).first().waitFor();
      assert.equal(await page.getByRole('group', { name: 'Fish thali quantity' }).count(), 2);
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('group', { name: 'Fish thali quantity' }).first().waitFor();

      // Search by name, with a simple empty state.
      const search = page.getByLabel('Search dishes', { exact: true });
      await search.fill('  THALI ');
      assert.equal(await dishHeadings(page).count(), 3);
      assert.deepEqual(await page.locator('#regular-menu').getByRole('heading', { level: 2 }).allTextContents(), ['Thalis']);
      await page.getByText('3 dishes found', { exact: true }).waitFor();
      await shot(page, `menu-search-${label}`);
      await search.fill('kadhi'); assert.deepEqual(await dishHeadings(page).allTextContents(), ['Sol kadhi']); assert.equal(await special.count(), 0, 'special is filtered by the search too');
      await search.fill('pizza');
      await page.getByText('No dishes match “pizza”', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: 'All dishes', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Clear search', exact: true }).first().click();
      assert.equal(await search.inputValue(), ''); assert.equal(await dishHeadings(page).count(), 8);

      // Category chips jump to their section, stay visible (sticky) and highlight the section being read.
      const bar = page.getByRole('button', { name: 'All dishes', exact: true });
      assert.equal(await bar.getAttribute('aria-pressed'), 'true');
      const target = page.getByRole('button', { name: 'Snacks', exact: true });
      assert.ok((await target.boundingBox()).height >= 44, 'chip target');
      await target.focus(); await page.keyboard.press('Enter');
      const area = await scroller(page);
      const offset = await settle(page, area);
      assert.ok(offset > 100, `jumped (${offset})`);
      await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label') === 'Snacks');
      const heading = await page.locator('#regular-menu').getByRole('heading', { name: 'Snacks', level: 2 }).boundingBox();
      const chipBox = await target.boundingBox();
      assert.ok(chipBox.y < 200 && heading.y > chipBox.y + chipBox.height - 4 && heading.y < chipBox.y + chipBox.height + 80, `section starts under the sticky chips (chip ${chipBox.y}, heading ${heading.y})`);
      await shot(page, `menu-categories-${label}`);
      await page.getByRole('button', { name: 'Sweets & drinks', exact: true }).click(); await settle(page, area);
      await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label') === 'Sweets & drinks');
      assert.equal(await page.getByRole('button', { name: 'Snacks', exact: true }).getAttribute('aria-pressed'), 'false');
      await page.getByRole('button', { name: 'All dishes', exact: true }).click(); await settle(page, area);
      assert.equal(await area.evaluate(node => node.scrollTop), 0);
      assert.equal(await page.getByRole('button', { name: 'All dishes', exact: true }).getAttribute('aria-pressed'), 'true');
      // Scrolling by hand moves the highlight.
      await area.evaluate(node => { node.scrollTop = node.scrollHeight; }); await page.waitForTimeout(300);
      await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label') === 'Sweets & drinks');
      // Details navigation still works from the photo.
      await area.evaluate(node => { node.scrollTop = 0; });
      await page.getByRole('button', { name: 'View details for Misal pav', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View details for Misal pav');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS: ammu-sammu ${label} special card, search, add/stepper with focus, chips jump and follow`);
    }
    // The 20-distinct-dish cart limit: the message must be seen where the customer is (far down the grid), as an alert.
    {
      const extras = category(4, 'Extras');
      fixtureCategories = [...categories, extras];
      fixtureMenu = [...menu, ...Array.from({ length: 16 }, (_, i) => dish(20 + i, 0, `Extra dish ${i + 1}`, 10000, { category_id: extras.id, menu_categories: { name: extras.name, sort_order: 4 } }))];
      const { context, page } = await open({ width: 390, height: 844 });
      for (let count = 1; count <= 20; count++) {
        await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click();
        await page.waitForFunction(expected => JSON.parse(localStorage.getItem('market:cart:ammu-sammu') || '{"lines":[]}').lines.length === expected, count);
      }
      const last = page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).last();
      await last.scrollIntoViewIfNeeded();
      await last.click();
      const alert = page.getByRole('alert').filter({ hasText: 'at most 20 distinct items' });
      await alert.waitFor();
      const viewportHeight = page.viewportSize().height, spot = await alert.boundingBox();
      assert.ok(spot && spot.y >= 0 && spot.y + spot.height <= viewportHeight, 'limit message is inside the viewport');
      assert.ok((await (await scroller(page)).evaluate(node => node.scrollTop)) > 400, 'the customer is far down the grid');
      assert.equal(await page.getByRole('button', { name: 'Dismiss message', exact: true }).count(), 1);
      await shot(page, 'menu-cart-limit-mobile-390x844');
      await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
      assert.equal(await alert.count(), 0);
      // A later successful action also clears it.
      await last.click(); await alert.waitFor();
      await page.locator('#regular-menu').getByRole('button', { name: /^Remove one / }).first().click();
      await alert.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      await context.close();
      fixtureMenu = menu; fixtureCategories = categories;
      console.log('PASS: ammu-sammu cart-limit message is an alert in view near the action, dismissible and cleared by the next successful action');
    }
  } finally { await server.close(); }
}
await browser.close();
