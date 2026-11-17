import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #53 owners' Settings "Your name" section, through each built brand's real admin export.
// Installed SDK, synthetic HTTP only; the realtime socket is answered with empty joins.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W53_SHOTS || 'dist/browser';
const visible = locator => locator.filter({ visible: true });
const users = ['owner', 'customer'].map((name, index) => ({ id: `53500000-0000-4000-8000-00000000000${index + 1}`, email: `${name}@example.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' }));
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const actor = request => { try { return JSON.parse(Buffer.from(request.headers().authorization.replace('Bearer ', '').split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];
const invalidMessage = 'Enter a trimmed owner name of 1 to 60 characters without control or invisible characters.';
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', prefix = brand ? 'KDI' : 'AMS', businessId = `53600000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: '+919820044556', settings_version: 3, order_prefix: prefix, service_area_source: 'owner survey', service_area_version: 'radius-2500m', service_area_verified_at: '2026-11-10T00:00:00Z' };
    const membership = { business_id: businessId, user_id: users[0].id, role: 'admin', display_name: 'Suresh Pawar' };
    const saves = [];
    let nextSave = 'ok', gate = null;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    try {
      await context.addInitScript(({ slug, value }) => { localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:admin`, JSON.stringify(value)); }, { slug, value: session(users[0]) });
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
        socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }));
      await context.route('**/*', async route => {
        const request = route.request(), path = new URL(request.url()).pathname, origin = new URL(request.url()).origin;
        if (origin === admin.url) return route.fallback();
        assert.equal(origin, api, 'no unconfigured third-party requests');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (path === '/auth/v1/token') return json(session(users[0]));
        if (path === '/auth/v1/user') return json(users[0]);
        if (path === '/rest/v1/businesses') return json(business);
        if (path === '/rest/v1/business_memberships') return json(membership);
        if (['/rest/v1/menu_items', '/rest/v1/menu_categories', '/rest/v1/orders'].includes(path)) return json([]);
        if (path === '/rest/v1/rpc/set_owner_display_name') {
          const body = request.postDataJSON(); saves.push({ actor: actor(request), authorization: request.headers().authorization, body });
          const mode = nextSave; nextSave = 'ok'; const held = gate; gate = null;
          if (held) { held.arrived.resolve(); await held.release.promise; }
          if (mode === 'failed') return json({ code: 'XX000', message: 'boom', details: null, hint: null }, 500);
          if (mode === 'forbidden') return json({ code: '42501', message: 'not an owner', details: null, hint: null }, 403);
          membership.display_name = body.p_display_name;
          return json({ business_id: businessId, user_id: users[0].id, display_name: body.p_display_name });
        }
        throw new Error(`Unexpected fixture request ${request.method()} ${path}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(admin.url, { waitUntil: 'networkidle' });
      const button = label => visible(page.getByRole('button', { name: label, exact: true }));
      const input = visible(page.getByLabel('Name shown to your team', { exact: true }));
      const text = label => visible(page.getByText(label, { exact: true }));
      const section = () => page.getByText('Your name', { exact: true }).first().scrollIntoViewIfNeeded();
      const shot = async (size, file) => { await page.setViewportSize(size); await section(); await page.screenshot({ path: `${shots}/${slug}-owner-name-${file}-${size.width}.png` }); };
      await button('Settings').click();
      // Loaded: the stored name fills the field and the header card; Save waits for a change.
      await input.waitFor(); await text('Suresh Pawar').first().waitFor();
      assert.equal(await input.inputValue(), 'Suresh Pawar');
      assert.equal(await button('Save name').isDisabled(), true, 'nothing to save yet');
      assert.ok((await button('Save name').boundingBox()).height >= 44);
      await shot({ width: 390, height: 844 }, 'normal'); await shot({ width: 1280, height: 800 }, 'normal'); await page.setViewportSize({ width: 390, height: 844 });
      // Empty: light client check, nothing sent.
      await input.fill('   '); await button('Save name').click(); await text('Enter your name.').waitFor();
      // Invalid (invisible character): the validation message is shown, linked to the field, input kept, nothing sent.
      await input.fill('Suresh​Pawar'); await button('Save name').click();
      await text(invalidMessage).waitFor();
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      const described = await input.getAttribute('aria-describedby');
      assert.match(await page.evaluate(ids => ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '), described), /trimmed owner name/);
      assert.equal(await input.inputValue(), 'Suresh​Pawar'); assert.equal(saves.length, 0);
      await shot({ width: 390, height: 844 }, 'error'); await shot({ width: 1280, height: 800 }, 'error'); await page.setViewportSize({ width: 390, height: 844 });
      // Editing clears the error.
      await input.fill('Suresh P'); assert.equal(await text(invalidMessage).count(), 0);
      // Server failure: friendly message, input kept, can retry.
      nextSave = 'failed'; await button('Save name').click();
      await text('Could not save your name. Check your connection and try again.').waitFor();
      assert.equal(await input.inputValue(), 'Suresh P'); assert.equal(saves.length, 1); assert.equal(membership.display_name, 'Suresh Pawar');
      await visible(page.getByRole('alert')).first().waitFor();
      // Successful save: sent once, exact arguments, locked while pending, confirmed, header updated.
      const pending = { arrived: deferred(), release: deferred() }; gate = pending;
      await button('Save name').click(); await pending.arrived.promise;
      await button('Saving name').waitFor(); assert.equal(await button('Saving name').isDisabled(), true);
      await button('Saving name').click({ force: true, timeout: 1000 }).catch(() => {}); await input.press('Enter', { timeout: 1000 }).catch(() => {});
      assert.equal(saves.length, 2, 'no double submit while saving');
      pending.release.resolve(); await text('Your name is saved.').waitFor();
      assert.deepEqual(saves[1].body, { p_business_slug: slug, p_display_name: 'Suresh P' });
      assert.match(saves[1].authorization, /^Bearer /);
      assert.equal(await input.inputValue(), 'Suresh P'); await visible(page.getByRole('heading', { name: 'Suresh P', level: 2 })).waitFor();
      assert.equal(await button('Save name').isDisabled(), true);
      await shot({ width: 390, height: 844 }, 'saved'); await shot({ width: 1280, height: 800 }, 'saved'); await page.setViewportSize({ width: 390, height: 844 });
      // Keyboard: Enter in the field saves a trimmed name.
      await input.fill('  Suresh Pawar  '); await input.press('Enter'); await eventually(async () => saves.length === 3);
      assert.equal(saves[2].body.p_display_name, 'Suresh Pawar'); await text('Your name is saved.').waitFor();
      // Access removed: told so, input kept, Save locked.
      nextSave = 'forbidden'; await input.fill('Someone Else'); await button('Save name').click();
      await text('You no longer have access to change your name. Sign in again.').waitFor();
      assert.equal(await input.inputValue(), 'Someone Else'); assert.equal(await button('Save name').isDisabled(), true);
      console.log(`PASS: ${slug} owners' Your name (#53): loaded, empty and invalid-name errors with no request, failure keeps input, exact save body, no double submit, header updated, Enter saves trimmed, access removed`);
    } finally { await context.close(); await admin.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

async function eventually(check) {
  for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
