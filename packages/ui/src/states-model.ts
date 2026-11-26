// Copy and decisions for the customer apps' "nothing to show" and "can't reach the server" screens (#57), kept free of JSX so tests can check them.
import { formatINRFromPaise, type BusinessSlug, type CartLine, type MenuItem } from '@market/core';

/** Why a load failed: no connection, the server had a problem, or the sign-in is no longer valid. Each gets its own message. */
export type FailureKind = 'offline' | 'server' | 'auth';

// What browsers and React Native say when a request never reached the server.
const networkText = /failed to fetch|load failed|network request failed|networkerror|network error|fetch failed|internet connection appears to be offline|err_internet_disconnected|err_network_changed|err_connection|connection failed/i;
// A bare 403 or 42501 on a public menu read is not a sign-in problem (nobody has to be signed in to read the menu), so only an expired or missing session counts.
const authCodes = new Set(['SIGN_IN_REQUIRED', 'SESSION_CHANGED', 'ADMIN_REQUIRED', 'PGRST301', 'PGRST302', 'PT401']);
const authText = /jwt|not authenticated|session (?:ended|expired)|sign in again|invalid refresh token/i;

/** The text, code and name of an error and of its causes (up to three levels), so a wrapped network failure is still recognised. */
function trail(error: unknown): { text: string; codes: string[]; status: number | null } {
  const text: string[] = [], codes: string[] = []; let status: number | null = null, current: unknown = error;
  for (let depth = 0; depth < 3 && current != null; depth++) {
    if (typeof current === 'string') { text.push(current); break; }
    if (typeof current !== 'object') break;
    const { message, name, code, status: code2 } = current as { message?: unknown; name?: unknown; code?: unknown; status?: unknown };
    if (typeof message === 'string') text.push(message); if (typeof name === 'string') text.push(name); if (typeof code === 'string') codes.push(code);
    if (typeof code2 === 'number' && status === null) status = code2;
    current = (current as { cause?: unknown }).cause;
  }
  return { text: text.join(' | '), codes, status };
}

/** True when a message or error is the "request never arrived" kind. */
export function isNetworkFailure(error: unknown): boolean { return networkText.test(trail(error).text); }

/** Offline first (the browser says so, or the request never arrived), then sign-in problems, then everything else is the server's. */
export function classifyFailure(error: unknown, online = true): FailureKind {
  if (!online || isNetworkFailure(error)) return 'offline';
  const { text, codes, status } = trail(error);
  if (codes.some(code => authCodes.has(code)) || status === 401 || authText.test(text)) return 'auth';
  return 'server';
}

/** A raw error text from a service, with the connection case said plainly; anything else is returned unchanged. */
export function friendlyErrorText(message: string): string {
  return networkText.test(message) ? 'You are offline. Check your mobile data or Wi-Fi, then try again.' : message;
}

export const offlineBarText = "You're offline";
/** Waits (ms) between quiet background checks while offline: 6 s, 12 s, then every 30 s. Web also listens for the browser's own "online" event. */
export const offlineRetrySteps = [6000, 12000, 30000] as const;

/** What the order or cart is called on this phone: "cart" for Ammu Sammu, "order" for Kokani Dine Inn (their own wording on the final screens). */
const kept = (slug: BusinessSlug) => slug === 'ammu-sammu' ? 'Your cart is kept on this phone.' : 'Your order is kept on this phone.';

export type StateCopy = { title: string; message: string; action: string };

/** The full-screen state for a menu that could not load, by cause (design p. 12; the other two follow the same layout). */
export function failureCopy(kind: FailureKind, slug: BusinessSlug): StateCopy {
  if (kind === 'offline') return { title: 'No internet connection', message: `We couldn't load today's menu. Check your mobile data or Wi-Fi, then try again. ${kept(slug)}`, action: 'Try again' };
  if (kind === 'auth') return { title: 'Please sign in again', message: `Your sign-in is no longer valid, so we couldn't load the menu. Sign in to continue. ${kept(slug)}`, action: 'Sign in' };
  return { title: "We can't load the menu right now", message: `Something went wrong on our side, not with your connection. Try again in a moment. ${kept(slug)}`, action: 'Try again' };
}

