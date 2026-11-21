import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';
import { offerRpcMock } from './offer-mocks.mjs';

// #50-B customer phone and code screens, both brands, against the real exports and the installed Supabase SDK.
// GoTrue (/auth/v1/otp, /auth/v1/verify) is mocked; no Turnstile site key is set in this build, so CAPTCHA is skipped.
const api = 'https://market-fixture.supabase.co';
const userId = '50b00000-0000-4000-8000-000000000001';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const user = { id: userId, aud: 'authenticated', role: 'authenticated', phone: '919876543210', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-11-19T00:00:00Z' };
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: userId, aud: 'authenticated', role: 'authenticated', session_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: 'otp-fixture', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const shots = process.env.OTP_SHOTS ?? 'dist/browser';
const brands = { 'ammu-sammu': 'Ammu Sammu', 'kokani-dine-inn': 'Kokani Dine Inn' };
const businessIds = { 'ammu-sammu': '50c00000-0000-4000-8000-000000000001', 'kokani-dine-inn': '50c00000-0000-4000-8000-000000000002' };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const gotrue = (status, error_code, msg) => ({ status, body: { code: status, error_code, msg } });
const errors = [];
try {
  for (const slug of Object.keys(brands)) {
    const server = await serveWeb(`apps/${slug}-customer/dist/web`);
    const run = async (name, work, viewport = { width: 390, height: 844 }) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const fixture = { otp: [], verify: [], otpReply: null, verifyReply: null, logouts: 0, external: [], authed: false };
      await context.routeWebSocket(/.*/, socket => socket.onMessage(message => {
        const data = JSON.parse(String(message)), array = Array.isArray(data);
        const [join, ref, topic, event, payload] = array ? data : [data.join_ref, data.ref, data.topic, data.event, data.payload];
        if (['phx_join', 'heartbeat', 'phx_leave'].includes(event)) { const response = { status: 'ok', response: { postgres_changes: (payload?.config?.postgres_changes ?? []).map((v, i) => ({ ...v, id: i + 1 })) } }; socket.send(JSON.stringify(array ? [join, ref, topic, 'phx_reply', response] : { join_ref: join, ref, topic, event: 'phx_reply', payload: response })); }
      }));
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname === '127.0.0.1') return route.fallback();
        if (url.origin !== api) { fixture.external.push(url.href); return route.abort(); }
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        const offerMock = offerRpcMock(url, json); if (offerMock) return offerMock;
        const reply = r => r ? json(r.body, r.status) : json({});
        const item = { id: '50d00000-0000-4000-8000-000000000001', name: 'OTP fixture meal', description: 'Synthetic', category_id: '50d00000-0000-4000-8000-000000000002', menu_categories: { name: 'Meals', sort_order: 0 }, price_paise: 10000, available: true, is_demo: false, is_featured: false, sort_order: 0, image_url: null };
        if (url.pathname === '/auth/v1/otp') { fixture.otp.push(request.postDataJSON()); return reply(fixture.otpReply); }
        if (url.pathname === '/auth/v1/verify') { fixture.verify.push(request.postDataJSON()); if (fixture.verifyReply) return reply(fixture.verifyReply); fixture.authed = true; return json(session); }
        if (url.pathname === '/auth/v1/user') return fixture.authed ? json(user) : json({ code: 401, error_code: 'no_authorization', msg: 'no session' }, 401);
        if (url.pathname === '/auth/v1/logout') { fixture.logouts++; return route.fulfill({ status: 204 }); }
        if (url.pathname === '/rest/v1/businesses') return json({ id: businessIds[slug], slug, name: brands[slug], delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
        if (url.pathname === '/rest/v1/menu_items') return json([item]);
        if (url.pathname === '/rest/v1/menu_categories') return json([{ id: item.category_id, name: 'Meals', sort_order: 0 }]);
        if (url.pathname === '/rest/v1/customer_businesses') return json([]);
        if (url.pathname === '/rest/v1/orders') return json([]);
        if (url.pathname === '/rest/v1/rpc/customer_notification_unread_count') return json(0);
        if (url.pathname.startsWith('/rest/v1/rpc/')) return json([]);
        return json({ code: 'XX000', message: 'unexpected fixture request ' + url.pathname }, 500);
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(`${slug} ${name}: ${error.message}`));
      const f = {
        phone: page.getByLabel('Mobile number', { exact: true }), code: page.getByLabel('6-digit code', { exact: true }),
        get: page.getByRole('button', { name: /^Get code/ }), verify: page.getByRole('button', { name: 'Verify and continue', exact: true }),
        alert: page.getByRole('alert').filter({ hasText: /\S/ }),
      };
      try { await work({ page, context, fixture, f, shot: file => page.screenshot({ path: `${shots}/${slug}-otp-${file}.png` }) }); }
      finally { assert.deepEqual(fixture.external, [], `${slug} ${name}: no third-party requests (CAPTCHA is skipped without a site key)`); await context.close(); }
      console.log(`PASS: ${slug} ${name}`);
    };
    const toCode = async ({ page, f, fixture }, phone = '98765 43210') => { await page.goto(server.url + '/login', { waitUntil: 'networkidle' }); await f.phone.fill(phone); await f.get.click(); await f.code.waitFor(); };

    await run('phone entry, validation and no CAPTCHA widget', async ({ page, f, fixture, shot }) => {
      await page.goto(server.url + '/login', { waitUntil: 'networkidle' });
      await page.getByText('Log in or sign up', { exact: true }).waitFor();
      await page.getByText('We\'ll send a one-time code to this number on WhatsApp.', { exact: true }).waitFor();
      await page.getByText('+91', { exact: true }).waitFor();
      assert.equal(await page.locator('iframe, script[src*="turnstile"]').count(), 0, 'no CAPTCHA widget without a site key');
      assert.equal(await f.phone.getAttribute('inputmode'), 'tel');
      assert.equal(await page.getByLabel('Email').count(), 0, 'customers have no email or password form');
      await f.get.click(); await page.getByText('Enter your 10-digit mobile number.', { exact: true }).waitFor();
      await f.phone.fill('12345'); await f.get.click(); await page.getByText(/valid 10-digit mobile number/).waitFor();
      assert.equal(fixture.otp.length, 0, 'an invalid number never reaches the server');
      await f.phone.fill('+91 98765 43210'); assert.equal(await f.phone.inputValue(), '9876543210', 'pasted +91 numbers are trimmed to ten digits');
      // #50-C: the design's notice under the phone field, with working links to the existing /terms and /privacy pages.
      const notice = await page.getByText('By continuing you agree to', { exact: true }).locator('xpath=..').innerText();
      assert.equal(notice.replace(/\s+/g, ' ').trim(), 'By continuing you agree to Terms and Privacy policy');
      for (const [name, path] of [['Terms', '/terms'], ['Privacy policy', '/privacy']]) {
        const link = page.getByRole('link', { name, exact: true }); assert.equal(await link.count(), 1, `${name} is a link`);
        await link.focus(); assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), name, `${name} is focusable`);
        assert.ok((await link.boundingBox()).height >= 44, `${name} target is at least 44px tall`);
        await link.press('Enter'); await page.waitForFunction(p => location.pathname === p, path);
        await page.getByText(name === 'Terms' ? 'Draft terms' : 'Draft privacy policy', { exact: true }).first().waitFor();
        await page.goBack(); await f.phone.waitFor();
      }
      await shot('1-phone-390');
      const box = await f.get.boundingBox(); assert.ok(box.height >= 44, 'Get code target is at least 44px');
    });

    await run('request code, code entry, wrong then right code signs in', async ({ page, f, fixture, shot }) => {
      await toCode({ page, f, fixture });
      assert.equal(fixture.otp.length, 1); assert.equal(fixture.otp[0].phone, '+919876543210'); assert.notEqual(fixture.otp[0].create_user, false, 'new numbers are created implicitly');
      await page.getByText('+91 98765 43210', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '6-digit code', 'focus moves to the code field');
      assert.equal(await f.code.getAttribute('autocomplete'), 'one-time-code'); assert.equal(await f.code.getAttribute('inputmode'), 'numeric');
      await f.code.fill('482 916'); assert.equal(await f.code.inputValue(), '482916', 'pasted codes lose spaces');
      assert.match(await page.getByText(/You can resend in/).innerText(), /You can resend in 0:(?:30|29|28)/);
      assert.equal(await page.getByRole('button', { name: 'Send a new code' }).count(), 0, 'no resend during the cooldown');
      for (const name of ['Change number, currently +91 98765 43210', 'Verify and continue']) { const box = await page.getByRole('button', { name }).boundingBox(); assert.ok(box.height >= 44, `${name} is at least 44px tall`); }
      await shot('2-code-390');
      fixture.verifyReply = gotrue(403, 'otp_expired', 'Token has expired or is invalid');
      await f.verify.click();
      await f.alert.getByText(/That code didn't match, or it has expired/).waitFor();
      assert.equal(await f.code.inputValue(), '', 'the wrong code is cleared');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '6-digit code', 'focus returns to the code field');
      await shot('3-wrong-code-390');
      assert.deepEqual(fixture.verify.at(-1), { ...fixture.verify.at(-1), phone: '+919876543210', token: '482916', type: 'sms' });
      fixture.verifyReply = null; await f.code.fill('123456'); await f.code.press('Enter');
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/account', 'signing in lands on the requested page');
      await page.getByText('+91 98765 43210', { exact: true }).waitFor(); // the account card shows the formatted phone when there is no email
    });

    await run('invalid-token wording and expiry share one clear error', async ({ page, f, fixture }) => {
      await toCode({ page, f, fixture });
      fixture.verifyReply = gotrue(400, 'validation_failed', 'Invalid token'); await f.code.fill('000000'); await f.verify.click();
      await f.alert.getByText(/didn't match, or it has expired/).waitFor();
      fixture.verifyReply = gotrue(500, 'unexpected_failure', 'boom'); await f.code.fill('000001'); await f.verify.click();
      await f.alert.getByText('Something went wrong. Please try again.').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 0, 'never signed in');
    });

    await run('resend cooldown counts down, then offers a new code', async ({ page, f, fixture, shot }) => {
      await page.clock.install({ time: Date.now() });
      await toCode({ page, f, fixture });
      await page.clock.fastForward(12_000); await page.getByText(/You can resend in 0:(?:1[6-9]|2[0-1])/).waitFor();
      await shot('4-cooldown-390');
      await page.clock.fastForward(20_000);
      const resend = page.getByRole('button', { name: 'Send a new code', exact: true }); await resend.waitFor();
      const box = await resend.boundingBox(); assert.ok(box.height >= 44, 'resend target is at least 44px');
      assert.ok((await page.getByRole('status').allInnerTexts()).some(text => /You can send a new code now/.test(text)), 'the end of the cooldown is announced');
      await resend.click(); await page.getByText(/You can resend in 0:/).waitFor();
      assert.equal(fixture.otp.length, 2, 'a resend asks for another code');
    });

    await run('change number returns to phone entry; other numbers are not on cooldown', async ({ page, f, fixture }) => {
      await toCode({ page, f, fixture });
      await page.getByRole('button', { name: /^Change number/ }).click();
      assert.equal(await f.phone.inputValue(), '9876543210', 'the typed number is kept for editing');
      await page.getByRole('button', { name: /^Get code in 0:/ }).waitFor();
      await f.phone.fill('9123456780'); await f.get.click(); await f.code.waitFor();
      assert.equal(fixture.otp.at(-1).phone, '+919123456780');
    });

    await run('Enter respects the cooldown (no extra request)', async ({ page, f, fixture }) => {
      await toCode({ page, f, fixture });
      await page.getByRole('button', { name: /^Change number/ }).click();
      await page.getByRole('button', { name: /^Get code in 0:/ }).waitFor();
      await f.phone.press('Enter'); await f.phone.press('Enter'); await page.waitForTimeout(300);
      assert.equal(fixture.otp.length, 1, 'Enter during the cooldown sends nothing');
      assert.equal(await f.code.count(), 0, 'and stays on the number screen');
    });

    await run('a cooldown on the first request lands on the code screen and can verify', async ({ page, f, fixture }) => {
      fixture.otpReply = gotrue(429, 'over_sms_send_rate_limit', 'For security purposes, you can only request this after 20 seconds.');
      await page.goto(server.url + '/login', { waitUntil: 'networkidle' });
      await f.phone.fill('9876543210'); await f.get.click(); await f.code.waitFor();
      await page.getByText('+91 98765 43210', { exact: true }).waitFor();
      await f.alert.getByText(/Please wait a moment before asking for another code/).waitFor();
      await page.getByText(/You can resend in 0:(?:1\d|20)/).waitFor();
      await f.code.fill('123456'); await f.verify.click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    });

    for (const [name, reply, expected] of [
      ['NOT_ON_WHATSAPP', gotrue(422, 'hook_failure', 'NOT_ON_WHATSAPP'), 'We couldn\'t deliver the code on WhatsApp. Check the number.'],
      ['RATE_LIMITED', gotrue(429, 'over_sms_send_rate_limit', 'SMS rate limit exceeded'), 'Too many attempts. Please wait a few minutes and try again.'],
      ['GENERIC', gotrue(500, 'unexpected_failure', 'boom'), 'Something went wrong. Please try again.'],
    ]) await run(`request error ${name}`, async ({ page, f, fixture, shot }) => {
      fixture.otpReply = reply;
      await page.goto(server.url + '/login', { waitUntil: 'networkidle' });
      await f.phone.fill('9876543210'); await f.get.click();
      await f.alert.getByText(expected, { exact: true }).waitFor();
      assert.equal(await f.code.count(), 0, 'stays on the number screen when no code was sent');
      assert.equal(await f.get.isEnabled(), true, 'the number can be corrected and retried');
      if (name === 'NOT_ON_WHATSAPP') await shot('5-not-on-whatsapp-390');
    });

    await run('server-stated wait (RESEND_COOLDOWN) shows the countdown and Change number keeps Get code disabled for that number', async ({ page, f, fixture }) => {
      fixture.otpReply = gotrue(429, 'over_sms_send_rate_limit', 'For security purposes, you can only request this after 45 seconds.');
      await page.goto(server.url + '/login', { waitUntil: 'networkidle' });
      await f.phone.fill('9876543210'); await f.get.click(); await f.code.waitFor();
      await page.getByText(/You can resend in 0:4/).waitFor();
      await page.getByRole('button', { name: /^Change number/ }).click();
      assert.equal(await page.getByRole('button', { name: /^Get code in 0:4/ }).isDisabled(), true);
      assert.equal(await f.alert.count(), 0, 'changing the number clears the error');
    });

    await run('protected routes redirect to the phone screen and return after sign-in', async ({ page, f, fixture }) => {
      await page.goto(server.url + '/orders', { waitUntil: 'networkidle' });
      await f.phone.waitFor(); assert.equal(new URL(page.url()).pathname, '/login');
      await f.phone.fill('9876543210'); await f.phone.press('Enter'); await f.code.waitFor();
      await f.code.fill('123456'); await f.verify.click();
      await page.waitForFunction(() => location.pathname === '/orders'); assert.equal(fixture.verify.length, 1);
    });

    await run('desktop layout', async ({ page, f, fixture, shot }) => {
      await page.goto(server.url + '/login', { waitUntil: 'networkidle' }); await f.phone.fill('9876543210');
      await shot('1-phone-1280'); fixture.verifyReply = gotrue(403, 'otp_expired', 'Token has expired or is invalid');
      await f.get.click(); await f.code.fill('111111'); await shot('2-code-1280'); await f.verify.click(); await f.alert.waitFor(); await shot('3-wrong-code-1280'); await page.getByRole('button', { name: /^Change number/ }).click(); await f.phone.fill('9123456780'); await f.get.click(); await f.code.waitFor(); await shot('4-cooldown-1280');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
    }, { width: 1280, height: 800 });
    await server.close?.();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: otp50 customer phone and code screens, both brands');
} finally { await browser.close(); }
