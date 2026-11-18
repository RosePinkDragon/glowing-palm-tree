import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #60 owners' Restaurant details screen, through each built brand's real admin and customer exports.
// Installed SDK, synthetic HTTP only; the realtime socket is answered with empty joins.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W60_SHOTS || 'dist/browser';
const visible = locator => locator.filter({ visible: true });
const users = ['owner', 'customer'].map((name, index) => ({ id: `60500000-0000-4000-8000-00000000000${index + 1}`, email: `${name}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const actor = request => { try { return JSON.parse(Buffer.from(request.headers().authorization.replace('Bearer ', '').split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`), customer = await serveWeb(`apps/${slug}-customer/dist/web`);
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', prefix = brand ? 'KDI' : 'AMS', businessId = `60600000-0000-4000-8000-00000000000${brand + 1}`, orderId = '60700000-0000-4000-8000-000000000001';
    const business = { id: businessId, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: '+919820044556', settings_version: 3, order_prefix: prefix, service_area_source: 'owner survey', service_area_version: brand ? 'radius-2500m' : 'radius-12000m', service_area_verified_at: '2026-11-10T00:00:00Z' };
    const order = { id: orderId, order_number: `${prefix}-202611000001`, business_id: businessId, customer_id: users[1].id, status: 'placed', version: 1, created_at: '2026-11-16T06:30:00Z', subtotal_paise: 10000, delivery_fee_paise: 3000, total_paise: 13000, customer_name: 'Synthetic customer', customer_phone: '9876543210', delivery_address_line: 'Synthetic address', order_items: [], order_status_history: [{ status: 'placed', created_at: '2026-11-16T06:30:00Z' }] };
    const saves = [];
    let nextSave = 'ok', gate = null, memberships = 0;
    const contexts = [];
    const open = async (url, audience, user) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); contexts.push(context);
      await context.addInitScript(({ slug, audience, value }) => { localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:${audience}`, JSON.stringify(value)); }, { slug, audience, value: session(user) });
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
        socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }));
      await context.route('**/*', async route => {
        const request = route.request(), path = new URL(request.url()).pathname, origin = new URL(request.url()).origin, who = actor(request);
        if ([admin.url, customer.url].includes(origin)) return route.fallback();
        assert.equal(origin, api, 'no unconfigured third-party requests');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (path === '/auth/v1/token') return json(session(user));
        if (path === '/auth/v1/user') return json(user);
        if (path === '/rest/v1/businesses') { assert.equal(request.method(), 'GET', 'owners never update business columns directly'); return json(business); }
        if (path === '/rest/v1/business_memberships') { memberships++; return json(who === users[0].id ? { role: 'admin' } : null); }
        if (path === '/rest/v1/menu_items' || path === '/rest/v1/menu_categories') return json([]);
        if (path === '/rest/v1/orders') return json(new URL(request.url()).searchParams.has('id') ? order : [order]);
        if (path === '/rest/v1/rpc/save_restaurant_settings') {
          const body = request.postDataJSON(); saves.push({ actor: who, authorization: request.headers().authorization, body });
          assert.equal(who, users[0].id, 'only the owner reaches the settings write');
          const mode = nextSave; nextSave = 'ok'; const held = gate; gate = null;
          if (held) { held.arrived.resolve(); await held.release.promise; }
          if (mode === 'conflict') return json({ code: '40001', message: 'settings changed', details: null, hint: null }, 409);
          if (mode === 'forbidden') return json({ code: '42501', message: 'not an owner', details: null, hint: null }, 403);
          assert.equal(body.p_expected_version, business.settings_version, 'save carries the loaded version');
          Object.assign(business, { contact_phone: body.p_contact_phone, whatsapp_phone: body.p_whatsapp_phone, delivery_fee_paise: body.p_delivery_fee_paise, min_order_paise: body.p_min_order_paise, settings_version: business.settings_version + 1 });
          return json({ contact_phone: business.contact_phone, whatsapp_phone: business.whatsapp_phone, delivery_fee_paise: business.delivery_fee_paise, min_order_paise: business.min_order_paise, settings_version: business.settings_version });
        }
        throw new Error(`Unexpected fixture request ${request.method()} ${path}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(url, { waitUntil: 'networkidle' });
      return { context, page };
    };
    try {
      const { page } = await open(admin.url, 'admin', users[0]);
      const button = label => visible(page.getByRole('button', { name: label, exact: true }));
      const input = label => visible(page.getByLabel(label, { exact: true }));
      const text = label => visible(page.getByText(label, { exact: true }));
      const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      const shot = file => page.screenshot({ path: `${shots}/${slug}-restaurant-details-${file}.png` });
      await button('Settings').click(); await button('Restaurant details').click();
      await visible(page.getByRole('heading', { name: 'Restaurant details', level: 1 })).waitFor();
      // Loaded values and the read-only block.
      await input('Phone number for customers').waitFor();
      assert.equal(await input('Phone number for customers').inputValue(), '+91 98200 44556');
      assert.equal(await input('WhatsApp number (optional)').inputValue(), '+91 98200 44556');
      assert.equal(await input('Delivery fee').inputValue(), '30'); assert.equal(await input('Minimum order').inputValue(), '150');
      await text(brand ? '2.5 km around the kitchen' : '12 km around the kitchen').waitFor(); await text(`${prefix}-YYYYMM0001`).waitFor(); await text('Ask your developer to change these.').waitFor();
      assert.equal(await visible(page.getByRole('textbox')).count(), 4, 'delivery area and prefix are not editable');
      // #114 p. 13: read-only info is a muted filled panel (no white bordered card); field outlines use the lighter token.
      const panel = text('Ask your developer to change these.').locator('xpath=..');
      const panelLook = await panel.evaluate(el => { const style = getComputedStyle(el); return { bg: style.backgroundColor, border: style.borderTopWidth }; });
      assert.equal(panelLook.bg, brand ? 'rgb(233, 235, 225)' : 'rgb(239, 232, 225)', 'read-only panel is muted filled'); assert.equal(panelLook.border, '0px', 'read-only panel has no outline');
      assert.equal(await input('Phone number for customers').locator('xpath=..').evaluate(el => getComputedStyle(el).borderTopColor), brand ? 'rgb(120, 141, 135)' : 'rgb(143, 124, 117)', 'field outline is the lighter token');
      assert.equal(await input('Phone number for customers').getAttribute('aria-required'), 'true');
      await shot('normal');
      // Invalid values: every field says what is wrong, focus goes to the first, nothing is sent.
      await input('Phone number for customers').fill(''); await input('WhatsApp number (optional)').fill('2223456789'); await input('Delivery fee').fill('12.345'); await input('Minimum order').fill('10000.01');
      await button('Save changes').click();
      for (const message of ['Enter an Indian mobile or landline number.', 'Enter an Indian mobile number or leave it empty.', 'Enter rupees with up to two decimal places.', 'Enter an amount from 0 to 10000 rupees.']) await text(message).waitFor();
      assert.equal(await visible(page.getByRole('alert')).count(), 4);
      assert.equal(saves.length, 0, 'nothing is sent while any field is invalid');
      await eventually(async () => await activeLabel() === 'Phone number for customers'); // focus moves to the first invalid field
      for (const label of ['Phone number for customers', 'WhatsApp number (optional)', 'Delivery fee', 'Minimum order']) {
        const field = input(label); assert.equal(await field.getAttribute('aria-invalid'), 'true', label);
        const described = await field.getAttribute('aria-describedby'); assert.ok(described, label);
        assert.match(await page.evaluate(ids => ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '), described), /\w/, 'error is linked by id');
      }
      assert.ok((await input('Phone number for customers').getAttribute('aria-describedby')).split(' ').some(id => id.endsWith('contactPhone-error')));
      await shot('errors');
      await input('Delivery fee').fill('1000.01'); await input('Phone number for customers').fill('98200 44556'); await input('WhatsApp number (optional)').fill('');
      await input('Minimum order').fill('150'); await button('Save changes').click();
      await text('Enter an amount from 0 to 1000 rupees.').waitFor(); assert.equal(saves.length, 0); await eventually(async () => await activeLabel() === 'Delivery fee');
      assert.equal(await text('Enter an Indian mobile or landline number.').count(), 0, 'a corrected field clears its error');
      // A valid save sends all four fields, exactly, once, while the control is locked.
      await input('Phone number for customers').fill('022 2345 6789'); await input('Delivery fee').fill('40.50'); await input('Minimum order').fill('200');
      const pending = { arrived: deferred(), release: deferred() }; gate = pending;
      await button('Save changes').click(); await pending.arrived.promise;
      await button('Saving').waitFor(); assert.equal(await button('Saving').isDisabled(), true);
      await button('Saving').click({ force: true, timeout: 1000 }).catch(() => {}); await input('Delivery fee').press('Enter', { timeout: 1000 }).catch(() => {});
      assert.equal(saves.length, 1, 'no double submit while saving');
      assert.equal(business.settings_version, 3, 'nothing is shown as saved before the server confirms');
      pending.release.resolve(); await text('Restaurant details saved.').waitFor();
      assert.deepEqual(saves[0].body, { p_business_slug: slug, p_contact_phone: '+912223456789', p_whatsapp_phone: null, p_delivery_fee_paise: 4050, p_min_order_paise: 20000, p_expected_version: 3 });
      assert.match(saves[0].authorization, /^Bearer /);
      assert.equal(await input('Phone number for customers').inputValue(), '+91 22234 56789'); assert.equal(await input('Delivery fee').inputValue(), '40.50');
      await button('Save changes').waitFor(); assert.equal(await button('Save changes').isEnabled(), true);
      // The customer's order page now calls the saved number.
      const guest = await open(`${customer.url}/orders/${orderId}`, 'customer', users[1]);
      const call = visible(guest.page.getByRole('link', { name: new RegExp(`^Call (us, )?${name}$`) }));
      await call.first().waitFor(); assert.equal(await call.first().getAttribute('href'), 'tel:+912223456789');
      // Another owner saved first: refused, the form is kept, Reload shows the latest, nothing is overwritten.
      Object.assign(business, { delivery_fee_paise: 5500, settings_version: 9, service_area_verified_at: null });
      await input('Delivery fee').fill('41'); nextSave = 'conflict';
      await button('Save changes').click();
      await text('Another owner saved changes. Reload to see the latest.').waitFor();
      assert.equal(saves.length, 2); assert.equal(saves[1].body.p_expected_version, 4, 'the stale version is what was sent');
      assert.equal(await button('Save changes').isDisabled(), true, 'a stale form cannot be saved over the newer values');
      assert.equal(business.delivery_fee_paise, 5500); assert.equal(await input('Delivery fee').inputValue(), '41');
      await button('Reload').scrollIntoViewIfNeeded(); await shot('conflict');
      await button('Reload').click(); await eventually(async () => await input('Delivery fee').inputValue() === '55');
      assert.equal(await text('Another owner saved changes. Reload to see the latest.').count(), 0);
      await text('Not set yet — ask your developer').waitFor(); // unverified area from the row
      assert.equal(await button('Save changes').isEnabled(), true); assert.equal(saves.length, 2, 'reload never writes');
      await input('Minimum order').fill('250'); await button('Save changes').click(); await text('Restaurant details saved.').waitFor();
      assert.equal(saves[2].body.p_expected_version, 9); assert.equal(saves[2].body.p_delivery_fee_paise, 5500); assert.equal(business.settings_version, 10);
      // Access removed in the meantime.
      nextSave = 'forbidden'; await input('Minimum order').fill('300'); await button('Save changes').click();
      await text('You no longer have access to change restaurant details.').waitFor(); assert.equal(await button('Save changes').isDisabled(), true);
      // Back returns to Settings.
      await button('Back to Settings').click(); await button('Log out').waitFor();
      Object.assign(business, { service_area_version: 'hand-drawn-v2', service_area_verified_at: '2026-11-10T00:00:00Z' });
      await button('Restaurant details').click(); await text('Set by your developer').waitFor(); await text(`${prefix}-YYYYMM0001`).waitFor();
      await button('Back to Settings').click(); await button('Log out').waitFor();
      // A customer account in the owners' app and the customer app never reach the screen.
      const before = saves.length;
      const denied = await open(admin.url, 'admin', users[1]); await visible(denied.page.getByText('Access denied', { exact: true })).waitFor();
      assert.equal(await denied.page.getByText('Restaurant details').count(), 0); assert.equal(await denied.page.getByRole('button', { name: 'Settings' }).count(), 0);
      assert.equal(await guest.page.getByText('Restaurant details').count(), 0); assert.equal(saves.length, before);
      console.log(`PASS: ${slug} Restaurant details (#60): loaded and read-only fields, per-field errors with no request, exact save body, no double submit, saved number on the customer Call link, conflict reload, access removed, customer denied`);
    } finally { for (const context of contexts) await context.close(); await admin.close(); await customer.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

async function eventually(check) {
  for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
