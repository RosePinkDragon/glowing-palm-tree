import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@market/services';
import type { CartLine, MenuItem } from '@market/core';
import { minimumCopy, minimumOrder, noMatchCopy, suggestDishes, classifyFailure, emptyCartCopy, failureCopy, friendlyErrorText, isNetworkFailure, noAddressesCopy, noOrdersCopy, offlineRetrySteps } from './states-model.ts';

test('a request that never arrived is offline, whatever wrapped the message', () => {
  for (const error of [new TypeError('Failed to fetch'), new Error('Load failed'), new Error('Network request failed'), new ServiceError('BACKEND_ERROR', 'Could not load menu: TypeError: Failed to fetch'),
    new ServiceError('X', 'Could not load menu', new TypeError('NetworkError when attempting to fetch resource.')), 'TypeError: Failed to fetch']) {
    assert.equal(classifyFailure(error), 'offline', String(error));
    assert.equal(isNetworkFailure(error), true);
  }
});

test('the browser saying it is offline wins over any other error', () => {
  assert.equal(classifyFailure(new Error('Could not load menu: boom'), false), 'offline');
  assert.equal(classifyFailure(new ServiceError('SIGN_IN_REQUIRED', 'Sign in'), false), 'offline');
});

test('server and sign-in problems are told apart from offline and from each other', () => {
  assert.equal(classifyFailure(new ServiceError('PGRST301', 'Could not load menu: JWT expired')), 'auth');
  assert.equal(classifyFailure(new ServiceError('SIGN_IN_REQUIRED', 'Your session ended. Sign in again.')), 'auth');
  assert.equal(classifyFailure({ message: 'denied', status: 401 }), 'auth');
  assert.equal(classifyFailure(new ServiceError('42501', 'Could not load menu: permission denied')), 'server', 'a refused public read is not a sign-in problem');
  assert.equal(classifyFailure({ message: 'forbidden', status: 403 }), 'server');
  assert.equal(classifyFailure(new ServiceError('BACKEND_ERROR', 'Could not load menu: Internal Server Error')), 'server');
  assert.equal(classifyFailure(new ServiceError('PT503', 'Could not load business: upstream unavailable')), 'server');
  assert.equal(classifyFailure(new ServiceError('NOT_FOUND', 'Business not found.')), 'server');
  assert.equal(classifyFailure(undefined), 'server');
  assert.equal(classifyFailure(null), 'server');
});

test('each cause has its own screen copy, brand wording and action', () => {
  const copies = (['offline', 'server', 'auth'] as const).flatMap(kind => (['ammu-sammu', 'kokani-dine-inn'] as const).map(slug => failureCopy(kind, slug)));
  assert.equal(new Set(copies.map(copy => copy.title)).size, 3, 'three distinct titles');
  assert.deepEqual(failureCopy('offline', 'ammu-sammu'), { title: 'No internet connection', message: "We couldn't load today's menu. Check your mobile data or Wi-Fi, then try again. Your cart is kept on this phone.", action: 'Try again' });
  assert.match(failureCopy('offline', 'kokani-dine-inn').message, /Your order is kept on this phone\.$/);
  assert.equal(failureCopy('auth', 'ammu-sammu').action, 'Sign in');
  assert.doesNotMatch(failureCopy('server', 'ammu-sammu').message, /internet|offline/i);
  assert.doesNotMatch(failureCopy('offline', 'ammu-sammu').message, /sign in|went wrong/i);
});

test('empty cart, no orders and no addresses use the final screens\' words', () => {
  assert.deepEqual(emptyCartCopy('ammu-sammu'), { title: 'Your plate is empty', message: "Add a thali, a snack or something sweet from today's menu, and it'll show up here.", action: 'Browse the menu' });
  assert.equal(emptyCartCopy('kokani-dine-inn').title, 'Nothing ordered yet');
  assert.match(emptyCartCopy('kokani-dine-inn').message, /à la carte/);
  assert.deepEqual(noOrdersCopy('Ammu Sammu'), { title: 'No orders yet', message: 'Your orders from Ammu Sammu will show here, so you can track them and reorder in one tap.', action: 'Browse the menu' });
  const addresses = noAddressesCopy('Kokani Dine Inn');
  assert.equal(addresses.title, 'No saved addresses yet');
  assert.match(addresses.message, /current location/); assert.match(addresses.message, /in this app and the Kokani Dine Inn app/);
});

