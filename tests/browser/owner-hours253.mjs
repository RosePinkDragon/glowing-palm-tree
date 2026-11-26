import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #253 slice 2, owners' app: the "Opening hours" section of Restaurant details, through each brand's real admin export.
// Installed SDK, synthetic HTTP only; the realtime socket is answered with empty joins.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W253_SHOTS || 'dist/browser';
const visible = locator => locator.filter({ visible: true });
const user = { id: '25300000-0000-4000-8000-0000000000a1', email: 'owner@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', prefix = brand ? 'KDI' : 'AMS';
    const business = { id: `25500000-0000-4000-8000-00000000000${brand + 1}`, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: null, settings_version: 3, order_prefix: prefix, service_area_source: 'owner survey', service_area_version: 'radius-12000m', service_area_verified_at: '2026-11-10T00:00:00Z', opens_at: brand ? '11:00:00' : '09:00:00', closes_at: brand ? '00:00:00' : '19:30:00' };
    const hourSaves = [], settingSaves = [];
    let nextHours = 'ok';
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:${encodeURIComponent(api)}:${slug}:admin`, value: session });
    await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
      const data = JSON.parse(String(message)), array = Array.isArray(data);
      const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
      if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
      const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
      socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
    }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin === admin.url) return route.fallback();
      assert.equal(url.origin, api, 'no unconfigured third-party calls');
      const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
      if (path === '/auth/v1/token') return json(session);
      if (path === '/auth/v1/user') return json(user);
      if (path === '/rest/v1/businesses') return json(business);
      if (path === '/rest/v1/business_memberships') return json({ role: 'admin' });
      if (path === '/rest/v1/menu_items' || path === '/rest/v1/menu_categories' || path === '/rest/v1/orders') return json([]);
      if (path === '/rest/v1/rpc/save_opening_hours') {
        const body = request.postDataJSON(); hourSaves.push(body);
        const mode = nextHours; nextHours = 'ok';
        if (mode === 'conflict') return json({ code: '40001', message: 'settings changed', details: null, hint: null }, 409);
        if (mode === 'invalid') return json({ code: '22023', message: 'The closing time must be after the opening time.', details: 'closesAt', hint: null }, 400);
        assert.equal(body.p_expected_version, business.settings_version, 'the save carries the loaded version');
        Object.assign(business, { opens_at: body.p_opens_at && `${body.p_opens_at}:00`, closes_at: body.p_closes_at && `${body.p_closes_at}:00`, settings_version: business.settings_version + 1 });
        return json({ opens_at: business.opens_at, closes_at: business.closes_at, settings_version: business.settings_version });
      }
      if (path === '/rest/v1/rpc/save_restaurant_settings') {
        const body = request.postDataJSON(); settingSaves.push(body);
        assert.equal(body.p_expected_version, business.settings_version, 'the other form saves against the version the hours save returned');
        Object.assign(business, { contact_phone: body.p_contact_phone, whatsapp_phone: body.p_whatsapp_phone, delivery_fee_paise: body.p_delivery_fee_paise, min_order_paise: body.p_min_order_paise, settings_version: business.settings_version + 1 });
        return json({ contact_phone: business.contact_phone, whatsapp_phone: business.whatsapp_phone, delivery_fee_paise: business.delivery_fee_paise, min_order_paise: business.min_order_paise, settings_version: business.settings_version });
      }
      throw new Error(`Unexpected owner hours fixture ${request.method()} ${path}`);
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const button = label => visible(page.getByRole('button', { name: label, exact: true }));
    const input = label => visible(page.getByLabel(label, { exact: true }));
    const text = label => visible(page.getByText(label, { exact: true }));
    const allDay = () => visible(page.getByRole('switch', { name: 'Open all day', exact: true }));
    const activeLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    const discard = () => visible(page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Discard changes?', exact: true }) }));
    try {
      await page.goto(admin.url, { waitUntil: 'networkidle' });
      await button('Settings').click(); await button('Restaurant details').click();
      await visible(page.getByRole('heading', { name: 'Opening hours', level: 2 })).waitFor();
      // Loaded window, shown the way it is typed.
      assert.equal(await allDay().getAttribute('aria-checked'), 'false');
      assert.equal(await input('Opening time').inputValue(), brand ? '11:00' : '09:00'); assert.equal(await input('Closing time').inputValue(), brand ? 'Midnight' : '19:30');
      await text(brand ? 'Customers can order from 11 am to midnight, India time.' : 'Customers can order from 9 am to 7:30 pm, India time.').waitFor();
      await visible(page.getByRole('heading', { name: 'Opening hours', level: 2 })).evaluate(node => node.scrollIntoView({ block: 'start' })); await page.screenshot({ path: `${shots}/${slug}-owner-hours.png` });
      // Invalid entries: field errors next to the inputs, focus on the first, nothing sent.
      await input('Opening time').fill('banana'); await input('Closing time').fill('');
      await button('Save opening hours').click();
      await text('Enter the opening time as hours and minutes, for example 09:00.').waitFor(); await text('Enter the closing time, for example 19:30, or Midnight.').waitFor();
      assert.equal(hourSaves.length, 0); await eventually(async () => await activeLabel() === 'Opening time');
      for (const label of ['Opening time', 'Closing time']) {
        assert.equal(await input(label).getAttribute('aria-invalid'), 'true', label);
        assert.match(await page.evaluate(ids => ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '), await input(label).getAttribute('aria-describedby')), /Enter the/, 'error is linked by id');
      }
      await page.screenshot({ path: `${shots}/${slug}-owner-hours-errors.png` });
      await input('Opening time').fill('7 pm'); await input('Closing time').fill('9 am'); await button('Save opening hours').click();
      await text('Closing must be after opening on the same day. Midnight is allowed.').waitFor(); assert.equal(hourSaves.length, 0);
      assert.equal(await text('Enter the opening time as hours and minutes, for example 09:00.').count(), 0, 'corrected fields clear their errors');
      // A valid window, typed naturally, with Midnight as the closing time.
      await input('Opening time').fill('11 am'); await button('Close at midnight').click();
      assert.equal(await input('Closing time').inputValue(), 'Midnight');
      await button('Save opening hours').click(); await text('Opening hours saved.').waitFor();
      assert.deepEqual(hourSaves, [{ p_business_slug: slug, p_opens_at: '11:00', p_closes_at: '00:00', p_expected_version: 3 }]);
      assert.equal(await input('Opening time').inputValue(), '11:00'); assert.equal(await input('Closing time').inputValue(), 'Midnight');
      // #200: hours count as unsaved changes; saved hours do not.
      await input('Opening time').fill('10:00'); await button('Back to Settings').click(); await discard().waitFor();
      await button('Keep editing').click(); await discard().waitFor({ state: 'hidden' }); assert.equal(await input('Opening time').inputValue(), '10:00', 'Keep editing keeps the typed hours');
      await input('Opening time').fill('11:00 am'); // the same time written another way is not a change
      // The other settings now save against the version the hours save returned (4), not the one loaded (3).
      await input('Delivery fee').fill('45'); await button('Save changes').click(); await text('Restaurant details saved.').waitFor();
      assert.equal(settingSaves.length, 1); assert.equal(settingSaves[0].p_expected_version, 4); assert.equal(business.settings_version, 5);
      // And hours save again against that newer version.
      await allDay().click(); assert.equal(await visible(page.getByRole('textbox')).count(), 4, 'Open all day hides the time boxes');
      await button('Save opening hours').click(); await text('Opening hours saved.').waitFor();
      assert.deepEqual(hourSaves.at(-1), { p_business_slug: slug, p_opens_at: null, p_closes_at: null, p_expected_version: 5 });
      await text('Open all day: customers can order whenever the ordering switch is on.').waitFor();
      await button('Back to Settings').click(); await button('Log out').waitFor(); // nothing unsaved: no prompt
      await button('Restaurant details').click(); await allDay().waitFor(); assert.equal(await allDay().getAttribute('aria-checked'), 'true', 'cleared hours reload as Open all day');
      // The server's own field error is shown next to its input.
      await allDay().click(); await input('Opening time').fill('09:00'); await input('Closing time').fill('18:00'); nextHours = 'invalid';
      await button('Save opening hours').click(); await text('The closing time must be after the opening time.').waitFor();
      assert.equal(await input('Closing time').getAttribute('aria-invalid'), 'true'); await eventually(async () => await activeLabel() === 'Closing time');
      // Another owner changed the settings first: refused, the form is kept, Reload shows the latest, nothing is overwritten.
      Object.assign(business, { opens_at: '10:00:00', closes_at: '20:00:00', settings_version: 12 }); nextHours = 'conflict';
      await button('Save opening hours').click(); await text('Another owner saved changes. Reload to see the latest.').waitFor();
      assert.equal(hourSaves.at(-1).p_expected_version, 6, 'the stale version is what was sent'); assert.equal(await button('Save opening hours').isDisabled(), true);
      assert.equal(await input('Closing time').inputValue(), '18:00', 'the typed form is kept');
      await button('Reload').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${shots}/${slug}-owner-hours-conflict.png`, fullPage: true });
      await button('Reload').click(); await eventually(async () => await input('Closing time').inputValue() === '20:00');
      assert.equal(await input('Opening time').inputValue(), '10:00'); assert.equal(await button('Save opening hours').isEnabled(), true);
      await button('Save opening hours').click(); await text('Opening hours saved.').waitFor(); assert.equal(hourSaves.at(-1).p_expected_version, 12);
      assert.deepEqual(errors, []);
      console.log(`PASS: ${slug} owner opening hours (#253): loaded window, field errors with no request, exact save body, Midnight, Open all day, #200 discard check, shared version, server field error, conflict reload`);
    } catch (error) { await page.screenshot({ path: `${shots}/${slug}-owner-hours-failure.png`, fullPage: true }); throw error; }
    finally { await context.close(); await admin.close(); }
  }
} finally { await browser.close(); }

async function eventually(check) {
  for (let i = 0; i < 240; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
