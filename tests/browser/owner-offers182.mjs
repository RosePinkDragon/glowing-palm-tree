import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #182 slice B: the owners' Offers screens, through each built brand's real admin export. Installed SDK, synthetic HTTP only
// (a small stateful stand-in for the offers and offer_redemptions tables); the realtime socket is answered with empty joins.
const api = 'https://market-fixture.supabase.co';
const shots = process.env.W182B_SHOTS || 'dist/browser';
const visible = locator => locator.filter({ visible: true });
const owner = { id: '18200000-0000-4000-8000-0000000000a1', email: 'owner@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const actor = request => { try { return JSON.parse(Buffer.from(request.headers().authorization.replace('Bearer ', '').split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
const lockedText = 'Terms are locked once an offer has been used. End it and create a new one to change them.';
const termColumns = ['kind', 'value', 'max_discount_paise', 'min_order_paise', 'apply_mode', 'code', 'first_order_only', 'per_customer_limit', 'total_limit', 'starts_at', 'window_from', 'window_to', 'window_days'];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const errors = [];
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) {
    const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
    const name = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', businessId = `18200000-0000-4000-8000-00000000000${brand + 1}`;
    const business = { id: businessId, slug, name, delivery_fee_paise: 3000, min_order_paise: 15000, is_demo: false, ordering_enabled: true, accepting_orders: true, contact_phone: '+919820044556', whatsapp_phone: '+919820044556', settings_version: 3, order_prefix: brand ? 'KDI' : 'AMS', service_area_source: 'owner survey', service_area_version: 'radius-2500m', service_area_verified_at: '2026-11-10T00:00:00Z' };
    let counter = 0;
    const idFor = () => `18200000-0000-4000-b000-${String(++counter).padStart(12, '0')}`;
    const make = over => ({ id: idFor(), business_id: businessId, name: 'Offer', kind: 'percent', value: 10, max_discount_paise: null, min_order_paise: 0, apply_mode: 'automatic', code: null, first_order_only: false, per_customer_limit: null, total_limit: null, starts_at: null, ends_at: null,
      window_from: null, window_to: null, window_days: null, paused: false, created_at: '2026-11-01T10:00:00+00:00', version: 1, ...over });
    const db = [], redemptions = [], dayOrders = [], log = { posts: [], patches: [], deletes: 0, listReads: 0 };
    let failList = true, failUsage = false;
    const open = async (viewport = { width: 390, height: 844 }, timezoneId = undefined) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block', ...(timezoneId ? { timezoneId } : {}) });
      await context.addInitScript(({ slug, value }) => { localStorage.setItem(`market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:admin`, JSON.stringify(value)); }, { slug, value: session(owner) });
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        if (!['phx_join', 'heartbeat', 'phx_leave'].includes(event)) return;
        const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 })) } };
        socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response }));
      }));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, q = url.searchParams, who = actor(request), method = request.method();
        if (url.origin === admin.url) return route.fallback();
        assert.equal(url.origin, api, 'no unconfigured third-party requests');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        const fail = (code, message, status, details = null) => json({ code, message, details, hint: null }, status);
        if (path === '/auth/v1/token') return json(session(owner));
        if (path === '/auth/v1/user') return json(owner);
        if (path === '/rest/v1/businesses') return json(business);
        if (path === '/rest/v1/business_memberships') return json(who === owner.id ? { role: 'admin' } : null);
        if (path === '/rest/v1/menu_items' || path === '/rest/v1/menu_categories') return json([]);
        if (path === '/rest/v1/orders') {
          if (!q.has('offer_id')) return json([]);
          // The Today card's read: this restaurant's non-cancelled orders that used an offer, inside one India-time day.
          assert.equal(q.get('business_id'), `eq.${businessId}`); assert.equal(q.get('status'), 'neq.cancelled');
          const [from, to] = q.getAll('created_at').map(value => value.replace(/^(gte|lt)\./, '')), after = q.get('id')?.replace('gt.', '');
          return json(dayOrders.filter(o => o.status !== 'cancelled' && o.created_at >= from && o.created_at < to && (!after || o.id > after)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(q.get('limit'))));
        }
        if (path === '/rest/v1/rpc/daily_summary') { const date = request.postDataJSON().p_date ?? new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); return json({ date, collected_paise: 0, delivered_count: 0, outstanding_paise: 0, outstanding_count: 0, placed_count: 0, cancelled_count: 0, top_dishes: [] }); }
        if (path === '/rest/v1/offer_redemptions') {
          if (failUsage) return fail('XX000', 'usage view unavailable', 500);
          const after = q.get('id')?.replace('gt.', ''), offer = q.get('offer_id')?.replace('eq.', '');
          assert.equal(q.get('business_id'), `eq.${businessId}`);
          return json(redemptions.filter(r => (!after || r.id > after) && (!offer || r.offer_id === offer)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(q.get('limit'))).map(r => ({ id: r.id, offer_id: r.offer_id, orders: { status: r.status, discount_paise: r.discount } })));
        }
        if (path === '/rest/v1/offers') {
          assert.equal(who, owner.id, 'only the owner reaches offers');
          if (method === 'DELETE') { log.deletes++; return fail('42501', 'permission denied for table offers', 403); }
          if (method === 'GET') {
            if (q.get('select') === 'id') { const found = db.find(o => o.id === q.get('id').replace('eq.', '')); return json(found ? { id: found.id } : null); }
            assert.equal(q.get('business_id'), `eq.${businessId}`); log.listReads++;
            if (failList) { failList = false; return fail('XX000', 'database unavailable', 500); }
            return json([...db].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)));
          }
          const body = request.postDataJSON(), live = code => code && db.some(o => o.code === code && (!o.ends_at || Date.parse(o.ends_at) > Date.now()));
          if (method === 'POST') {
            log.posts.push(body);
            if (live(body.code)) return fail('23505', 'code is already in use by another active or scheduled offer', 409);
            const row = make({ ...body, created_at: new Date().toISOString() }); db.push(row); return json(row, 201);
          }
          assert.equal(method, 'PATCH');
          log.patches.push({ query: Object.fromEntries(q), body });
          const found = db.find(o => o.id === q.get('id')?.replace('eq.', '') && o.business_id === q.get('business_id')?.replace('eq.', ''));
          if (!found || found.version !== Number(q.get('version')?.replace('eq.', ''))) return json([]);
          if (redemptions.some(r => r.offer_id === found.id) && termColumns.some(key => key in body && JSON.stringify(body[key]) !== JSON.stringify(found[key]))) return fail('PT409', 'offer terms are locked once it has been used', 409, 'OFFER_LOCKED');
          for (const [key, value] of Object.entries(body)) found[key] = value === 'now' ? new Date().toISOString() : value;
          found.version++; return json([found]);
        }
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      });
      const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(admin.url, { waitUntil: 'networkidle' });
      return { context, page };
    };
    const { context, page } = await open();
    try {
      const button = label => visible(page.getByRole('button', { name: label, exact: true }));
      const input = label => visible(page.getByLabel(label, { exact: true }));
      const text = label => visible(page.getByText(label, { exact: true }));
      const row = pattern => visible(page.getByRole('button', { name: pattern }));
      // Let the panel's fade finish so the screenshot is of the settled screen.
      const shot = async file => { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/${slug}-offers-${file}.png` }); };
      const gone = async locator => { await locator.first().waitFor({ state: 'hidden' }); };
      const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal overflow');
      const targets = async () => {
        const small = await page.evaluate(() => [...document.querySelectorAll('[role=button], [role=radio], [role=switch], input, textarea')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; })
          .map(el => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }).filter(item => item.w < 44 || item.h < 44));
        assert.deepEqual(small, [], 'every control is at least 44px');
      };
      const openOffers = async () => { await button('Settings').click(); await button('Offers').click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor(); };
      const primary = brand ? 'rgb(22, 92, 84)' : 'rgb(168, 62, 50)';

      // ---- Error state with retry, then the empty state ----
      await openOffers();
      await text("Couldn't load offers").waitFor(); await text('Check your connection and try again.').waitFor();
      assert.equal(await visible(page.getByText(/database unavailable|Could not load/)).count(), 0, 'raw server text is never shown');
      await shot('error-390'); await noOverflow();
      await button('Try again').click(); await text('No offers yet').waitFor(); await button('Create an offer').waitFor();
      await shot('empty-390'); await noOverflow();
      assert.equal(await button('New offer').evaluate(el => getComputedStyle(el).backgroundColor), primary, 'the primary action uses the brand token');

      // ---- Create a percent offer: validation errors first, then a valid one ----
      await button('New offer').click(); await visible(page.getByRole('heading', { name: 'New offer' })).waitFor();
      await eventually(async () => await page.evaluate(() => document.activeElement?.tagName === 'H1')); // the panel has finished opening and moved focus to its heading
      await targets(); await noOverflow(); await shot('form-new-390');
      await input('Offer name').fill('ab'); await input('Discount percent').fill('95'); await input('Maximum discount (optional)').fill('5000'); await input('Minimum order (optional)').fill('20000');
      await input('Uses per customer (optional)').fill('0'); await input('Total uses (optional)').fill('100001'); await input('Starts (optional)').fill('2026-12-02T10:00'); await input('Ends (optional)').fill('2026-12-01T10:00');
      await button('Create offer').click();
      for (const message of ['Enter a name of 3 to 40 characters.', 'Enter a whole percent from 1 to 90.', 'Enter an amount from ₹1 to ₹1,000, or leave it empty.', 'Enter an amount from ₹0 to ₹10,000, or leave it empty.', 'Enter a number from 1 to 99, or leave it empty.', 'Enter a number from 1 to 100,000, or leave it empty.']) await text(message).waitFor();
      await text('The end must be after the start.').waitFor(); await text('Check the highlighted fields above.').waitFor();
      assert.equal(log.posts.length, 0, 'nothing is sent while any field is invalid');
      await eventually(async () => await page.evaluate(() => document.activeElement?.getAttribute('aria-label')) === 'Offer name'); // focus goes to the first invalid field
      for (const label of ['Offer name', 'Discount percent', 'Maximum discount (optional)', 'Minimum order (optional)', 'Uses per customer (optional)', 'Total uses (optional)', 'Ends (optional)']) {
        const field = input(label); assert.equal(await field.getAttribute('aria-invalid'), 'true', label);
        assert.match(await page.evaluate(ids => ids.split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '), await field.getAttribute('aria-describedby')), /\w/, `${label}: the error is linked by id`);
      }
      await shot('form-errors-390');
      await input('Offer name').fill('Weekend 20'); await input('Discount percent').fill('20'); await input('Maximum discount (optional)').fill('100'); await input('Minimum order (optional)').fill('300');
      await input('Uses per customer (optional)').fill(''); await input('Total uses (optional)').fill(''); await input('Starts (optional)').fill(''); await input('Ends (optional)').fill('');
      assert.equal(await text('Enter a name of 3 to 40 characters.').count(), 0, 'a corrected field clears its error');
      // An end date that has already passed would save a dead offer: blocked, nothing sent.
      await input('Ends (optional)').fill('2020-01-01T00:00'); await button('Create offer').click(); await text('End must be in the future.').waitFor(); assert.equal(log.posts.length, 0);
      await input('Ends (optional)').fill('');
      await button('Create offer').click(); await text('Offer created.').waitFor();
      assert.deepEqual(log.posts, [{ business_id: businessId, name: 'Weekend 20', kind: 'percent', value: 20, max_discount_paise: 10000, min_order_paise: 30000, apply_mode: 'automatic', code: null, first_order_only: false, per_customer_limit: null, total_limit: null, starts_at: null, ends_at: null, window_from: null, window_to: null, window_days: null, paused: false }]);
      const weekend = row(/^Weekend 20, Active, 20% off up to ₹100, Automatic, 0 uses · ₹0 given$/); await weekend.waitFor();
      await visible(page.getByText(/20% off up to ₹100 · Automatic\s+0 uses · ₹0 given/)).waitFor(); await text('Active').first().waitFor(); await shot('list-created-390');

      // ---- Create a code offer: a duplicate code is refused on the field, then a unique one works ----
      db.push(make({ name: 'Existing code', kind: 'flat', value: 2500, apply_mode: 'code', code: 'SAVE50', created_at: '2026-11-02T10:00:00+00:00' }));
      db.push(make({ name: 'Future fest', kind: 'free_delivery', value: null, starts_at: '2099-01-01T00:00:00+00:00', created_at: '2026-11-03T10:00:00+00:00' }));
      await button('New offer').click(); await visible(page.getByRole('heading', { name: 'New offer' })).waitFor();
      await input('Offer name').fill('Dinner code'); await visible(page.getByRole('radio', { name: 'Flat ₹ off', exact: true })).click();
      assert.equal(await input('Maximum discount (optional)').count(), 0, 'max discount is for percent offers only');
      await input('Discount amount').fill('50'); await visible(page.getByRole('radio', { name: 'With a code', exact: true })).click();
      await input('Offer code').fill('save50');
      await visible(page.getByRole('switch', { name: 'First order only', exact: true })).click();
      await input('Uses per customer (optional)').fill('1'); await input('Total uses (optional)').fill('100');
      await input('Starts (optional)').fill('2026-12-01T18:00'); await input('Ends (optional)').fill('2027-01-31T23:59');
      await visible(page.getByRole('switch', { name: 'Happy hour window', exact: true })).click();
      await visible(page.getByRole('button', { name: 'Saturday', exact: true })).click(); await visible(page.getByRole('button', { name: 'Sunday', exact: true })).click();
      await targets(); await shot('form-code-390');
      await button('Create offer').click();
      await text('Another active or scheduled offer already uses this code.').waitFor();
      assert.equal(log.posts.length, 2); assert.equal(log.posts[1].code, 'SAVE50', 'the code is sent upper case');
      assert.equal(await input('Offer code').getAttribute('aria-invalid'), 'true'); assert.equal(await input('Offer name').inputValue(), 'Dinner code', 'the form is kept');
      await shot('form-duplicate-code-390');
      await input('Offer code').fill('dinner50'); await button('Create offer').click(); await text('Offer created.').waitFor();
      assert.deepEqual(log.posts[2], { business_id: businessId, name: 'Dinner code', kind: 'flat', value: 5000, max_discount_paise: null, min_order_paise: 0, apply_mode: 'code', code: 'DINNER50', first_order_only: true, per_customer_limit: 1, total_limit: 100,
        starts_at: '2026-12-01T12:30:00.000Z', ends_at: '2027-01-31T18:29:00.000Z', window_from: '15:00', window_to: '18:00', window_days: [1, 2, 3, 4, 5], paused: false });
      await row(/^Dinner code, Scheduled, ₹50 off, Code DINNER50, 0 uses · ₹0 given$/).waitFor(); await row(/^Future fest, Scheduled, Free delivery, Automatic/).waitFor();
      await text('Active and scheduled').waitFor();

      // ---- Pause, resume and end (with a confirmation sheet) ----
      await weekend.click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor(); await shot('form-edit-390');
      await button('Pause offer').click(); await text('Offer paused.').waitFor();
      await row(/^Weekend 20, Paused/).waitFor(); await text('Paused').first().waitFor(); await shot('list-paused-390');
      const groupTitles = await page.evaluate(() => [...document.querySelectorAll('[role=heading][aria-level="2"]')].map(el => el.textContent));
      assert.deepEqual(groupTitles.filter(t => ['Active and scheduled', 'Paused', 'Ended'].includes(t)), ['Active and scheduled', 'Paused'], 'paused offers sit after the running ones');
      await row(/^Weekend 20, Paused/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      assert.equal(await button('Pause offer').count(), 0); await button('Resume offer').click(); await text('Offer resumed.').waitFor(); await row(/^Weekend 20, Active/).waitFor();
      await row(/^Weekend 20, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      await button('End offer').click(); await visible(page.getByRole('heading', { name: 'End Weekend 20?' })).waitFor(); await shot('end-sheet-390');
      const patchesBefore = log.patches.length;
      await button('Keep offer').click(); await gone(page.getByRole('heading', { name: 'End Weekend 20?' })); assert.equal(log.patches.length, patchesBefore, 'keeping the offer sends nothing');
      await button('End offer').click(); await button('End offer now').click(); await text('Offer ended.').waitFor();
      await row(/^Weekend 20, Ended/).waitFor(); await text('Ended').first().waitFor(); await shot('list-ended-390');
      assert.deepEqual(log.patches.map(p => [p.body, p.query.version]), [[{ paused: true }, 'eq.1'], [{ paused: false }, 'eq.2'], [{ ends_at: 'now' }, 'eq.3']], 'one statement each, guarded by the loaded version');
      assert.ok(log.patches.every(p => /^eq\.18200000-/.test(p.query.id)), 'each statement names exactly one offer');
      await row(/^Weekend 20, Ended/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      for (const label of ['Pause offer', 'Resume offer', 'End offer']) assert.equal(await button(label).count(), 0, `an ended offer cannot be ${label}`);
      // An ended offer is view only: its end date cannot quietly bring it back.
      await text('This offer has ended. Create a new one to run it again.').waitFor();
      assert.equal(await visible(page.getByRole('textbox')).count(), 0, 'no editable fields'); assert.equal(await visible(page.getByRole('radio')).count(), 0); assert.equal(await visible(page.getByRole('switch')).count(), 0);
      assert.equal(await button('Save changes').isDisabled(), true); await text('Weekend 20').first().waitFor();
      const patchesAtEnded = log.patches.length; await button('Save changes').click({ force: true, timeout: 1000 }).catch(() => {}); assert.equal(log.patches.length, patchesAtEnded, 'nothing can be sent'); await shot('form-ended-390');
      await button('Back').click(); await gone(page.getByRole('heading', { name: 'Edit offer' }));

      // ---- A used offer: terms are read-only, only the name and end date change ----
      const used = make({ name: 'Used deal', value: 10, min_order_paise: 20000, first_order_only: true, per_customer_limit: 2, total_limit: 50, apply_mode: 'code', code: 'USED10', created_at: '2026-11-04T10:00:00+00:00', window_from: '18:00:00', window_to: '22:30:00', window_days: [1, 3, 5] });
      db.push(used);
      redemptions.push({ id: 'r1', offer_id: used.id, status: 'delivered', discount: 2000 }, { id: 'r2', offer_id: used.id, status: 'placed', discount: 2000 }, { id: 'r3', offer_id: used.id, status: 'cancelled', discount: 9000 });
      await button('Back to Settings').click(); await button('Offers').click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor();
      await row(/^Used deal, Active, 10% off, Code USED10, 2 uses · ₹40 given$/).waitFor();
      await visible(page.getByText(/10% off · Code USED10\s+2 uses · ₹40 given/)).waitFor(); // the cancelled order gave its use and its amount back
      await row(/^Used deal, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      await text(lockedText).waitFor();
      for (const label of ['Discount percent', 'Offer code', 'Minimum order (optional)', 'Starts (optional)', 'Total uses (optional)']) assert.equal(await input(label).count(), 0, `${label} is not editable on a used offer`);
      assert.equal(await visible(page.getByRole('radio')).count(), 0); assert.equal(await visible(page.getByRole('switch')).count(), 0);
      for (const label of ['10% off', '₹200', 'Code USED10', 'Yes', '6:00 pm to 10:30 pm, Mon, Wed, Fri']) await text(label).first().waitFor();
      assert.equal(await visible(page.getByRole('textbox')).count(), 2, 'only the name and the end date are editable');
      await input('Offer name').waitFor(); await input('Ends (optional)').waitFor(); await button('Pause offer').waitFor(); await targets(); await shot('form-locked-390');
      await input('Offer name').fill('Used deal 2'); await input('Ends (optional)').fill('2027-01-01T00:00'); await button('Save changes').click(); await text('Offer saved.').waitFor();
      const lockedPatch = log.patches.at(-1);
      assert.deepEqual(lockedPatch.body, { name: 'Used deal 2', ends_at: '2026-12-31T18:30:00.000Z' }, 'only the name and end date are sent'); assert.deepEqual(Object.keys(lockedPatch.body).filter(key => termColumns.includes(key)), []);

      // ---- Another owner changed it first: stale, nothing overwritten, Reload shows the latest ----
      await row(/^Used deal 2, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      Object.assign(used, { name: 'Used deal remote', version: used.version + 1 });
      await input('Offer name').fill('Used deal local'); await button('Save changes').click();
      await text('Another owner changed this offer. Reload to see the latest.').waitFor();
      assert.equal(log.patches.at(-1).query.version, `eq.${used.version - 1}`, 'the stale version is what was sent'); assert.equal(used.name, 'Used deal remote', 'nothing was overwritten');
      assert.equal(await button('Save changes').isDisabled(), true, 'a stale form cannot be saved over the newer values'); await shot('form-stale-390');
      await button('Reload offer').click(); await text('Another owner changed this offer. Reload to see the latest.').waitFor({ state: 'hidden' });
      await eventually(async () => await input('Offer name').inputValue() === 'Used deal remote');
      await input('Offer name').fill('Used deal final'); await button('Save changes').click(); await text('Offer saved.').waitFor(); assert.equal(used.name, 'Used deal final');

      // ---- The offer is used while the owner is editing its terms: refused as locked, then shown locked ----
      const race = make({ name: 'Race deal', value: 15, created_at: '2026-11-05T10:00:00+00:00' }); db.push(race);
      await row(/^Weekend 20, Ended/).waitFor().catch(() => {}); await button('Back to Settings').click(); await button('Offers').click();
      await row(/^Race deal, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      assert.equal(await text(lockedText).count(), 0, 'an unused offer is editable');
      redemptions.push({ id: 'r4', offer_id: race.id, status: 'delivered', discount: 1500 });
      await input('Discount percent').fill('25'); await button('Save changes').click();
      await text(lockedText).waitFor(); assert.equal(race.value, 15); assert.equal(await button('Save changes').isDisabled(), true);
      await button('Reload offer').click(); await eventually(async () => await input('Discount percent').count() === 0);
      await text(lockedText).waitFor(); assert.equal(await text(lockedText).count(), 1, 'the banner is replaced by the locked terms');
      await button('Back').click(); await gone(page.getByRole('heading', { name: 'Edit offer' }));

      // ---- Usage cannot be read: the offers still list, and pause, resume and end keep working ----
      await button('Back to Settings').click(); failUsage = true; await button('Offers').click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor();
      await text("Usage couldn't be loaded, so counts are hidden. You can still pause, resume and end offers.").waitFor(); await button('Reload usage').waitFor();
      await row(/^Race deal, Active, 15% off, Automatic, Usage unavailable$/).waitFor(); await row(/^Used deal final, Active, 10% off, Code USED10, Usage unavailable$/).waitFor();
      assert.equal(await visible(page.getByText(/\d+ uses? · /)).count(), 0, 'no invented counts'); await shot('list-usage-unavailable-390');
      await row(/^Race deal, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      assert.equal(await text(lockedText).count(), 0, 'with usage unknown the terms are editable and the database decides');
      await button('Pause offer').click(); await text('Offer paused.').waitFor(); await row(/^Race deal, Paused, 15% off, Automatic, Usage unavailable$/).click();
      await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor(); await button('Resume offer').click(); await text('Offer resumed.').waitFor();
      await row(/^Race deal, Active/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor(); await input('Discount percent').fill('25'); await button('Save changes').click();
      await text(lockedText).waitFor(); assert.equal(race.value, 15, 'the database refused the edit of a used offer'); await button('Back').click(); await gone(page.getByRole('heading', { name: 'Edit offer' }));
      failUsage = false;

      // ---- The Today tab's Offers card: history from the orders' own snapshots, running offers for today ----
      await button('Back to Settings').click(); await button('Settings').waitFor();
      const created = new Date().toISOString(), snap = (id, over) => ({ id, status: 'delivered', created_at: created, offer_id: used.id, offer_name: 'Used deal (old name)', offer_code: 'USED10', offer_kind: 'percent', discount_paise: 2000, ...over });
      dayOrders.push(snap('t1', {}), snap('t2', { discount_paise: 3000 }), snap('t3', { offer_id: db[0].id, offer_name: 'Weekend 20', offer_code: null, offer_kind: 'free_delivery', discount_paise: 3000, status: 'placed' }), snap('t4', { discount_paise: 9000, status: 'cancelled' }));
      await button('Today').click(); await text('CASH').waitFor();
      const card = visible(page.getByRole('button', { name: 'Offers', exact: true }));
      await card.waitFor(); await text('Code USED10 · 2 uses · ₹50 given').waitFor(); await text('Automatic · 1 use · ₹30 given').waitFor();
      await text('₹80 given across 3 orders').waitFor(); // the cancelled order's ₹90 is not counted
      await text('Used deal (old name)').waitFor(); // the order's own snapshot, not the live offer's current name
      await text('Code SAVE50 · Running · no uses yet').waitFor(); await text('Automatic · Running · no uses yet').first().waitFor(); // active offers nobody used today
      assert.equal(await text('Future fest').count(), 0, 'a scheduled offer is not running'); assert.equal(await text('Dinner code').count(), 0);
      await noOverflow(); await shot('today-offers-390');
      await page.setViewportSize({ width: 1280, height: 800 }); await noOverflow(); await shot('today-offers-1280'); await page.setViewportSize({ width: 390, height: 844 });
      // An earlier day with nothing used.
      await button('Yesterday').click(); await text('No offers used on this day').waitFor(); assert.equal(await text('Code SAVE50 · Running · no uses yet').count(), 0, 'running offers are for today only'); await shot('today-offers-empty-day-390');
      // Today with nothing running and nothing used: a way to create one.
      const paused = db.filter(o => !o.paused); for (const o of paused) o.paused = true; const keep = dayOrders.splice(0);
      await visible(page.getByRole('group', { name: 'Choose a day' }).getByRole('button', { name: /^Today,/ })).click();
      await text('No offers running').waitFor(); await shot('today-offers-none-390');
      await button('Create an offer').click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor();
      for (const o of paused) o.paused = false; dayOrders.push(...keep); // Back remounts Today, which reads the day again
      await button('Back to Today').click(); await text('CASH').waitFor();
      // Tapping the card header opens Offers, and Back comes home to Today.
      await text('₹80 given across 3 orders').waitFor();
      await card.click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor(); await button('Back to Today').click(); await text('CASH').waitFor();
      await button('Settings').click(); await button('Offers').click(); await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).waitFor(); // the Settings entry is still there

      // ---- A browser in another time zone: the date inputs are India wall time, whatever the device clock says ----
      const london = await open({ width: 390, height: 844 }, 'Europe/London');
      try {
        const lp = london.page, lbutton = label => visible(lp.getByRole('button', { name: label, exact: true })), linput = label => visible(lp.getByLabel(label, { exact: true }));
        assert.equal(await lp.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), 'Europe/London');
        await lbutton('Settings').click(); await lbutton('Offers').click(); await lbutton('New offer').click(); await visible(lp.getByRole('heading', { name: 'New offer' })).waitFor();
        assert.equal(await linput('Starts (optional)').getAttribute('type'), 'datetime-local'); assert.equal(await linput('From (24-hour)').count(), 0);
        await linput('Offer name').fill('Zone check'); await linput('Discount percent').fill('10');
        await linput('Starts (optional)').fill('2027-07-01T18:00'); await linput('Ends (optional)').fill('2027-07-02T09:30'); // July: London is on BST, an hour off UTC
        assert.equal(await lbutton('Clear starts').count(), 1); await visible(lp.getByRole('switch', { name: 'Happy hour window', exact: true })).click();
        assert.equal(await linput('From (24-hour)').getAttribute('type'), 'time'); await linput('From (24-hour)').fill('22:00'); await linput('To (24-hour)').fill('02:00');
        await lbutton('Create offer').click(); await visible(lp.getByText('Offer created.', { exact: true })).waitFor();
        const zone = log.posts.at(-1);
        assert.equal(zone.starts_at, '2027-07-01T12:30:00.000Z', '18:00 India time, not 18:00 London'); assert.equal(zone.ends_at, '2027-07-02T04:00:00.000Z');
        assert.deepEqual([zone.window_from, zone.window_to], ['22:00', '02:00']);
        await visible(lp.getByRole('button', { name: /^Zone check, Scheduled/ })).click(); await visible(lp.getByRole('heading', { name: 'Edit offer' })).waitFor();
        assert.equal(await linput('Starts (optional)').inputValue(), '2027-07-01T18:00', 'the chosen wall time round-trips'); assert.equal(await linput('Ends (optional)').inputValue(), '2027-07-02T09:30');
        assert.equal(await linput('Ends (optional)').getAttribute('min'), '2027-07-01T18:00', 'Ends cannot be before Starts');
        await lbutton('Clear starts').click(); assert.equal(await linput('Starts (optional)').inputValue(), '');
      } finally { await london.context.close(); }

      // ---- Never deleted; both layouts ----
      assert.equal(log.deletes, 0, 'no DELETE was ever sent');
      await shot('list-390'); await noOverflow();
      await page.setViewportSize({ width: 1280, height: 800 });
      await noOverflow(); await shot('list-1280');
      const column = await visible(page.getByRole('heading', { name: 'Offers', level: 1 })).evaluate(el => { const box = el.closest('[style]').getBoundingClientRect(); return box.width; });
      assert.ok(column <= 1280, 'the list stays inside the page');
      await row(/^Dinner code, Scheduled/).click(); await visible(page.getByRole('heading', { name: 'Edit offer' })).waitFor();
      await input('Offer name').waitFor(); await input('Offer code').waitFor(); await targets(); await noOverflow(); await shot('form-edit-1280');
      assert.equal(await input('Offer code').inputValue(), 'DINNER50'); assert.equal(await input('Starts (optional)').inputValue(), '2026-12-01T18:00'); assert.equal(await input('From (24-hour)').inputValue(), '15:00');
      assert.equal(await visible(page.getByRole('button', { name: 'Saturday', exact: true })).getAttribute('aria-pressed'), 'false'); assert.equal(await visible(page.getByRole('button', { name: 'Friday', exact: true })).getAttribute('aria-pressed'), 'true');
      await button('Back').click();
      console.log(`PASS: ${slug} Offers (#182 B): error and empty states, percent offer with validation then valid, code offer with duplicate-code error, pause/resume/end with confirmation, locked terms on a used offer, stale version and lock race, 390px and 1280px layouts`);
    } finally { await context.close(); await admin.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }

async function eventually(check) {
  for (let index = 0; index < 240; index++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('Condition did not become true');
}
