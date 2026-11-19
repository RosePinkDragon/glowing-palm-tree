import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #50-C owners' phone and code screens, both brands' admin apps, against the real exports and the installed Supabase SDK.
// The request-owner-code function, GoTrue (/auth/v1/verify) and the membership check are mocked; no Turnstile site key is set, so CAPTCHA is skipped.
const api = 'https://market-fixture.supabase.co';
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const ownerPhone = '+919876543210', strangerPhone = '+919123456780';
const people = {
  [ownerPhone]: { id: '50e00000-0000-4000-8000-000000000001', phone: '919876543210' },
  [strangerPhone]: { id: '50e00000-0000-4000-8000-000000000002', phone: '919123456780' },
};
const sessionFor = person => { const user = { ...person, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-11-19T00:00:00Z' };
  return { access_token: `${part({ alg: 'HS256' })}.${part({ sub: person.id, aud: 'authenticated', role: 'authenticated', session_id: person.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: `otp-${person.id}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user }; };
const shots = process.env.OTP_SHOTS ?? 'dist/browser';
const brands = { 'ammu-sammu': 'Ammu Sammu', 'kokani-dine-inn': 'Kokani Dine Inn' };
const businessIds = { 'ammu-sammu': '50f00000-0000-4000-8000-000000000001', 'kokani-dine-inn': '50f00000-0000-4000-8000-000000000002' };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
await mkdir(shots, { recursive: true });
const gotrue = (status, error_code, msg) => ({ status, body: { code: status, error_code, msg } });
const errors = [];
const neutral = phone => `If this number belongs to a restaurant owner, we've sent a code on WhatsApp to ${phone}.`;
try {
  for (const slug of Object.keys(brands)) {
    const server = await serveWeb(`apps/${slug}-admin/dist/web`);
    const run = async (name, work, viewport = { width: 390, height: 844 }) => {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const fixture = { requests: [], verify: [], requestReply: null, verifyReply: null, logouts: 0, external: [], who: null };
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
        const reply = r => r ? json(r.body, r.status) : json({});
        const caller = () => { const bearer = (request.headers().authorization ?? '').replace(/^Bearer /, ''); try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub; } catch { return null; } };
        if (url.pathname === '/functions/v1/request-owner-code') { fixture.requests.push(request.postDataJSON()); return fixture.requestReply ? reply(fixture.requestReply) : json({ ok: true }); }
        if (url.pathname === '/auth/v1/otp') { fixture.external.push('customer OTP endpoint called from the owners app'); return json({}); }
        if (url.pathname === '/auth/v1/verify') { const body = request.postDataJSON(); fixture.verify.push(body); if (fixture.verifyReply) return reply(fixture.verifyReply); fixture.who = people[body.phone] ?? people[strangerPhone]; return json(sessionFor(fixture.who)); }
        if (url.pathname === '/auth/v1/user') { const id = caller(); const person = Object.values(people).find(p => p.id === id); return person ? json({ ...person, aud: 'authenticated', role: 'authenticated' }) : json({ code: 401, error_code: 'no_authorization', msg: 'no session' }, 401); }
        if (url.pathname === '/auth/v1/logout') { fixture.logouts++; return route.fulfill({ status: 204 }); }
        if (url.pathname === '/rest/v1/businesses') return json({ id: businessIds[slug], slug, name: brands[slug], delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
        if (url.pathname === '/rest/v1/business_memberships') return json(caller() === people[ownerPhone].id ? { role: 'admin' } : null);
        if (url.pathname === '/rest/v1/menu_items' || url.pathname === '/rest/v1/menu_categories' || url.pathname === '/rest/v1/orders') return json([]);
        if (url.pathname.startsWith('/rest/v1/rpc/')) return json([]);
        return json({ code: 'XX000', message: 'unexpected fixture request ' + url.pathname }, 500);
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(`${slug} ${name}: ${error.message}`));
      const f = {
        phone: page.getByLabel('Mobile number', { exact: true }), code: page.getByLabel('6-digit code', { exact: true }),
        get: page.getByRole('button', { name: /^Get code/ }), verify: page.getByRole('button', { name: 'Verify and continue', exact: true }),
        alert: page.getByRole('alert').filter({ hasText: /\S/ }),
      };
      try { await work({ page, context, fixture, f, shot: file => page.screenshot({ path: `${shots}/${slug}-owner-otp-${file}.png` }) }); }
      finally { assert.deepEqual(fixture.external, [], `${slug} ${name}: no third-party requests, and the owners' app never calls the customer OTP endpoint`); await context.close(); }
      console.log(`PASS: ${slug} owners ${name}`);
    };
    const toCode = async ({ page, f }, phone = '98765 43210') => { await page.goto(server.url, { waitUntil: 'networkidle' }); await f.phone.fill(phone); await f.get.click(); await f.code.waitFor(); };
    const cardText = async page => (await page.getByText('Enter the code', { exact: true }).locator('xpath=ancestor::*[self::div][3]').innerText()).replace(/\+91 \d{5} \d{5}/g, '+91 XXXXX XXXXX');

    await run('phone screen: WhatsApp number, no email or password, plain-text terms line', async ({ page, f, fixture, shot }) => {
      await page.goto(server.url, { waitUntil: 'networkidle' });
      await page.getByText('Sign in', { exact: true }).first().waitFor();
      await page.getByText('Enter the WhatsApp number of your owner account. We\'ll send a one-time code to it.', { exact: true }).waitFor();
      await f.phone.waitFor(); assert.equal(await f.phone.getAttribute('inputmode'), 'tel');
      for (const label of ['Email', 'Password']) assert.equal(await page.getByLabel(label).count(), 0, `no ${label} field`);
      assert.equal(await page.getByRole('button', { name: /Create an account|Forgot password/ }).count(), 0, 'no email sign-up or reset');
      assert.equal(await page.getByText('New here?', { exact: false }).count(), 0, 'owners do not create accounts here');
      const line = await page.getByText('By continuing you agree to', { exact: true }).locator('xpath=..').innerText();
      assert.equal(line.replace(/\s+/g, ' ').trim(), 'By continuing you agree to Terms and Privacy policy');
      assert.equal(await page.getByRole('link', { name: /^(Terms|Privacy policy)$/ }).count(), 0, 'the owners\' apps have no terms or privacy pages, so no dead links');
      assert.equal(await page.locator('iframe, script[src*="turnstile"]').count(), 0, 'no CAPTCHA widget without a site key');
      await f.get.click(); await page.getByText('Enter your 10-digit mobile number.', { exact: true }).waitFor();
      await f.phone.fill('12345'); await f.get.click(); await page.getByText(/valid 10-digit mobile number/).waitFor();
      assert.equal(fixture.requests.length, 0, 'an invalid number never reaches the server');
      await f.phone.fill('9876543210'); await shot('1-phone-390');
    });

    await run('owner and non-owner numbers get identical, neutral code screens', async ({ page, f, fixture, shot }) => {
      await toCode({ page, f }, '98765 43210'); await shot('2-code-390');
      assert.deepEqual(fixture.requests, [{ phone: ownerPhone, slug }], 'the owner request goes to request-owner-code with the restaurant slug');
      assert.equal(fixture.verify.length, 0);
      await page.getByText(neutral('+91 98765 43210'), { exact: true }).waitFor();
      const owner = await cardText(page);
      await page.getByRole('button', { name: /^Change number/ }).click(); await f.phone.fill('9123456780');
      assert.equal(await f.get.isDisabled(), false, 'a different number is not held by the first number\'s cooldown');
      await f.get.click(); await f.code.waitFor();
      await page.getByText(neutral('+91 91234 56780'), { exact: true }).waitFor();
      assert.equal(await cardText(page), owner, 'the screen for a number that is not an owner is identical to the owner\'s');
      assert.equal(fixture.requests.at(-1).phone, strangerPhone);
      assert.equal(await page.getByText(/couldn't deliver the code on WhatsApp/).count(), 0, 'never says a number is not on WhatsApp');
      assert.equal(await page.getByRole('alert').filter({ hasText: /\S/ }).count(), 0, 'no error after requesting');
      assert.equal(await f.code.getAttribute('autocomplete'), 'one-time-code');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '6-digit code', 'focus moves to the code field');
    });

    await run('wrong code, and a non-owner\'s correct code, both fail identically', async ({ page, f, fixture, shot }) => {
      await toCode({ page, f });
      fixture.verifyReply = gotrue(403, 'otp_expired', 'Token has expired or is invalid');
      await f.code.fill('482 916'); assert.equal(await f.code.inputValue(), '482916'); await f.verify.click();
      const wrong = "That code didn't match, or it has expired. Check the latest WhatsApp message, or send a new code.";
      await f.alert.getByText(wrong, { exact: true }).waitFor(); await shot('3-wrong-code-390');
      assert.equal(await f.code.inputValue(), '', 'the wrong code is cleared');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '6-digit code', 'focus returns to the code field');
      assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0, 'never signed in');
      // A valid code for a number that is not an owner here: the code check passes but membership fails, and the screen says the same thing.
      fixture.verifyReply = null; await page.getByRole('button', { name: /^Change number/ }).click(); await f.phone.fill('9123456780'); await f.get.click(); await f.code.waitFor();
      await f.code.fill('123456'); await f.verify.click();
      await f.alert.getByText(wrong, { exact: true }).waitFor();
      assert.equal(fixture.verify.at(-1).phone, strangerPhone); assert.ok(fixture.logouts >= 1, 'the non-owner\'s throwaway session is revoked');
      assert.equal(await page.getByRole('navigation', { name: 'Owner sections' }).count(), 0, 'no owner tabs');
      assert.equal(await page.getByRole('button', { name: 'Sign out', exact: true }).count(), 0, 'a non-owner is never signed in to the owners\' app');
    });

    await run('30 s resend cooldown is enforced by the screen', async ({ page, f, fixture, shot }) => {
      await page.clock.install({ time: Date.now() });
      await toCode({ page, f });
      assert.equal(fixture.requests.length, 1);
      assert.match(await page.getByText(/You can resend in/).innerText(), /You can resend in 0:(?:30|29|28)/);
      assert.equal(await page.getByRole('button', { name: 'Send a new code' }).count(), 0, 'no resend button during the cooldown');
      await page.clock.fastForward(12_000); await page.getByText(/You can resend in 0:(?:1[6-9]|2[0-1])/).waitFor(); await shot('4-cooldown-390');
      assert.equal(fixture.requests.length, 1, 'nothing is sent while the cooldown runs');
      await page.getByRole('button', { name: /^Change number/ }).click();
      await page.getByRole('button', { name: /^Get code in 0:/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Get code in/ }).isDisabled(), true, 'the same number cannot be requested again early from the phone screen either');
      await f.phone.press('Enter'); assert.equal(fixture.requests.length, 1, 'Enter cannot bypass the cooldown');
      assert.equal(fixture.requests.length, 1);
      await page.clock.fastForward(20_000);
      await f.get.click(); await f.code.waitFor(); assert.equal(fixture.requests.length, 2, 'a new request is allowed after 30 s');
      await page.clock.fastForward(31_000);
      const resend = page.getByRole('button', { name: 'Send a new code', exact: true }); await resend.waitFor();
      assert.ok((await page.getByRole('status').allInnerTexts()).some(text => /You can send a new code now/.test(text)), 'the end of the cooldown is announced');
      await resend.click(); await page.getByText(/You can resend in 0:/).waitFor();
      assert.equal(fixture.requests.length, 3); assert.equal(await page.getByText(neutral('+91 98765 43210'), { exact: true }).count(), 1, 'the resend keeps the same neutral copy');
    });

    await run('request errors stay generic and never reveal owner status', async ({ page, f, fixture }) => {
      fixture.requestReply = { status: 500, body: { ok: false } };
      await page.goto(server.url, { waitUntil: 'networkidle' }); await f.phone.fill('9876543210'); await f.get.click();
      await f.alert.getByText('Something went wrong. Please try again.', { exact: true }).waitFor();
      assert.equal(await f.code.count(), 0, 'stays on the number screen when no code could be requested');
      fixture.requestReply = { status: 429, body: { ok: false } }; await f.get.click();
      await f.alert.getByText('Too many attempts. Please wait a few minutes and try again.', { exact: true }).waitFor();
      fixture.requestReply = { status: 422, body: { ok: false, error: 'NOT_ON_WHATSAPP' } }; await f.get.click();
      await f.alert.getByText('Something went wrong. Please try again.', { exact: true }).waitFor();
      assert.equal(await page.getByText(/couldn't deliver the code on WhatsApp/).count(), 0, 'NOT_ON_WHATSAPP is never shown to owners');
    });

    await run('a correct code lands in the owners\' area', async ({ page, f, fixture }) => {
      await toCode({ page, f });
      await f.code.fill('123456'); await f.code.press('Enter');
      const tabs = page.getByRole('navigation', { name: 'Owner sections' }); await tabs.waitFor();
      assert.deepEqual(fixture.verify.at(-1), { ...fixture.verify.at(-1), phone: ownerPhone, token: '123456', type: 'sms' });
      assert.equal(await page.getByRole('button', { name: 'Get code' }).count(), 0, 'the sign-in screen is gone');
      await page.reload({ waitUntil: 'networkidle' }); await tabs.waitFor();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByText('+91 98765 43210', { exact: true }).first().waitFor(); // a phone-only owner is shown by formatted number, not a raw +91 string
      await page.getByRole('button', { name: 'Log out', exact: true }).click();
      await page.getByRole('button', { name: 'Get code', exact: true }).waitFor();
      assert.equal(await f.phone.inputValue(), '', 'the number is not kept after logging out');
    });

    await run('desktop layout', async ({ page, f, fixture, shot }) => {
      await page.goto(server.url, { waitUntil: 'networkidle' }); await f.phone.fill('9876543210');
      await shot('1-phone-1280'); await f.get.click(); await f.code.fill('111111'); await shot('2-code-1280');
      fixture.verifyReply = gotrue(403, 'otp_expired', 'Token has expired or is invalid'); await f.verify.click(); await f.alert.waitFor(); await shot('3-wrong-code-1280');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
    }, { width: 1280, height: 800 });
    await server.close?.();
  }
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: owner-otp50 owners\' phone and code screens, both brands');
} finally { await browser.close(); }
