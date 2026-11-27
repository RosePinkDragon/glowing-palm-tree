import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';
import { otpSignIn, profileFixture, profilesUnavailable } from './otp-login.mjs';

// #51 in-app "Delete my account", both brands: the quiet row on Edit profile, the warning sheet (what goes now, what the restaurants keep and for how
// long, active orders, can't be undone), a separate destructive confirm (Keep my account is the focused default), the blocked / offline / failed /
// session-ended cases, success (this phone is cleared and signed out, then the "being deleted" state, never "deleted"), an already-pending account,
// and the notice for a pending account's other calls. Real customer exports and the installed SDK, with deterministic synthetic HTTP.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const mkUser = (n, phone) => ({ id: `51000000-0000-4000-8000-00000000000${n}`, aud: 'authenticated', role: 'authenticated', email: `d${n}@example.test`, phone, app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' });
const users = [mkUser(1, '919876543210'), mkUser(2, '919123456780')];
const sessionFor = user => ({ access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user });
const shots = process.env.DELETE_SHOTS ?? 'dist/browser';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });

async function run(slug, brand) {
  const server = await serveWeb(`apps/${slug}-customer/dist/web`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const errors = [], businessId = `51300000-0000-4000-8000-00000000000${brand + 1}`;
  const here = brand ? 'Kokani Dine Inn' : 'Ammu Sammu', there = brand ? 'Ammu Sammu' : 'Kokani Dine Inn', otherSlug = brand ? 'ammu-sammu' : 'kokani-dine-inn';
  const business = { id: businessId, slug, name: here, delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true };
  const item = { id: '51400000-0000-4000-8000-000000000001', name: 'Delete fixture meal', description: 'Synthetic fixture', category_id: '51500000-0000-4000-8000-000000000001', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
  await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
    const data = JSON.parse(String(message)), array = Array.isArray(data);
    const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
    const changes = (payload?.config?.postgres_changes ?? []).map((change, index) => ({ ...change, id: index + 1 }));
    if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) { const response = { status: 'ok', response: { postgres_changes: changes } }; socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response })); }
  }));
  // What request_account_deletion answers: ok | active | owner | offline | session | fail | pending | slow.
  const rpc = { mode: 'ok', calls: [], delay: 0 };
  let signedOutByServer = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === '127.0.0.1') return route.fallback();
    assert.equal(url.origin, api, 'no third-party requests');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const bearer = request.headers().authorization?.replace('Bearer ', '');
    const who = bearer?.includes('.') ? JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub : null;
    if (url.pathname === '/auth/v1/token') { const input = request.postDataJSON(); return json(sessionFor(users.find(u => u.email === input.email || u.id === input.refresh_token) ?? users[0])); }
    if (url.pathname === '/auth/v1/user') return json(users.find(u => u.id === who) ?? users[0]);
    if (url.pathname === '/auth/v1/logout') { signedOutByServer++; return route.fulfill({ status: 204, body: '' }); }
    if (url.pathname === '/rest/v1/businesses') return json(business);
    if (url.pathname === '/rest/v1/menu_items') return json([item]);
    if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
    if (url.pathname === '/rest/v1/orders') return json([]);
    if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
    if (url.pathname === '/rest/v1/customer_businesses') return json([]);
    if (url.pathname === '/rest/v1/rpc/request_account_deletion') {
      rpc.calls.push({ who, body: request.postData() });
      if (rpc.delay) await new Promise(resolve => setTimeout(resolve, rpc.delay));
      const fail = (status, body) => json({ message: 'fixture', hint: null, ...body }, status);
      if (rpc.mode === 'offline') return route.abort('failed');
      if (rpc.mode === 'active') return fail(409, { code: 'PT409', details: 'ACCOUNT_HAS_ACTIVE_ORDER' });
      if (rpc.mode === 'owner') return fail(409, { code: 'PT409', details: 'ONLY_OWNER' });
      if (rpc.mode === 'session') return fail(403, { code: '42501', details: 'INVALID_SESSION' });
      if (rpc.mode === 'fail') return fail(500, { code: 'XX000', message: 'internal table detail private', details: 'private' });
      if (rpc.mode === 'pending') return fail(409, { code: 'PT409', details: 'ACCOUNT_LIFECYCLE_PENDING' });
      return json({ customer_id: who, state: 'deletion_pending', requested_at: '2026-11-27T10:00:00Z' });
    }
    const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
    throw new Error(`Unexpected request ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const profiles = profileFixture(page); profiles.mode = 'live'; profiles.names[users[0].id] = 'Asha Patil';
  const visible = locator => locator.filter({ visible: true });
  const button = name => visible(page.getByRole('button', { name, exact: true }));
  const dialog = () => page.getByRole('dialog');
  const sheetButton = name => dialog().getByRole('button', { name, exact: true });
  const text = value => visible(page.getByText(value, { exact: true }));
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `${shots}/${slug}-${name}.png`, fullPage: true }); };
  const signIn = async user => { await button('Account').click(); await otpSignIn(page, { email: user.email }); };
  const openEditProfile = async () => { await button('Account').click(); await button('Account options').click(); await button('Edit profile').click(); await visible(page.getByLabel('Full name', { exact: true })).waitFor(); };
  const entry = () => visible(page.getByRole('button', { name: 'Delete my account, removes it from both apps', exact: true }));
  const openSheet = async () => { await entry().click(); await dialog().getByRole('heading', { name: 'Delete your account?', exact: true }).waitFor(); };
  const stored = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])));
  const userKeys = /^market:(cart|checkout|own-name|preferences|leave):|auth-token/;
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
  try {
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await signIn(users[0]);
    await button('Account').waitFor();
    // This phone's saved data for the account: both restaurants' keys, the old own-name copy and the account's preferences and leave request.
    const uid = encodeURIComponent(users[0].id);
    await page.evaluate(([slugA, slugB, id]) => {
      localStorage.setItem(`market:own-name:${id}`, 'Asha Patil'); localStorage.setItem(`market:preferences:${slugA}:customer:${id}`, '{"analytics":false,"push":false}');
      localStorage.setItem(`market:leave:${slugA}:${id}`, '{"version":1}'); localStorage.setItem(`market:checkout:${slugB}`, 'x'); localStorage.setItem(`market:cart:${slugB}`, 'x');
    }, [slug, otherSlug, uid]);

    // 1. The entry: a quiet row on Edit profile, not a filled button; the drawer is unchanged.
    await openEditProfile();
    await entry().waitFor(); await text('Removes it from both apps').waitFor();
    assert.equal(await entry().evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'the entry is a plain row, de-emphasised');
    await shot('entry-390');

    // 2. The explanation. Nothing is sent by opening it; the safe choice has focus.
    await openSheet();
    await text(`This removes your account from both the ${here} and ${there} apps. It can't be undone.`).waitFor();
    for (const heading of ['Deleted right away', 'Kept for the restaurants', 'Active orders must finish first']) await dialog().getByRole('heading', { name: heading, exact: true }).waitFor();
    await text('Your name, saved addresses and notification settings. Your account stops working on every phone.').waitFor();
    await text('Your past orders stay with the restaurants, with your name, number, delivery address and map location, for up to 1 year. After that those details are removed.').waitFor();
    await text('If you have an order that is not yet delivered or cancelled, you can delete your account once it is.').waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Keep my account');
    assert.equal(rpc.calls.length, 0, 'opening the warning sends nothing');
    await shot('explanation-390');
    // Not a checkbox: two separate buttons, and Keep closes with nothing sent and focus back on the row.
    assert.equal(await dialog().getByRole('checkbox').count(), 0, 'no checkbox-only confirmation');
    await sheetButton('Keep my account').click(); await dialog().waitFor({ state: 'hidden' });
    assert.equal(rpc.calls.length, 0); await entry().waitFor();

    // 3. Blocked by an active order: its own explanation, nothing cleared, a way to the orders; the same request can be made again later.
    await stored().then(keys => assert.ok(Object.keys(keys).some(key => userKeys.test(key))));
    rpc.mode = 'active'; await openSheet(); await sheetButton('Delete my account').click();
    await dialog().getByRole('heading', { name: "Your order isn't finished yet", exact: true }).waitFor();
    await text('You can delete your account once your order is delivered or cancelled. Nothing has been deleted.').waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'View your orders'); // the unmounted confirm button's focus moves to the view's primary button
    assert.equal(rpc.calls.length, 1); assert.equal((await stored())[`market:leave:${slug}:${uid}`], '{"version":1}', 'nothing is cleared when the server refuses');
    await sheetButton('View your orders').click(); await page.waitForURL(/\/orders$/); await button('Account').waitFor();
    await openEditProfile();
    // 4. Only owner of a restaurant.
    rpc.mode = 'owner'; await openSheet(); await sheetButton('Delete my account').click();
    await dialog().getByRole('heading', { name: 'Add another owner first', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'OK'); await sheetButton('OK').click(); await dialog().waitFor({ state: 'hidden' });
    // 5. Offline, then a server failure (no server text), each with Try again that sends the same request again.
    rpc.mode = 'offline'; await openSheet(); await sheetButton('Delete my account').click();
    const alert = text("You're offline. Connect to the internet and try again. It is safe to repeat."); await alert.waitFor();
    await dialog().getByRole('heading', { name: 'Delete your account?', exact: true }).waitFor();
    rpc.mode = 'fail'; await sheetButton('Try again').click(); await text("We couldn't delete your account. Something went wrong on our side. Please try again. It is safe to repeat.").waitFor();
    assert.equal((await page.locator('body').innerText()).includes('internal table detail'), false, 'server text is never shown');
    assert.equal((await stored())[`market:leave:${slug}:${uid}`], '{"version":1}', 'a failed request clears nothing');
    await sheetButton('Keep my account').click(); await dialog().waitFor({ state: 'hidden' });
    // 6. The session ended: sign in again (nothing was deleted), then the same flow works.
    rpc.mode = 'session'; await openSheet(); await sheetButton('Delete my account').click();
    await dialog().getByRole('heading', { name: 'Sign in again', exact: true }).waitFor(); await text('Your sign-in has ended. Sign in again, then delete your account. Nothing has been deleted.').waitFor();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Sign in');
    await sheetButton('Sign in').click(); await button('Get code').waitFor();
    await otpSignIn(page, { email: users[0].email }); await visible(page.getByLabel('Full name', { exact: true })).waitFor();

    // 7. Success: busy state while the server works, then this phone is cleared and signed out and the final state appears.
    rpc.mode = 'slow'; rpc.delay = 900; rpc.calls.length = 0;
    await openSheet(); await sheetButton('Delete my account').click();
    await sheetButton('Deleting…').waitFor(); assert.equal(await sheetButton('Deleting…').isDisabled(), true, 'one request at a time');
    await shot('confirm-390');
    const title = page.getByRole('heading', { name: 'Your account is being deleted', exact: true }); await title.waitFor();
    assert.equal(rpc.calls.length, 1, 'one request'); assert.equal(rpc.calls[0].who, users[0].id); assert.ok(!rpc.calls[0].body || rpc.calls[0].body === '{}', 'no account id is sent');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Your account is being deleted');
    const body = await page.locator('body').innerText();
    assert.ok(body.includes("We've closed your account and removed your name, saved addresses and notification settings."));
    assert.equal(/has been deleted|is deleted|fully deleted|permanently deleted/i.test(body), false, 'never claims the deletion is finished');
    await page.waitForTimeout(1200); const after = await stored();
    // The signed-out app keeps an anonymous, empty cart record for this restaurant (no owner, no lines): that is not the account's data.
    const anonymous = JSON.parse(after[`market:cart:${slug}`] ?? 'null'); assert.ok(anonymous === null || (anonymous.ownerId === null && anonymous.lines.length === 0), 'only an empty, ownerless cart may remain');
    assert.deepEqual(Object.keys(after).filter(key => userKeys.test(key) && key !== `market:cart:${slug}`), [], 'this phone no longer holds the account\'s cart, attempt, name, preferences, leave request or sign-in');
    await shot('final-390');
    await button('Back to menu').click(); await title.waitFor({ state: 'hidden' });
    await button('Account').click(); await button('Get code').waitFor(); // signed out: the sign-in card, not the account drawer
    // 7b. The session changes while the request is in flight (a sign-out in another tab): the server account is pending all the same, so this
    // phone is still cleaned and the notice still shows.
    await otpSignIn(page, { email: users[0].email }); await button('Account').waitFor();
    await openEditProfile(); await page.evaluate(([id, slugA]) => localStorage.setItem(`market:leave:${slugA}:${id}`, '{"version":1}'), [uid, slug]);
    rpc.mode = 'slow'; rpc.delay = 2500; rpc.calls.length = 0;
    await openSheet(); await sheetButton('Delete my account').click(); await sheetButton('Deleting…').waitFor();
    const other = await context.newPage(); await other.route(url => url.pathname === '/rest/v1/profiles', profilesUnavailable);
    await other.goto(server.url, { waitUntil: 'networkidle' });
    await other.getByRole('button', { name: 'Account', exact: true }).filter({ visible: true }).click();
    await other.getByRole('button', { name: 'Log out', exact: true }).filter({ visible: true }).first().click();
    await other.getByRole('button', { name: 'Account', exact: true }).filter({ visible: true }).waitFor(); await other.close();
    await title.waitFor(); assert.equal(rpc.calls.length, 1);
    assert.equal((await stored())[`market:leave:${slug}:${uid}`], undefined, 'the phone is cleaned although the session changed during the request');
    rpc.delay = 0; await button('Back to menu').click(); await title.waitFor({ state: 'hidden' });
    await button('Account').click(); await button('Get code').waitFor();

    // 8. Signed in again to the account that is still waiting for its login to be removed: asking again carries on to the same final state.
    await otpSignIn(page, { email: users[0].email }); await button('Account').waitFor();
    rpc.mode = 'pending'; rpc.delay = 0; await openEditProfile(); await openSheet(); await sheetButton('Delete my account').click();
    await title.waitFor(); await button('Back to menu').click();

    // 8b. Deleting never depends on the profile: with the profile unavailable the row is still there and the flow completes.
    profiles.mode = 'unavailable'; rpc.mode = 'ok'; rpc.calls.length = 0;
    await signIn(users[0]); await button('Account').waitFor();
    await button('Account').click(); await button('Account options').click(); await button('Edit profile').click();
    await text("We couldn't load your profile").waitFor(); await entry().waitFor();
    await openSheet(); await sheetButton('Delete my account').click();
    await title.waitFor(); assert.equal(rpc.calls.length, 1); await button('Back to menu').click();
    profiles.mode = 'live';

    // 8c. A demo restaurant never offers deletion (it has no real account to delete).
    await signIn(users[0]); business.is_demo = true; await page.goto(server.url, { waitUntil: 'networkidle' });
    await openEditProfile(); await button('Done').waitFor(); assert.equal(await entry().count(), 0, 'no Delete row for a demo restaurant');
    business.is_demo = false; await page.goto(server.url, { waitUntil: 'networkidle' }); await button('Account').click(); await button('Log out').first().click(); await button('Account').waitFor();

    // 9. A pending account's other calls say so instead of a generic failure: saving the name on a sign-in that has none.
    await page.route(url => url.pathname === '/rest/v1/profiles', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'PT409', message: 'account lifecycle pending', details: 'ACCOUNT_LIFECYCLE_PENDING', hint: null }) }) : route.fallback());
    await signIn(users[1]);
    await visible(page.getByRole('heading', { name: "Welcome! What's your name?", exact: true })).waitFor();
    await visible(page.getByLabel('Full name', { exact: true })).fill('New Name'); await button('Continue').click();
    await visible(page.getByRole('alert').filter({ hasText: 'This account is being deleted, so it can no longer be changed.' })).waitFor();
    assert.equal((await page.locator('body').innerText()).includes('Could not reach your profile'), false, 'not the generic failure');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${slug} delete account entry, warning, blocked, offline, failed, session-ended, success clean-up, final state, pending`);
  } catch (error) { await shot('delete-failure').catch(() => {}); throw error; }
  finally { await context.close(); await server.close(); }
}
try {
  for (const [brand, slug] of ['ammu-sammu', 'kokani-dine-inn'].entries()) await run(slug, brand);
} finally { await browser.close(); }
