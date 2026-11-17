import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #39 slice 3: Kokani Dine Inn menu (signature carousel on the dark header, text a la carte list with dotted price leaders).
// Synthetic fixtures only. Set SHOTS_DIR to also write screenshots.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.SHOTS_DIR;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
if (shots) await mkdir(shots, { recursive: true });
const category = (n, name) => ({ id: `39300000-0000-4000-8000-00000000000${n}`, name, sort_order: n });
const categories = [category(1, 'Starters'), category(2, 'From the sea'), category(3, 'Desserts')];
const longName = 'Tisrya sukka with fresh coconut, malvani masala and a very long dish name that must wrap sanely';
const dish = (n, categoryIndex, name, price, extra = {}) => ({ id: `39200000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name, description: 'Synthetic fixture dish for browser checks.', diet: 'veg', category_id: categories[categoryIndex].id, menu_categories: { name: categories[categoryIndex].name, sort_order: categories[categoryIndex].sort_order }, price_paise: price, available: true, is_demo: false, is_featured: false, sort_order: n, image_url: `39100000-0000-4000-8000-000000000001/photo-${n}/card.webp`, ...extra });
const menu = [
  dish(1, 0, 'Kolambi koliwada', 42000, { diet: 'non_veg', is_featured: true }), dish(2, 0, 'Suranachi kaap', 26000),
  dish(3, 1, 'Surmai rava fry', 56000, { diet: 'non_veg', is_featured: true }), dish(4, 1, longName, 48000, { diet: 'non_veg' }), dish(5, 1, 'कोंबडी वडे आणि सोलकढी', 52000, { diet: 'non_veg', description: 'मालवणी चिकन करी' }),
  dish(6, 1, 'Bangda tikhale', 46000, { diet: 'non_veg', available: false, is_featured: true }), dish(7, 2, 'Sandan', 22000),
];
let fixtureMenu = menu, fixtureCategories = categories;
const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#E9C9B8"/><circle cx="160" cy="120" r="80" fill="#F6EEE8"/><circle cx="160" cy="120" r="46" fill="#C65A3A"/></svg>';

{
  const slug = 'kokani-dine-inn', name = 'Kokani Dine Inn';
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
  const dishHeadings = page => page.locator('#regular-menu').getByRole('heading', { level: 4 });
  const scroller = page => page.evaluateHandle(() => [...document.querySelectorAll('div')].find(node => node.scrollHeight > node.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.querySelector('#regular-menu')));
  const settle = async (page, handle) => { let last = -1; for (let i = 0; i < 40; i++) { const now = await handle.evaluate(node => node.scrollTop); if (now === last) return now; last = now; await page.waitForTimeout(150); } return last; };
  try {
    for (const [label, viewport] of [['mobile-390x844', { width: 390, height: 844 }], ['desktop-1280x800', { width: 1280, height: 800 }]]) {
      const { context, page } = await open(viewport);
      const mobile = viewport.width < 760;
      await page.getByRole('heading', { name, level: 1 }).waitFor();
      await page.getByText('Min. order ₹150 · Delivery ₹30 · Cash on delivery', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Search dishes').count(), 0, 'the design has no search on this menu');

      // Carousel: owner-featured, available dishes only (Bangda tikhale is featured but unavailable); labelled and horizontally scrollable.
      const carousel = page.locator('#featured-menu');
      await carousel.getByRole('heading', { name: 'Signature dishes', level: 2, exact: true }).waitFor();
      assert.deepEqual(await carousel.getByRole('heading', { level: 3 }).allTextContents(), ['Kolambi koliwada', 'Surmai rava fry']);
      const region = page.getByRole('region', { name: 'Signature dishes, scroll sideways' });
      await region.waitFor();
      assert.equal(await region.evaluate(node => getComputedStyle(node).overflowX), 'auto');
      // The dark band is full-bleed and the page never scrolls sideways.
      const band = await page.evaluate(() => { const h1 = document.querySelector('h1'); return { color: getComputedStyle(h1).color, scrollX: document.documentElement.scrollWidth > innerWidth }; });
      assert.equal(band.color, 'rgb(255, 255, 255)'); assert.equal(band.scrollX, false);
      await page.locator('#featured-menu img').first().waitFor();
      await shot(page, `menu-top-${label}`);
      // Keyboard: focusing the last card scrolls the carousel (or it already fits) and its controls stay usable.
      const lastAdd = carousel.getByRole('button', { name: 'Add to cart', exact: true }).last();
      await lastAdd.focus(); await page.waitForTimeout(600); const lastBox = await lastAdd.boundingBox();
      assert.ok(lastBox.height >= 44 && lastBox.width >= 44 && lastBox.x >= 0 && lastBox.x + lastBox.width <= viewport.width, `carousel add is reachable and 44px ${JSON.stringify(lastBox)}`);
      if (mobile) assert.ok(await region.evaluate(node => node.scrollWidth > node.clientWidth), 'cards overflow sideways on a phone');

      // A la carte: text rows, no photos, dotted leaders hidden from assistive tech, unavailable marked.
      assert.equal(await page.locator('#regular-menu img').count(), 0);
      await page.getByRole('heading', { name: 'À la carte', level: 2 }).waitFor();
      assert.deepEqual(await page.locator('#regular-menu').getByRole('heading', { level: 3 }).allTextContents().then(list => list.map(text => text.toLowerCase())), ['starters', 'from the sea', 'desserts']);
      assert.deepEqual(await dishHeadings(page).allTextContents(), ['Kolambi koliwada', 'Suranachi kaap', 'Surmai rava fry', longName, 'कोंबडी वडे आणि सोलकढी', 'Bangda tikhale', 'Sandan']);
      const leaderInfo = await page.locator('#regular-menu').evaluate(root => [...root.querySelectorAll('div')].filter(node => getComputedStyle(node).borderBottomStyle === 'dotted').map(node => ({ hidden: node.getAttribute('aria-hidden') === 'true', text: node.textContent, width: Math.round(node.getBoundingClientRect().width) })));
      assert.equal(leaderInfo.length, 7, 'one leader per dish row');
      assert.ok(leaderInfo.every(leader => leader.hidden && leader.text === '' && leader.width >= 14), 'leaders are decorative, empty and keep a visible width even beside the long and Devanagari names');
      // Name and price are real text for assistive tech (the row reads name then price).
      // Name and price are real text for assistive tech: the heading is the name, the price its own text.
      await page.locator('#regular-menu').getByText('₹420', { exact: true }).waitFor();
      await page.getByText('Currently unavailable', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Add to cart', exact: true }).count(), 8, '6 available rows plus 2 signature cards; the unavailable dish has no add');
      // The long name wraps inside the screen: no row is wider than the viewport and the price stays on screen.
      const overflow = await page.evaluate(() => [...document.querySelectorAll('#regular-menu *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).length);
      assert.equal(overflow, 0, 'nothing overflows sideways');
      const longHeading = await page.locator('#regular-menu').getByRole('heading', { name: longName }).boundingBox();
      if (mobile) assert.ok(longHeading.height > 40, 'long name wraps onto several lines');
      await page.getByRole('button', { name: 'From the sea', exact: true }).click(); await settle(page, await scroller(page));
      await shot(page, `menu-list-${label}`);

      // Add and stepper in the carousel and in the list share one cart.
      const listAdd = page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first();
      const box = await listAdd.boundingBox(); assert.ok(box && box.height >= 44 && box.width >= 44, 'row add target');
      await listAdd.focus(); await page.keyboard.press('Enter');
      const plus = page.getByRole('button', { name: 'Add one Kolambi koliwada', exact: true });
      await plus.first().waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add one Kolambi koliwada');
      assert.equal(await page.getByRole('group', { name: 'Kolambi koliwada quantity' }).count(), 2, 'carousel card and list row both show the stepper');
      for (const control of [plus.first(), page.getByRole('button', { name: 'Remove one Kolambi koliwada', exact: true }).first()]) { const size = await control.boundingBox(); assert.ok(size && size.width >= 44 && size.height >= 44, 'stepper target'); }
      await carousel.getByRole('button', { name: 'Add one Kolambi koliwada', exact: true }).click();
      await page.getByRole('button', { name: /^Cart \(2\)/ }).waitFor();
      const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('market:cart:kokani-dine-inn')));
      assert.deepEqual((await saved()).lines.map(line => [line.item.name, line.quantity]), [['Kolambi koliwada', 2]]);
      await shot(page, `menu-stepper-${label}`);
      await page.locator('#regular-menu').getByRole('button', { name: 'Remove one Kolambi koliwada', exact: true }).click();
      await carousel.getByRole('button', { name: 'Remove one Kolambi koliwada', exact: true }).click();
      await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().waitFor();
      assert.deepEqual((await saved()).lines, []);
      await carousel.getByRole('button', { name: 'Add to cart', exact: true }).last().click();
      await page.getByRole('group', { name: 'Surmai rava fry quantity' }).first().waitFor();
      assert.equal(await page.getByRole('group', { name: 'Surmai rava fry quantity' }).count(), 2);

      // Category chips (kept from the previous menu) jump to their section and follow the scroll.
      const chip = page.getByRole('button', { name: 'Desserts', exact: true });
      await chip.focus(); await page.keyboard.press('Enter');
      const area = await scroller(page);
      assert.ok((await settle(page, area)) > 100, 'jumped');
      await page.waitForFunction(() => document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label') === 'Desserts');
      await shot(page, `menu-categories-${label}`);
      await page.getByRole('button', { name: 'All dishes', exact: true }).click(); await settle(page, area);

      // Dish details open from the row (keyboard reachable) and focus returns.
      await page.getByRole('button', { name: 'View details for Suranachi kaap', exact: true }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'View details for Suranachi kaap');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS: kokani-dine-inn ${label} signature carousel, text list with hidden leaders, add/stepper in both, chips, details`);
    }
    // No featured dish: no carousel and no heading for it.
    {
      fixtureMenu = menu.map(item => ({ ...item, is_featured: false }));
      const { context, page } = await open({ width: 390, height: 844 });
      await page.getByRole('heading', { name: 'À la carte', level: 2 }).waitFor();
      assert.equal(await page.locator('#featured-menu').count(), 0); assert.equal(await page.getByRole('heading', { name: 'Signature dishes' }).count(), 0);
      await shot(page, 'menu-no-signature-mobile-390x844');
      await context.close();
      fixtureMenu = menu;
      console.log('PASS: kokani-dine-inn without featured dishes has no carousel');
    }
    // The 20-distinct-dish cart limit: the alert must be seen deep in the list.
    {
      const extras = category(4, 'Extras');
      fixtureCategories = [...categories, extras];
      fixtureMenu = [...menu, ...Array.from({ length: 16 }, (_, i) => dish(20 + i, 0, `Extra dish ${i + 1}`, 10000, { category_id: extras.id, menu_categories: { name: extras.name, sort_order: 4 } }))];
      const { context, page } = await open({ width: 390, height: 844 });
      for (let count = 1; count <= 20; count++) {
        await page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).first().click();
        await page.waitForFunction(expected => JSON.parse(localStorage.getItem('market:cart:kokani-dine-inn') || '{"lines":[]}').lines.length === expected, count);
      }
      const last = page.locator('#regular-menu').getByRole('button', { name: 'Add to cart', exact: true }).last();
      await last.scrollIntoViewIfNeeded();
      await last.click();
      const alert = page.getByRole('alert').filter({ hasText: 'at most 20 distinct items' });
      await alert.waitFor();
      const spot = await alert.boundingBox();
      assert.ok(spot && spot.y >= 0 && spot.y + spot.height <= page.viewportSize().height, 'limit message is inside the viewport');
      assert.ok((await (await scroller(page)).evaluate(node => node.scrollTop)) > 400, 'the customer is far down the list');
      await shot(page, 'menu-cart-limit-mobile-390x844');
      await page.getByRole('button', { name: 'Dismiss message', exact: true }).click();
      assert.equal(await alert.count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      fixtureMenu = menu; fixtureCategories = categories;
      console.log('PASS: kokani-dine-inn cart-limit alert is visible deep in the list and dismissible');
    }
  } finally {
    await server.close();
  }
}
await browser.close();
