import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn, profileFixture } from './otp-login.mjs';

// #45 customer profile, both brands: the required "What's your name?" step after sign-in (once per account, shared by both apps because it
// is stored on the server), Edit profile (validation, save, retry and error states, focus) and the verified phone shown read-only.
// Real customer exports and the installed SDK, with deterministic synthetic HTTP for GET and POST /rest/v1/profiles.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = (n, phone) => ({ id: `45000000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `u${n}@example.test`, phone, app_metadata: {}, user_metadata: { full_name: 'Stale Metadata Name' }, identities: [], created_at: '2026-01-01T00:00:00Z' });
const users = [mkUser(1, '919876543210'), mkUser(2, '919123456780'), mkUser(3, '919000011111')];
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const shots = process.env.PROFILE_SHOTS ?? 'dist/browser';
const tooLong = 'N'.repeat(121), nameMessage = 'Enter a name from 1 to 120 characters.';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

async function run(slug, brand) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], businessId = `45300000-0000-4000-8000-00000000000${brand + 1}`;
  const business = { id: businessId, slug, name: brand ? 'Kokani Dine Inn' : 'Ammu Sammu', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const item = { id: '45400000-0000-4000-8000-000000000001', name: 'Profile fixture meal', description: 'Synthetic fixture', category_id: '45500000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
  await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const data = JSON.parse(String(message)), array = Array.isArray(data);
    const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
    const changes = (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 }));
    if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) { const response = { status: 'ok', response: { postgres_changes: changes } }; socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response })); }
  }));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.fallback();
    assert.equal(url.origin, api, 'no third-party requests');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const bearer = request.headers().authorization?.replace('Bearer ', '');
    const who = bearer?.includes('.') ? JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub : null;
    if (url.pathname === '/auth/v1/token') { const input = request.postDataJSON(); return json(sessionFor(users.find(u => u.email === input.email || u.id === input.refresh_token) ?? users[0])); }
    if (url.pathname === '/auth/v1/user') return json(users.find(u => u.id === who) ?? users[0]);
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    if (url.pathname === '/rest/v1/businesses') return json(business);
    if (url.pathname === '/rest/v1/menu_items') return json([item]);
    if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
    if (url.pathname === '/rest/v1/orders') return json([]);
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (url.pathname === '/rest/v1/customer_businesses') return json([]);
    const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const profiles = profileFixture(page); profiles.mode = 'live';
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const text = value => visible(page.getByText(value, { exact: true }));
  const field = label => visible(page.getByLabel(label, { exact: true }));
  const stepTitle = () => page.getByRole('heading', { name: "Welcome! What's your name?", exact: true });
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${slug}-${name}.png`, fullPage: true }); };
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
  const signIn = async user => { await button('Account').click(); await otpSignIn(page, { email: user.email }); };
  const signOut = async () => { await button('Account').click(); await button('Log out').first().click(); await button('Account').waitFor(); };
  const openEditProfile = async () => { await button('Account').click(); await button('Account options').click(); await button('Edit profile').click(); };
  const writes = () => profiles.writes.map(write => write.body);
  try {
    // 1. First login: no name yet, so the required name step stands in front of the menu.
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await signIn(users[0]);
    await stepTitle().waitFor();
    assert.equal(await field('Full name').inputValue(), '', 'the name is empty: user_metadata is never trusted');
    await text(brand ? 'Your account also works in the Ammu Sammu app, so you won\'t need to set this up again there.' : 'Your account also works in the Kokani Dine Inn app, so you won\'t need to set this up again there.').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Welcome! What's your name?", 'focus starts on the heading');
    await shot('name-step-390');
    // Required: empty, whitespace and 121 characters are refused before any request, the error is shown and focus goes to the field.
    for (const bad of ['', '   ', tooLong]) {
      await field('Full name').fill(bad); await button('Continue').click();
      await text(nameMessage).waitFor(); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Full name');
      assert.equal(profiles.writes.length, 0, 'an invalid name sends nothing');
    }
    // Only sign out is another way out.
    assert.ok(await button('Sign out').count() > 0, 'the step can be left by signing out');
    // A failed save keeps the step, says so in plain words and focuses the message; the typed name stays.
    profiles.failWrites = 503; await field('Full name').fill('  Asha Patil  '); await button('Continue').click();
    const failure = visible(page.getByRole('alert').filter({ hasText: 'Could not reach your profile. Check your connection and try again.' })); await failure.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert');
    assert.equal(await field('Full name').inputValue(), '  Asha Patil  ', 'the typed name is kept');
    assert.equal((await page.locator('body').innerText()).includes('fixture write failure'), false, 'server text is never shown');
    profiles.failWrites = null; await button('Continue').click();
    await stepTitle().waitFor({ state: 'hidden' });
    assert.deepEqual(writes().slice(-1), [{ full_name: 'Asha Patil' }], 'saved trimmed; only the name is sent, never a user id');
    assert.equal(profiles.names[users[0].id], 'Asha Patil');
    assert.equal(profiles.writes.length, 2, 'the failed attempt and the retry only');

    // 2. Once per account: signing out and in again, in this app or in the other (same server record), does not ask again.
    await signOut(); await signIn(users[0]); await page.waitForTimeout(800);
    assert.equal(await stepTitle().count(), 0, 'a saved name is never asked for again');

    // 3. Edit profile: the saved name, the verified phone (read-only) and a Change number that is not available yet.
    await openEditProfile();
    await page.getByRole('heading', { name: 'Edit profile', exact: true }).first().waitFor().catch(() => {});
    await field('Full name').waitFor();
    assert.equal(await field('Full name').inputValue(), 'Asha Patil');
    const phone = field('Mobile number');
    assert.equal(await phone.inputValue(), '+91 98765 43210'); assert.equal(await phone.evaluate(node => node.readOnly || node.disabled), true, 'the verified phone cannot be edited here');
    await text('Verified').waitFor();
    const change = visible(page.getByRole('button', { name: 'Change number, coming soon' })); await change.waitFor();
    assert.equal(await change.getAttribute('aria-disabled'), 'true', 'Change number is shown as not available yet');
    await shot('edit-profile-390');
    // Validation first: nothing is sent, the error is shown and focus moves to the field.
    const before = profiles.writes.length;
    for (const bad of ['', '    ', tooLong]) {
      await field('Full name').fill(bad); await button('Save changes').click();
      await text(nameMessage).waitFor(); await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Full name');
    }
    assert.equal(profiles.writes.length, before);
    // A failed save: friendly copy, focus on the message, the edit stays; then a successful save.
    profiles.failWrites = 503; await field('Full name').fill('Asha P.'); await button('Save changes').click();
    await visible(page.getByRole('alert').filter({ hasText: 'Could not reach your profile.' })).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'alert');
    assert.equal(await field('Full name').inputValue(), 'Asha P.');
    profiles.failWrites = null; await button('Save changes').click(); await text('Your profile is saved.').waitFor();
    assert.deepEqual(writes().slice(-1), [{ full_name: 'Asha P.' }]); assert.equal(profiles.names[users[0].id], 'Asha P.');
    // The edit survives leaving and returning: the server record, not the device, is the source.
    await page.reload({ waitUntil: 'networkidle' }); await field('Full name').waitFor(); // /profile is a deep link the host rewrites to the app
    assert.equal(await field('Full name').inputValue(), 'Asha P.');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('own-name')).length), 0, 'no name is kept on the device');

    // 4. The profile can not be read: a plain message and Retry (the read is not guessed as "no name").
    profiles.mode = 'unavailable'; await page.goto(server.url, { waitUntil: 'networkidle' }); await openEditProfile();
    await text("We couldn't load your profile").waitFor(); assert.equal(await field('Full name').count(), 0);
    profiles.mode = 'live'; await button('Retry').click(); await field('Full name').waitFor(); assert.equal(await field('Full name').inputValue(), 'Asha P.');

    // 5. Another account on this device: never the previous name, and its own name step.
    await page.goto(server.url, { waitUntil: 'networkidle' }); await signOut(); await signIn(users[1]);
    await stepTitle().waitFor(); assert.equal(await field('Full name').inputValue(), '');
    const body = await page.locator('body').innerText();
    for (const secret of ['Asha', 'Stale Metadata Name', '98765']) assert.equal(body.includes(secret), false, `${secret} is not shown to the next account`);
    await field('Full name').fill('Meera Joshi'); await button('Continue').click(); await stepTitle().waitFor({ state: 'hidden' });
    assert.equal(profiles.names[users[1].id], 'Meera Joshi'); assert.equal(profiles.names[users[0].id], 'Asha P.', 'each account has its own record');

    // 6. A restored session (a cold start) is never interrupted by the step, and Edit profile offers the empty field to fill.
    delete profiles.names[users[1].id]; await page.goto(server.url, { waitUntil: 'networkidle' }); await page.waitForTimeout(800);
    assert.equal(await stepTitle().count(), 0, 'a restored session is not interrupted');
    await openEditProfile(); await field('Full name').waitFor(); assert.equal(await field('Full name').inputValue(), '');

    // 7. A slow profile read that finishes after sign-out never opens the step for the signed-out visitor.
    await page.goto(server.url, { waitUntil: 'networkidle' }); await signOut(); profiles.delay = 1500; await signIn(users[2]);
    await button('Sign out').click(); await button('Get code').waitFor(); await page.waitForTimeout(2200);
    assert.equal(await stepTitle().count(), 0, 'a late answer for the previous account is dropped'); profiles.delay = 0;
    assert.deepEqual(errors, []);
    console.log(`PASS: ${slug} profile name step, Edit profile, validation, errors and account isolation`);
  } catch (error) { await shot('profile-failure').catch(() => {}); throw error; }
  finally { await context.close(); await server.close(); }
}
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) await run(slug, brand);
} finally { await browser.close(); }
