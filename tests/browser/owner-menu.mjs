import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// Owners' Menu and Edit dish (#102): search, availability switch, move/drag
// reordering with stale-order recovery, categories and the dish editor.
// Optional: --brand=kokani-dine-inn --screenshots=/tmp/review102
const selectedBrand = process.argv.find(arg => arg.startsWith('--brand='))?.slice(8);
const shots = process.argv.find(arg => arg.startsWith('--screenshots='))?.slice(14) ?? 'dist/browser';
if (selectedBrand) assert.ok(['ammu-sammu', 'kokani-dine-inn'].includes(selectedBrand), 'Unknown owner menu test brand');
const origin = 'https://market-fixture.supabase.co';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const uuid = (prefix, n) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let browser;
try {
  await mkdir(shots, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    if (selectedBrand && selectedBrand !== slug) continue;
    const owner = await serveWeb(`apps/${slug}-admin/dist/web`);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const businessId = `10000000-0000-4000-8000-00000000000${brand + 1}`;
    const user = { id: `30000000-0000-4000-8000-00000000000${brand + 1}`, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
    const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user.id, role: 'authenticated', session_id: '80000000-0000-4000-8000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.${part('fixture')}`;
    const session = { access_token: token, refresh_token: 'fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
    const feature = brand ? 'Signature dish' : "Today's special";
    let categories = [{ id: uuid('15', 1), name: 'Thalis', sort_order: 0 }, { id: uuid('15', 2), name: 'Snacks', sort_order: 1 }, { id: uuid('15', 3), name: 'Sweets', sort_order: 2 }];
    const [thalis, snacks, sweets] = categories.map(category => category.id);
    let nextId = 10;
    const dish = (n, category_id, sort_order, name, values = {}) => ({ id: uuid('25', n), business_id: businessId, category_id, name, description: 'Neutral synthetic test description.', diet: 'veg', price_paise: 18000, available: true, is_demo: false, is_featured: false, sort_order, image_url: `${businessId}/${uuid('25', n)}/40000000-0000-4000-8000-000000000001/card.webp`, ...values });
    let dishes = [
      dish(1, thalis, 0, 'Fish thali', { diet: 'non_veg', is_featured: true, price_paise: 32000 }),
      dish(2, thalis, 1, 'Veg thali'),
      dish(3, thalis, 2, 'Chicken thali', { diet: 'non_veg', price_paise: 26000 }),
      dish(4, snacks, 0, 'Misal pav', { price_paise: 9000 }),
      dish(5, snacks, 1, 'Kanda poha', { is_demo: true, image_url: null, price_paise: 5000 }),
      dish(6, snacks, 2, 'Kothimbir vadi', { available: false, price_paise: 7000 }),
    ];
    const id = name => dishes.find(row => row.name === name).id;
    const rows = () => dishes.map(row => { const category = categories.find(entry => entry.id === row.category_id); return { ...row, menu_categories: { name: category.name, sort_order: category.sort_order } }; });
    const errors = [], external = [], patches = [], posts = [], deletes = [], reorders = [], categoryWrites = [];
    let menuLoads = 0, failPatch = false, staleNext = false, patchGate = null;
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
      const req = route.request(), url = new URL(req.url()), method = req.method();
      if (url.origin === owner.url) return route.fallback();
      if (url.origin !== origin) { external.push(url.href); return route.abort(); }
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      const rowId = () => url.searchParams.get('id')?.replace(/^eq\./, '');
      if (url.pathname === '/auth/v1/token') return json(session);
      if (url.pathname === '/auth/v1/user') return json(user);
      if (url.pathname === '/rest/v1/businesses') return json({ id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
      if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
      if (url.pathname === '/rest/v1/orders') return json([]);
      if (url.pathname.startsWith('/storage/v1/object/public/menu-images/')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      if (url.pathname === '/rest/v1/menu_items') {
        if (method === 'GET') { menuLoads++; return json(rows()); }
        if (method !== 'POST') assert.equal(url.searchParams.get('business_id'), `eq.${businessId}`, 'owner writes stay inside the business');
        if (method === 'PATCH') {
          const values = req.postDataJSON(); patches.push({ id: rowId(), values });
          if (patchGate) await patchGate.wait;
          if (failPatch) { failPatch = false; return json({ message: 'Fixture availability failure' }, 500); }
          dishes = dishes.map(row => row.id === rowId() ? { ...row, ...values } : row);
          return json(rows().find(row => row.id === rowId()));
        }
        if (method === 'POST') { const values = req.postDataJSON(); posts.push(values); const row = { image_url: null, ...values, id: uuid('25', nextId++) }; dishes.push(row); return json(rows().find(entry => entry.id === row.id)); }
        if (method === 'DELETE') { deletes.push(rowId()); dishes = dishes.filter(row => row.id !== rowId()); return json({ id: rowId() }); }
      }
      if (url.pathname === '/rest/v1/menu_categories') {
        if (method === 'GET') return json(categories);
        const values = method === 'DELETE' ? {} : req.postDataJSON(); categoryWrites.push({ method, id: rowId(), values });
        if (method === 'POST') { const row = { ...values, id: uuid('15', nextId++) }; delete row.business_id; categories.push(row); return json(row); }
        if (method === 'PATCH') { categories = categories.map(row => row.id === rowId() ? { ...row, ...values } : row); return json(categories.find(row => row.id === rowId())); }
        if (method === 'DELETE') { categories = categories.filter(row => row.id !== rowId()); return json({ id: rowId() }); }
      }
      if (url.pathname === '/rest/v1/rpc/reorder_menu_items' || url.pathname === '/rest/v1/rpc/reorder_menu_categories') {
        const body = req.postDataJSON(); reorders.push({ fn: url.pathname.slice(13), body });
        assert.equal(body.p_business_slug, slug);
        if (staleNext) { staleNext = false; return json({ code: '40001', message: 'menu changed', details: null, hint: null }, 409); }
        if (body.p_item_ids) dishes = dishes.map(row => body.p_item_ids.includes(row.id) ? { ...row, sort_order: body.p_item_ids.indexOf(row.id) } : row);
        else categories = categories.map(row => ({ ...row, sort_order: body.p_category_ids.indexOf(row.id) }));
        return json((body.p_item_ids ?? body.p_category_ids).length);
      }
      throw new Error(`Unhandled owner menu fixture: ${method} ${url.pathname}`);
    });
    try {
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(owner.url, { waitUntil: 'networkidle' });
      await page.getByLabel('Email', { exact: true }).filter({ visible: true }).fill(user.email); await page.getByLabel('Password', { exact: true }).filter({ visible: true }).fill('synthetic-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('navigation', { name: 'Owner sections' }).getByRole('button', { name: 'Menu', exact: true }).click();
      const button = name => page.getByRole('button', { name, exact: true });
      const toggle = name => page.getByRole('switch', { name: `Available: ${name}`, exact: true });
      const text = value => page.getByText(value, { exact: true });
      const focused = name => page.waitForFunction(expected => (document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent) === expected, name);
      const order = section => page.locator('[aria-label^="Edit "]').evaluateAll((nodes, ids) => nodes.map(node => node.getAttribute('aria-label').slice(5)).filter(name => ids.includes(name)), section);
      await button('Edit Fish thali').waitFor();

      // 1. Indicators, sections and summaries.
      assert.equal(await page.getByLabel('Search dishes', { exact: true }).getAttribute('placeholder'), 'Search 6 dishes');
      await page.getByRole('heading', { name: 'Thalis', exact: true }).waitFor();
      await text('3 dishes').waitFor(); await text('3 dishes · 1 off').waitFor(); await text('0 dishes').waitFor(); await text('No dishes in this category yet.').waitFor();
      assert.equal(await page.getByRole('img', { name: 'Non-vegetarian', exact: true }).count(), 2);
      assert.equal(await page.getByRole('img', { name: 'Vegetarian', exact: true }).count(), 4);
      await text('₹320').waitFor(); await text(feature).waitFor(); await text('Currently unavailable').waitFor(); await text('Sample').waitFor(); await text('No photo').waitFor();
      assert.equal(await toggle('Kothimbir vadi').isChecked(), false); assert.equal(await toggle('Fish thali').isChecked(), true);
      assert.equal(await page.getByLabel('Order within category').count(), 0);
      assert.deepEqual(await order(['Fish thali', 'Veg thali', 'Chicken thali']), ['Fish thali', 'Veg thali', 'Chicken thali']);
      await page.getByRole('heading', { name: 'Menu', exact: true }).waitFor();
      assert.equal(await button('Add dish').count(), 1, 'Add dish sits in the Menu header');
      await page.screenshot({ path: `${shots}/${slug}-owner-menu.png` });
      await page.setViewportSize({ width: 390, height: 2000 }); await page.screenshot({ path: `${shots}/${slug}-owner-menu-full.png` }); await page.setViewportSize({ width: 390, height: 844 });

      // 2. Search by dish or category, empty result and clear.
      const search = page.getByLabel('Search dishes', { exact: true });
      await search.fill('VADI'); await text('1 dish matches “VADI”.').waitFor();
      assert.equal(await button('Edit Fish thali').count(), 0); assert.equal(await button('Edit Kothimbir vadi').count(), 1);
      assert.equal(await page.getByRole('heading', { name: 'Thalis', exact: true }).count(), 0);
      await text('Clear the search to change the order.').waitFor();
      assert.equal(await button('Reorder Kothimbir vadi').isDisabled(), true, 'filtered lists cannot be reordered');
      await search.fill('thalis'); await text('3 dishes match “thalis”.').waitFor();
      await search.fill('biryani'); await text('No matching dishes').waitFor();
      await page.getByRole('button', { name: 'Clear search' }).first().click(); await button('Edit Fish thali').waitFor();
      console.log(`PASS ${slug} owner menu: grouped sections, diet/price/featured/sample/unavailable indicators and search`);

      // 3. Availability: optimistic, disabled while saving, availability-only PATCH, rollback on failure.
      let release; patchGate = { wait: new Promise(resolve => { release = resolve; }) };
      await toggle('Fish thali').click();
      await eventually(() => patches.length === 1);
      assert.equal(await toggle('Fish thali').isChecked(), false); assert.equal(await toggle('Fish thali').isDisabled(), true);
      assert.equal(await text('Fish thali now shows as currently unavailable.').count(), 0, 'no success before the server confirms');
      patchGate = null; release();
      await text('Fish thali now shows as currently unavailable.').waitFor();
      assert.deepEqual(patches[0], { id: id('Fish thali'), values: { available: false } });
      assert.equal(await toggle('Fish thali').isDisabled(), false); await text('3 dishes · 1 off').first().waitFor();
      failPatch = true; await toggle('Veg thali').click();
      await page.getByText(/Could not switch off Veg thali: .*Fixture availability failure/).waitFor();
      await eventually(async () => await toggle('Veg thali').isChecked());
      await text('Not saved. Veg thali is still available.').waitFor(); // beside the switch, not only at the top
      assert.deepEqual(patches[1].values, { available: false }); assert.equal(dishes.find(row => row.name === 'Veg thali').available, true);
      await toggle('Fish thali').click(); await text('Fish thali is available to order.').waitFor();
      assert.deepEqual(patches[2].values, { available: true });
      // The shared switch toggles once per key press (Space and Enter) with a visible focus ring.
      await toggle('Fish thali').focus(); await page.keyboard.press('Space');
      await text('Fish thali now shows as currently unavailable.').waitFor(); await page.waitForTimeout(300);
      assert.equal(patches.length, 4, 'Space toggles exactly once'); assert.deepEqual(patches[3].values, { available: false });
      assert.notEqual(await toggle('Fish thali').evaluate(node => getComputedStyle(node).outlineStyle), 'none', 'focus is visible');
      await page.keyboard.press('Enter'); await text('Fish thali is available to order.').waitFor(); await page.waitForTimeout(300);
      assert.equal(patches.length, 5, 'Enter toggles exactly once'); assert.deepEqual(patches[4].values, { available: true });
      const switchBox = await toggle('Fish thali').boundingBox(); assert.ok(switchBox.width >= 48 && switchBox.height >= 48, 'switch target is at least 48px');
      console.log(`PASS ${slug} owner menu: availability switch is optimistic, disabled in flight, availability-only and rolls back on failure`);

      // 4. Move up/down with the accessible controls, then stale-order recovery.
      await button('Reorder Veg thali').click();
      await button('Move Veg thali up').click();
      await text('Veg thali moved to position 1 of 3 in Thalis.').waitFor();
      assert.deepEqual(reorders.at(-1), { fn: 'reorder_menu_items', body: { p_business_slug: slug, p_category_id: thalis, p_item_ids: [id('Veg thali'), id('Fish thali'), id('Chicken thali')] } });
      assert.deepEqual(await order(['Fish thali', 'Veg thali', 'Chicken thali']), ['Veg thali', 'Fish thali', 'Chicken thali']);
      await focused('Move Veg thali down');
      assert.equal(await button('Move Veg thali up').isDisabled(), true);
      const loadsBefore = menuLoads; staleNext = true;
      await button('Move Veg thali down').click();
      await page.getByText(/The menu was changed on another device, so this new order was not saved\. The latest menu is shown; arrange it again\./).waitFor();
      assert.ok(menuLoads > loadsBefore, 'stale order reloads the authoritative menu');
      assert.deepEqual(reorders.at(-1).body.p_item_ids, [id('Fish thali'), id('Veg thali'), id('Chicken thali')]);
      assert.deepEqual(await order(['Fish thali', 'Veg thali', 'Chicken thali']), ['Veg thali', 'Fish thali', 'Chicken thali'], 'server order shown again');
      await button('Dismiss').click();
      await button('Reorder Veg thali').click(); assert.equal(await button('Move Veg thali up').count(), 0, 'handle toggles the move controls');

      // 5. Drag the handle with a pointer: Chicken thali up two rows.
      const handle = button('Reorder Chicken thali');
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      for (let step = 1; step <= 12; step++) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - step * 13);
      await page.mouse.up();
      await text('Chicken thali moved to position 1 of 3 in Thalis.').waitFor();
      assert.deepEqual(reorders.at(-1).body.p_item_ids, [id('Chicken thali'), id('Veg thali'), id('Fish thali')]);
      assert.equal(await button('Move Chicken thali up').count(), 0, 'a drag does not also toggle the move controls');
      console.log(`PASS ${slug} owner menu: move up/down and drag persist full category order; MENU_CHANGED reloads and explains`);

      // 6. Categories: reorder, rename, add at the end, delete only empty ones.
      await button('Manage categories').click(); await focused('Categories');
      assert.equal(await button('Delete category Thalis').isDisabled(), true);
      await button('Move category Snacks up').click(); await text('Snacks moved to position 1 of 3.').waitFor();
      assert.deepEqual(reorders.at(-1), { fn: 'reorder_menu_categories', body: { p_business_slug: slug, p_category_ids: [snacks, thalis, sweets] } });
      await focused('Move category Snacks down');
      await button('Rename category Sweets').click(); await focused('Rename category Sweets');
      await page.getByLabel('Category name', { exact: true }).fill('Desserts'); await button('Save category').click();
      await text('Category saved.').waitFor(); await focused('Categories');
      assert.deepEqual(categoryWrites.at(-1), { method: 'PATCH', id: sweets, values: { name: 'Desserts', sort_order: 2 } });
      await button('Add category').click(); await page.getByLabel('Category name', { exact: true }).fill(' '); await button('Save category').click();
      await text('Enter a name from 1 to 100 characters.').waitFor();
      await page.getByLabel('Category name', { exact: true }).fill('Drinks'); await button('Save category').click(); await text('Category saved.').waitFor();
      assert.deepEqual(categoryWrites.at(-1).values, { name: 'Drinks', sort_order: 3, business_id: businessId });
      await button('Delete category Drinks').click(); await button('Keep category').click(); await focused('Categories');
      await button('Delete category Drinks').click(); await button('Confirm delete category').click(); await text('Category deleted.').waitFor();
      assert.equal(categoryWrites.at(-1).method, 'DELETE');
      await button('Done').click(); await focused('Manage categories');
      assert.deepEqual(await page.getByRole('heading').allTextContents().then(all => all.filter(name => ['Thalis', 'Snacks', 'Desserts'].includes(name))), ['Snacks', 'Thalis', 'Desserts']);
      console.log(`PASS ${slug} owner menu: category reorder, rename, add-at-end, empty-only delete and focus return`);

      // 7. Edit dish: validation, category change joins the end, featured/sample, focus return.
      await button('Edit Fish thali').click(); await focused('Edit dish');
      const dialog = page.getByRole('dialog').last();
      await dialog.getByRole('button', { name: 'Change photo', exact: true }).waitFor();
      assert.equal(await dialog.getByLabel('Dish name', { exact: true }).inputValue(), 'Fish thali');
      assert.equal(await dialog.getByLabel('Price in rupees', { exact: true }).inputValue(), '320');
      assert.equal(await dialog.getByRole('button', { name: 'Non-vegetarian', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await dialog.getByRole('switch', { name: 'Available to order', exact: true }).isChecked(), true);
      assert.equal(await dialog.getByRole('switch', { name: feature, exact: true }).isChecked(), true);
      assert.equal(await dialog.getByRole('switch', { name: 'Sample dish', exact: true }).isChecked(), false);
      assert.equal(await dialog.getByLabel(/order within|category order|^order$/i).count(), 0, 'no numeric order field');
      await page.screenshot({ path: `${shots}/${slug}-owner-edit-dish.png` });
      await page.setViewportSize({ width: 390, height: 1400 }); await page.screenshot({ path: `${shots}/${slug}-owner-edit-dish-full.png` }); await page.setViewportSize({ width: 390, height: 844 });
      await dialog.getByLabel('Price in rupees', { exact: true }).fill('1.234'); await dialog.getByLabel('Dish name', { exact: true }).fill(' ');
      const patchesBefore = patches.length;
      await button('Save changes').click();
      await dialog.getByText('Enter a dish name.', { exact: true }).waitFor(); await dialog.getByText('Enter a positive amount up to 21,474,836.47 with up to two decimal places.', { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.id === 'dish-name');
      assert.equal(patches.length, patchesBefore);
      await dialog.getByLabel('Dish name', { exact: true }).fill('Fish thali special'); await dialog.getByLabel('Price in rupees', { exact: true }).fill('345.5');
      await dialog.getByRole('button', { name: 'Category: Thalis', exact: true }).click();
      await dialog.getByRole('button', { name: 'Snacks', exact: true }).click(); await focused('Category: Snacks');
      await dialog.getByRole('switch', { name: 'Sample dish', exact: true }).click();
      await button('Save changes').click();
      await text('Dish saved.').waitFor(); await focused('Edit Fish thali special');
      assert.deepEqual(patches.at(-1), { id: id('Fish thali special'), values: { diet: 'non_veg', name: 'Fish thali special', description: 'Neutral synthetic test description.', category_id: snacks, price_paise: 34550, available: true, is_demo: true, is_featured: true, sort_order: 3 } });
      await button('Edit Misal pav').click(); await focused('Edit dish');
      await page.getByRole('dialog').last().getByRole('switch', { name: feature, exact: true }).click(); await button('Save changes').click(); await text('Dish saved.').waitFor();
      assert.equal(patches.at(-1).values.is_featured, true); assert.equal(patches.at(-1).values.sort_order, dishes.find(row => row.name === 'Misal pav').sort_order, 'an edit keeps its position');

      // 8. Add dish: diet required, placed at the end of its category; then delete with confirmation.
      await button('Add dish').click(); await focused('Add dish');
      const add = page.getByRole('dialog').last();
      await add.getByText('Save the dish first, then open it again to add a photo.', { exact: true }).waitFor();
      await add.getByLabel('Dish name', { exact: true }).fill('Prawn thali'); await add.getByLabel('Price in rupees', { exact: true }).fill('410');
      await add.getByRole('button', { name: 'Category: not chosen', exact: true }).click(); await add.getByRole('button', { name: 'Thalis', exact: true }).click();
      await button('Save dish').click(); await add.getByText('Choose a diet classification.', { exact: true }).waitFor();
      await add.getByText('Check the highlighted fields above.', { exact: true }).waitFor(); // next to Save
      assert.equal(posts.length, 0);
      await add.getByRole('button', { name: 'Contains egg', exact: true }).focus(); await page.keyboard.press('Space');
      await eventually(async () => await add.getByRole('button', { name: 'Contains egg', exact: true }).getAttribute('aria-pressed') === 'true');
      await button('Save dish').click();
      await text('Dish added. Open it again to add a photo.').waitFor(); await focused('Add dish');
      assert.deepEqual(posts[0], { diet: 'egg', name: 'Prawn thali', description: '', category_id: thalis, price_paise: 41000, available: true, is_demo: false, is_featured: false, sort_order: 2, business_id: businessId });
      const prawn = id('Prawn thali');
      await button('Edit Prawn thali').click(); await focused('Edit dish');
      await button('Delete this dish').click(); await focused('Delete Prawn thali?');
      await button('Keep dish').click(); await focused('Delete this dish');
      await button('Delete this dish').click(); await button('Delete dish').click();
      await text('Prawn thali deleted.').waitFor(); await focused('Search dishes');
      assert.deepEqual(deletes, [prawn]);
      assert.equal(await button('Edit Prawn thali').count(), 0);
      console.log(`PASS ${slug} owner menu: edit/add validation, category picker, featured "${feature}", sample flag, saved position and delete confirmation`);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await context.close(); await owner.close(); }
  }
} finally { await browser?.close(); }
async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
