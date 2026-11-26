import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@market/services';
import { classifyFailure, emptyCartCopy, failureCopy, friendlyErrorText, isNetworkFailure, noAddressesCopy, noOrdersCopy, offlineRetryMs } from './states-model.ts';

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
  assert.equal(classifyFailure(new ServiceError('42501', 'Could not load menu: permission denied')), 'auth');
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
  assert.ok(offlineRetryMs >= 3000 && offlineRetryMs <= 15000);
});