test('raw network text becomes a plain offline sentence and other text is untouched', () => {
  assert.match(friendlyErrorText('Could not load your orders: TypeError: Failed to fetch'), /^You are offline/);
  assert.equal(friendlyErrorText('Could not load your orders: permission denied'), 'Could not load your orders: permission denied');
  assert.deepEqual([...offlineRetrySteps], [6000, 12000, 30000], 'backs off');
});

const dish = (id: string, name: string, pricePaise: number, extra: Partial<MenuItem> = {}): MenuItem => ({ id, businessId: 'ammu-sammu', name, description: '', category: 'Meals', categoryId: 'c', categorySortOrder: 0, diet: null, pricePaise, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0, ...extra });

test('the minimum counts items only and never blocks when it is 0 or unset', () => {
  assert.deepEqual(minimumOrder(10000, 15000), { applies: true, subtotalPaise: 10000, minPaise: 15000, shortfallPaise: 5000, progress: 10000 / 15000 });
  for (const min of [0, undefined, null, NaN, -5]) assert.equal(minimumOrder(0, min as number).applies, false);
  assert.equal(minimumOrder(15000, 15000).applies, false, 'exactly the minimum is enough (the server refuses only subtotal < minimum)');
  assert.equal(minimumOrder(15001, 15000).shortfallPaise, 0);
  assert.equal(minimumOrder(0, 15000).progress, 0); assert.equal(minimumOrder(99999, 15000).progress, 1);
});

test('below-minimum copy matches the final screens', () => {
  const m = minimumOrder(10000, 15000);
  assert.deepEqual(minimumCopy(m, 'ammu-sammu'), { lead: 'Add ₹50 more to order.', rest: 'The minimum order is ₹150, not counting delivery.', progress: '₹100 of ₹150', button: 'Add ₹50 more to order', subtotalLabel: 'Items', suggestionsTitle: 'Goes well with your order' });
  assert.equal(minimumCopy(minimumOrder(42000, 50000), 'kokani-dine-inn').button, 'Add ₹80 more to order');
  assert.equal(minimumCopy(minimumOrder(42000, 50000), 'kokani-dine-inn').subtotalLabel, 'Dishes');
});

test('suggestions are available real dishes not already in the cart, preferring those that close the gap', () => {
  const menu = [dish('a', 'Poha', 5000), dish('b', 'Sol kadhi', 4000), dish('c', 'Misal pav', 9000), dish('d', 'Sample', 6000, { isDemo: true }), dish('e', 'Sold out', 6000, { isAvailable: false }), dish('f', 'Free', 0), dish('g', 'Thali', 20000)];
  const cart: CartLine[] = [{ item: menu[0]!, quantity: 1 }];
  assert.deepEqual(suggestDishes(menu, cart, 5000).map(item => item.name), ['Misal pav', 'Thali']);
  assert.deepEqual(suggestDishes(menu, cart, 5000, 3).map(item => item.name), ['Misal pav', 'Thali', 'Sol kadhi']);
  assert.deepEqual(suggestDishes(menu, cart, 30000).map(item => item.name), ['Thali', 'Misal pav'], 'none close the gap: dearest first');
  assert.deepEqual(suggestDishes([], [], 100), []);
});

test('no-match copy is per brand', () => {
  assert.deepEqual(noMatchCopy(' paneer ', 'ammu-sammu'), { title: 'No dishes match “paneer”', message: 'Check the spelling, or try one of these:' });
  assert.equal(noMatchCopy('lollipop', 'kokani-dine-inn').title, 'Nothing matches “lollipop”');
});
