// Shared customer sign-in for the browser fixtures (#50-B): drives the real phone and code screens.
// The fixtures' GoTrue mocks still answer /auth/v1/token with the fixture session, so the helper maps the new
// /auth/v1/otp and /auth/v1/verify calls onto that handler (route.fallback with a rewritten request).
const installed = new WeakSet();

// Customer profile (#45) fixture. Journeys that are not about profiles leave `mode` as 'unavailable': the read answers 503, the app then
// shows no name step and prefills no name, so their other assertions are unaffected. Profile journeys call profileFixture(page) and
// switch to 'live': `names` maps a user id to the saved name, `reads` and `writes` record the requests, `failWrites` makes saves fail.
const fixtures = new WeakMap();
export function profileFixture(page) {
  if (!fixtures.has(page)) fixtures.set(page, { mode: 'unavailable', names: {}, reads: [], writes: [], failWrites: null, delay: 0 });
  return fixtures.get(page);
}
/** Answers /rest/v1/profiles for a fixture state. `route` is a Playwright route for that URL. */
export async function answerProfile(state, route) {
  const request = route.request(), bearer = request.headers().authorization?.replace('Bearer ', '');
  const who = bearer?.includes('.') ? JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString()).sub : null;
  const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
  if (state.mode === 'unavailable' || !who) return json({ code: 'XX000', message: 'fixture profile unavailable', details: null, hint: null }, 503);
  if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
  const row = name => ({ user_id: who, full_name: name, updated_at: '2026-11-26T10:00:00Z' });
  if (request.method() === 'GET') { state.reads.push(who); return json(state.names[who] ? [row(state.names[who])] : []); }
  if (request.method() === 'POST') {
    const body = request.postDataJSON(); state.writes.push({ who, body });
    if (state.failWrites) return json({ code: 'XX000', message: 'fixture write failure', details: null, hint: null }, state.failWrites);
    state.names[who] = body.full_name; return json(row(body.full_name), 201);
  }
  throw new Error(`Unexpected profile request ${request.method()}`);
}
/** For journeys with their own strict route handler that open the account drawer: answers the profile read as unavailable, like the default above. */
export const profilesUnavailable = route => answerProfile({ mode: 'unavailable' }, route);
export const fixturePhone = '9876543210', fixtureCode = '123456';
const mapOtpRoutes = async page => {
  if (installed.has(page)) return; installed.add(page);
  let email = 'customer@example.test';
  page.__otpEmail = value => { email = value; };
  const state = profileFixture(page);
  await page.route(url => url.pathname === '/rest/v1/profiles', route => answerProfile(state, route));
  await page.route(url => /^\/auth\/v1\/(?:otp|verify)$/.test(url.pathname), route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/otp')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return route.fallback({ url: `${url.origin}/auth/v1/token?grant_type=password`, postData: JSON.stringify({ email, password: 'fixture' }), headers: { ...route.request().headers(), 'content-type': 'application/json' } });
  });
};
/** Signs the fixture user in through the OTP screens; `email` selects which fixture user the token handler returns. Call on a page that shows the Login or Account sign-in card. */
export async function otpSignIn(page, { email, phone = fixturePhone, code = fixtureCode } = {}) {
  await mapOtpRoutes(page); if (email) page.__otpEmail(email);
  await page.getByLabel('Mobile number', { exact: true }).filter({ visible: true }).fill(phone);
  await page.getByRole('button', { name: 'Get code', exact: true }).click();
  await page.getByLabel('6-digit code', { exact: true }).filter({ visible: true }).fill(code);
  await page.getByRole('button', { name: 'Verify and continue', exact: true }).click();
}

// Owners' apps (#50-C): the code is requested from the request-owner-code function (always { ok: true }) and verified through
// /auth/v1/verify on a throwaway client, which then checks business_memberships. The same fixture token handler answers it.
const installedOwner = new WeakSet();
export const ownerRequests = new WeakMap();
const mapOwnerRoutes = async page => {
  if (installedOwner.has(page)) return; installedOwner.add(page);
  let email = 'owner@example.test'; const requests = [];
  page.__otpEmail = value => { email = value; }; ownerRequests.set(page, requests);
  await page.route(url => url.pathname === '/functions/v1/request-owner-code', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); });
  await page.route(url => url.pathname === '/auth/v1/verify', route => {
    const url = new URL(route.request().url());
    return route.fallback({ url: `${url.origin}/auth/v1/token?grant_type=password`, postData: JSON.stringify({ email, password: 'fixture' }), headers: { ...route.request().headers(), 'content-type': 'application/json' } });
  });
};
/** Signs the fixture owner in through the owners' phone and code screens. The page's membership mock must answer the verification check (see each fixture). */
export async function ownerOtpSignIn(page, { email, phone = fixturePhone, code = fixtureCode } = {}) {
  await mapOwnerRoutes(page); if (email) page.__otpEmail(email);
  await page.getByLabel('Mobile number', { exact: true }).filter({ visible: true }).fill(phone);
  await page.getByRole('button', { name: 'Get code', exact: true }).click();
  await page.getByLabel('6-digit code', { exact: true }).filter({ visible: true }).fill(code);
  await page.getByRole('button', { name: 'Verify and continue', exact: true }).click();
}