/** Empty checkout (design p. 13): Ammu Sammu "Your plate is empty", Kokani Dine Inn "Nothing ordered yet". */
export function emptyCartCopy(slug: BusinessSlug): StateCopy {
  return slug === 'ammu-sammu'
    ? { title: 'Your plate is empty', message: "Add a thali, a snack or something sweet from today's menu, and it'll show up here.", action: 'Browse the menu' }
    : { title: 'Nothing ordered yet', message: "Pick a signature dish or something from the à la carte menu, and it'll show up here.", action: 'See the menu' };
}

/** No past orders (design p. 15), in the account drawer and on the orders page. */
export function noOrdersCopy(name: string): StateCopy {
  return { title: 'No orders yet', message: `Your orders from ${name} will show here, so you can track them and reorder in one tap.`, action: 'Browse the menu' };
}

/** No saved addresses (design p. 16): addresses are shared by both apps; adding one can use the phone's location. */
export function noAddressesCopy(other: string): { title: string; message: string } {
  return { title: 'No saved addresses yet', message: `Use your current location or add an address. It's saved for next time, in this app and the ${other} app.` };
}

/** Below the restaurant's minimum order (#57). Only the items count, never delivery or a discount: the server refuses `subtotal < min_order_paise` on items alone. */
export type MinimumOrder = { applies: boolean; subtotalPaise: number; minPaise: number; shortfallPaise: number; progress: number };
export function minimumOrder(subtotalPaise: number, minPaise: number | null | undefined): MinimumOrder {
  const min = Number.isFinite(minPaise) && (minPaise as number) > 0 ? Math.floor(minPaise as number) : 0;
  const subtotal = Number.isFinite(subtotalPaise) && subtotalPaise > 0 ? Math.floor(subtotalPaise) : 0;
  const applies = min > 0 && subtotal < min;
  return { applies, subtotalPaise: subtotal, minPaise: min, shortfallPaise: applies ? min - subtotal : 0, progress: min > 0 ? Math.min(1, subtotal / min) : 1 };
}

/** The words of the below-minimum bar, the progress label and the disabled main button (design p. 24). */
export function minimumCopy(m: MinimumOrder, slug: BusinessSlug) {
  const more = formatINRFromPaise(m.shortfallPaise);
  return { lead: `Add ${more} more to order.`, rest: `The minimum order is ${formatINRFromPaise(m.minPaise)}, not counting delivery.`, progress: `${formatINRFromPaise(m.subtotalPaise)} of ${formatINRFromPaise(m.minPaise)}`,
    button: `Add ${more} more to order`, subtotalLabel: slug === 'ammu-sammu' ? 'Items' : 'Dishes', suggestionsTitle: slug === 'ammu-sammu' ? 'Goes well with your order' : 'To round it off' };
}

/** A couple of dishes to close the gap: available, real (not sample), not already in the cart. Dishes that reach the minimum come first (cheapest first), then the rest by price, highest first. */
export function suggestDishes(menu: readonly MenuItem[], cart: readonly CartLine[], shortfallPaise: number, limit = 2): MenuItem[] {
  const inCart = new Set(cart.map(line => line.item.id));
  const pool = menu.filter(item => item.isAvailable && !item.isDemo && !inCart.has(item.id) && item.pricePaise > 0);
  const closes = pool.filter(item => item.pricePaise >= shortfallPaise).sort((a, b) => a.pricePaise - b.pricePaise || a.name.localeCompare(b.name));
  const rest = pool.filter(item => item.pricePaise < shortfallPaise).sort((a, b) => b.pricePaise - a.pricePaise || a.name.localeCompare(b.name));
  return [...closes, ...rest].slice(0, limit);
}

/** Menu search with no match (design p. 30): Ammu Sammu "No dishes match", Kokani Dine Inn "Nothing matches". */
export function noMatchCopy(query: string, slug: BusinessSlug) {
  const text = query.trim();
  return slug === 'ammu-sammu' ? { title: `No dishes match “${text}”`, message: 'Check the spelling, or try one of these:' } : { title: `Nothing matches “${text}”`, message: 'Check the spelling, or look through a section:' };
}
