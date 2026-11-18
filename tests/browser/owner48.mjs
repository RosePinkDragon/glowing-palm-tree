import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveWeb } from '../../scripts/serve-web.mjs';

// #48 owner slice: structured address and remote-order flag in the queue card and details; #100: area, kitchen distance
// and the in-area line, for both restaurants' admin apps.
// Installed SDK and the real admin export, with synthetic HTTP only (realtime stays paused).
const api = 'https://market-fixture.supabase.co';
const visible = locator => locator.filter({ visible: true });
const user = { id: '48500000-0000-4000-8000-000000000001', email: 'owner@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' };
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = { access_token: `${part({ alg: 'HS256' })}.${part({ sub: user.id, aud: 'authenticated', role: 'authenticated', session_id: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`, refresh_token: user.id, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user };
const businessId = '48600000-0000-4000-8000-000000000001', itemId = '48700000-0000-4000-8000-000000000001';
const businessFor = slug => ({ id: businessId, slug, name: slug === 'ammu-sammu' ? 'Ammu Sammu' : 'Kokani Dine Inn', delivery_fee_paise: 2000, min_order_paise: 0, is_demo: false, ordering_enabled: true, accepting_orders: true });
const saved = { address_label: 'other', address_custom_label: 'Aai', address_house: '12, Shivaji Nagar', address_street_area: 'Station Road, Khed', address_landmark: 'Near the temple', address_location_source: 'pin' };
const row = (n, name, extra) => ({ id: `48900000-0000-4000-8000-00000000000${n}`, order_number: `AMS-202611000${n}`, business_id: businessId, customer_id: user.id, status: 'placed', version: 1, created_at: new Date(Date.now() - n * 60000).toISOString(), subtotal_paise: 10000, delivery_fee_paise: 2000, total_paise: 12000, customer_name: name, customer_phone: '9876543210', delivery_address_line: '12, Shivaji Nagar, Station Road, Khed', order_items: [{ menu_item_id: itemId, name: 'Fixture meal', diet: null, quantity: 1, unit_price_paise: 10000, line_total_paise: 10000 }], order_status_history: [], ...extra });
const orders = [
  row(1, 'Far customer', { ...saved, saved_address_id: '48a00000-0000-4000-8000-000000000001', placed_from_distance_m: 12400, kitchen_distance_m: 2400 }),
  row(2, 'Unknown customer', { ...saved, saved_address_id: '48a00000-0000-4000-8000-000000000001', placed_from_distance_m: null, kitchen_distance_m: null }),
  row(3, 'Near customer', { ...saved, saved_address_id: '48a00000-0000-4000-8000-000000000001', placed_from_distance_m: 80, kitchen_distance_m: 800 }),
  row(4, 'Legacy customer', { placed_from_distance_m: 5000, kitchen_distance_m: 5000, delivery_address_line: 'Legacy typed address, Khed' }),
  row(5, 'Close-by customer', { ...saved, address_label: 'home', address_custom_label: null, address_landmark: null, saved_address_id: '48a00000-0000-4000-8000-000000000001', placed_from_distance_m: 420, kitchen_distance_m: 1200 }),
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
try {
for (const slug of ['ammu-sammu', 'kokani-dine-inn']) {
  const admin = await serveWeb(`apps/${slug}-admin/dist/web`);
  try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: `market:https%3A%2F%2Fmarket-fixture.supabase.co:${slug}:admin`, value: session });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === admin.url) return route.fallback();
    assert.equal(url.origin, api, 'no unconfigured third-party requests');
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/auth/v1/token') return json(session);
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname === '/rest/v1/businesses') return json(businessFor(slug));
    if (url.pathname === '/rest/v1/business_memberships') return json({ role: 'admin' });
    if (url.pathname === '/rest/v1/menu_items' || url.pathname === '/rest/v1/menu_categories') return json([]);
    if (url.pathname === '/rest/v1/orders') return json(url.searchParams.has('id') ? orders[0] : orders);
    throw new Error(`Unexpected owner fixture ${request.method()} ${url.pathname}`);
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(admin.url, { waitUntil: 'networkidle' });
  const card = reference => visible(page.getByRole('group', { name: new RegExp(`^Order ${reference},`) }));
  const flagIn = (scope, text) => visible(scope.getByText(text, { exact: true }));
  // The queue stays rendered behind the full-screen details, so details checks are scoped to the panel around the customer heading.
  let panel;
  const hint = () => visible(panel.getByText('Call to confirm someone will receive the order and pay cash.', { exact: true }));
  await card('AMS-2026110001').waitFor();
  // #100: the card shows the saved area and the stored kitchen distance; legacy orders keep the shortened typed line.
  await flagIn(card('AMS-2026110001'), 'Station Road, Khed · 2.4 km').waitFor();
  await flagIn(card('AMS-2026110002'), 'Station Road, Khed').waitFor();
  await flagIn(card('AMS-2026110003'), 'Station Road, Khed · 800 m').waitFor();
  await flagIn(card('AMS-2026110004'), 'Legacy typed address, Khed').waitFor();
  await flagIn(card('AMS-2026110005'), 'Station Road, Khed · 1.2 km').waitFor();
  assert.equal(await visible(card('AMS-2026110004').getByText(/ · [\d.]+ (km|m)$/)).count(), 0, 'legacy order shows no distance');
  await card('AMS-2026110001').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `dist/browser/owner-queue-${slug}.png` });

  await flagIn(card('AMS-2026110001'), 'Ordered from 12 km away').waitFor();
  await flagIn(card('AMS-2026110002'), 'Customer location not confirmed').waitFor();
  assert.equal(await visible(card('AMS-2026110003').getByText(/Ordered from|not confirmed/)).count(), 0, 'near saved-address order has no flag');
  assert.equal(await visible(card('AMS-2026110004').getByText(/Ordered from|not confirmed/)).count(), 0, 'legacy order never has a flag, whatever its distance');
  await flagIn(card('AMS-2026110005'), 'Ordered from 450 m away').waitFor();

  const details = async (reference, name) => { await visible(page.getByRole('button', { name: `Details for ${reference}`, exact: true })).click(); const heading = visible(page.getByRole('heading', { name, level: 2, exact: true })); await heading.waitFor(); panel = heading.locator('xpath=ancestor::*[.//button[@aria-label="Back"]][1]'); };
  const close = () => visible(page.getByRole('button', { name: 'Back', exact: true })).click();
  const text = value => visible(panel.getByText(value, { exact: true }));
  await details('AMS-2026110001', 'Far customer');
  for (const value of ['Aai', '12, Shivaji Nagar', 'Station Road, Khed', 'Landmark: Near the temple', 'Ordered from 12 km away']) await text(value).waitFor();
  await hint().waitFor();
  await text('2.4 km · pin checked inside delivery area').waitFor();
  await page.waitForTimeout(600); // let the sheet finish animating
  await page.screenshot({ path: `dist/browser/owner-details-${slug}.png` });
  await close();
  await details('AMS-2026110002', 'Unknown customer');
  await text('Customer location not confirmed').waitFor(); await hint().waitFor();
  assert.equal(await visible(panel.getByText(/pin checked inside/)).count(), 0, 'unknown distance omits the in-area line'); await close();
  await details('AMS-2026110003', 'Near customer');
  assert.equal(await visible(panel.getByText(/Ordered from|not confirmed/)).count(), 0); assert.equal(await hint().count(), 0); await text('Aai').waitFor(); await text('800 m · pin checked inside delivery area').waitFor(); await close();
  await details('AMS-2026110004', 'Legacy customer');
  await text('Legacy typed address, Khed').waitFor();
  assert.equal(await visible(panel.getByText(/Ordered from|not confirmed|Landmark:|pin checked inside/)).count(), 0, 'legacy order makes no in-area claim'); assert.equal(await hint().count(), 0); await close();
  await details('AMS-2026110005', 'Close-by customer');
  await text('Home').waitFor(); await text('Ordered from 450 m away').waitFor(); await text('1.2 km · pin checked inside delivery area').waitFor();
  assert.equal(await visible(panel.getByText(/^Landmark:/)).count(), 0, 'missing landmark is not invented');
  { // #53 p5: back arrow, status pill at header-right, placed time under the order number
    const back = (await visible(page.getByRole('button', { name: 'Back', exact: true })).boundingBox()); const title = await visible(page.getByRole('heading', { name: /^Order AMS-2026110005$/ })).boundingBox();
    const pill = await visible(page.getByRole('status', { name: /^Status: /i })).boundingBox(); const placed = await visible(page.getByText(/^Placed /).first()).boundingBox();
    assert.ok(back.width >= 44 && back.height >= 44, 'back control is a 44px target');
    assert.ok(back.x < title.x && pill.x > title.x + title.width - 1, 'back arrow left of the title, status pill right of it');
    assert.ok(Math.abs((pill.y + pill.height / 2) - (title.y + title.height / 2)) < 40 && placed.y >= title.y + title.height - 2, 'placed time sits under the order number');
  }
  assert.deepEqual(errors, []);
  console.log(`PASS (${slug}): owner queue and details show the structured address, kitchen distance and remote-order flag only for saved-address orders`);
  await context.close();
  } finally { await admin.close(); }
}
} finally { await browser.close(); }
