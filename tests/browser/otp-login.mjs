// Shared customer sign-in for the browser fixtures (#50-B): drives the real phone and code screens.
// The fixtures' GoTrue mocks still answer /auth/v1/token with the fixture session, so the helper maps the new
// /auth/v1/otp and /auth/v1/verify calls onto that handler (route.fallback with a rewritten request).
const installed = new WeakSet();
export const fixturePhone = '9876543210', fixtureCode = '123456';
const mapOtpRoutes = async page => {
  if (installed.has(page)) return; installed.add(page);
  let email = 'customer@example.test';
  page.__otpEmail = value => { email = value; };
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
