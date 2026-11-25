import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { assertDishSheet, closeDishSheet } from './dish-sheet.mjs';

// #203: the dish title opens details through a real button (not Text onPress), beside the heading, in both brands.
// Synthetic fixtures only.
const api = 'https://market-fixture.supabase.co';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const category = (n, name) => ({ id: `20300000-0000-4000-8000-00000000000${n}`, name, sort_order: n });
const categories = [category(1, 'Thalis'), category(2, 'Snacks')];
const dish = (n, categoryIndex, name, extra = {}) => ({ id: `20200000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, name, description: 'Synthetic fixture dish for browser checks.', diet: 'veg', category_id: categories[categoryIndex].id, menu_categories: { name: categories[categoryIndex].name, sort_order: categories[categoryIndex].sort_order }, price_paise: 10000 + n * 1000, available: true, is_demo: false, is_featured: false, sort_order: n, image_url: `20100000-0000-4000-8000-000000000001/photo-${n}/card.webp`, ...extra });
const menu = [
  dish(1, 0, 'Veg thali'), dish(2, 0, 'Chicken thali', { diet: 'non_veg', is_featured: true }), dish(3, 0, 'A very long dish name that has to wrap onto several lines in a narrow card', { is_featured: true }),
  dish(4, 1, 'Misal pav'), dish(5, 1, 'Kanda poha'),
];
const photo = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#E9C9B8"/><circle cx="160" cy="120" r="60" fill="#C65A3A"/></svg>';

for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
  const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu';
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const business = { id: '20100000-0000-4000-8000-000000000001', slug, name, delivery_fee_paise: 3000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
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
      const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
      if (url.pathname.startsWith('/storage/v1/object/public/menu-images/')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: photo });
      if (url.pathname === '/rest/v1/businesses') return json(business);
      if (url.pathname === '/rest/v1/menu_items') return json(menu);
      if (url.pathname === '/rest/v1/menu_categories') return json(categories);
      if (url.pathname === '/auth/v1/user' || url.pathname === '/rest/v1/orders') return json(url.pathname === '/rest/v1/orders' ? [] : null);
      throw new Error(`Unexpected fixture ${route.request().method()} ${url.pathname}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url, { waitUntil: 'networkidle' });
    return { context, page };
  };
  try {
    for (const [label, viewport] of [['mobile-390x844', { width: 390, height: 844 }], ['desktop-1280x800', { width: 1280, height: 800 }]]) {
      const { context, page } = await open(viewport);
      await page.getByRole('heading', { name, level: 1 }).waitFor();
      // Every dish title: one button named for the dish, a sibling of the heading (never inside it), at least 44px, no text-only onPress left.
      const scopes = brand ? ['#featured-menu', '#regular-menu'] : ['#featured-menu', '#regular-menu'];
      for (const scope of scopes) {
        const root = page.locator(scope);
        await root.first().waitFor();
        const report = await root.evaluate(node => [...node.querySelectorAll('[role="heading"]')].filter(heading => /\b(thali|pav|poha|dish name)\b/i.test(heading.textContent ?? '')).map(heading => {
          const label = `View details for ${heading.textContent}`;
          const buttons = [...node.querySelectorAll('[role="button"],button')].filter(button => button.getAttribute('aria-label') === label);
          const tabbable = buttons.filter(button => button.tabIndex >= 0 && !button.closest('[aria-hidden="true"]'));
          const box = button => { const r = button.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
          const h = heading.getBoundingClientRect();
          return { text: heading.textContent, buttons: buttons.length, tabbable: tabbable.length, inside: buttons.some(button => heading.contains(button)), headingInButton: !!heading.closest('[role="button"],button'), box: tabbable[0] && box(tabbable[0]), heading: { top: h.top, bottom: h.bottom }, hasTabindex: heading.hasAttribute('tabindex') && heading.tabIndex >= 0 };
        }));
        assert.ok(report.length > 0, `${label} ${scope} has dish titles`);
        for (const row of report) {
          assert.equal(row.tabbable, 1, `${label} ${scope} ${row.text}: exactly one tab stop opens details`);
          assert.equal(row.inside || row.headingInButton, false, `${label} ${scope} ${row.text}: the button is beside the heading, not nested with it`);
          assert.ok(row.box.height >= 44 - 0.5 && row.box.width >= 44, `${label} ${scope} ${row.text}: target ${row.box.width}x${row.box.height}`);
          assert.ok(row.box.top <= row.heading.top + 0.5 && row.box.bottom >= row.heading.bottom - 0.5, `${label} ${scope} ${row.text}: the button covers the title`);
        }
      }
      // The photo is the same action: out of the tab order and the accessibility tree, still tappable.
      const photoTab = await page.locator(brand ? '#featured-menu img' : '#regular-menu img').first().evaluate(image => { const opener = image.closest('[aria-hidden="true"]'); return { hidden: !!opener, tabIndex: opener?.tabIndex }; });
      assert.deepEqual(photoTab, { hidden: true, tabIndex: -1 }, `${label} photo opener is not a second tab stop`);

      const target = brand ? 'Chicken thali' : 'Misal pav';
      const titleButton = () => page.getByRole('button', { name: `View details for ${target}`, exact: true }).first();
      // Tab from the title reaches the next control of the same card (Add), not a duplicate details button. Done before any dialog opens so no focus restore can race it.
      await titleButton().scrollIntoViewIfNeeded(); await titleButton().focus(); await page.keyboard.press('Tab');
      await page.waitForFunction(label => document.activeElement && document.activeElement.getAttribute('aria-label') !== label, `View details for ${target}`);
      const next = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      assert.ok(next && !next.startsWith('View details for '), `Tab moves on to ${next}`);
      // Enter and Space open details from the keyboard; Escape returns focus to the title button.
      for (const key of ['Enter', 'Space']) {
        await titleButton().scrollIntoViewIfNeeded(); await titleButton().focus();
        assert.equal(await titleButton().evaluate(node => node === document.activeElement), true, 'title button takes focus');
        await page.keyboard.press(key);
        await assertDishSheet(page, target);
        await closeDishSheet(page, `View details for ${target}`);
      }
      // Pointer still works from the title and from the photo.
      await titleButton().click(); await assertDishSheet(page, target); await closeDishSheet(page, `View details for ${target}`);
      await page.locator(brand ? '#featured-menu img' : '#regular-menu img').first().click({ force: true });
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
      // Headings stay a heading outline; the dish heading is still the dish name.
      assert.ok(await page.getByRole('heading', { name: target, exact: true }).count() >= 1, 'dish heading is kept');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS: ${slug} ${label} dish title is one semantic 44px button beside its heading (Tab, Enter, Space, pointer, focus return)`);
    }
  } finally { await server.close(); }
}
await browser.close();
