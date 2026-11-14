import assert from 'node:assert/strict';
import test from 'node:test';
import { menuItem } from '../../../tests/fixtures/menu.ts';
import {
  DomainValidationError,
  dietLabels,
  isDiet,
  addCartItem,
  canTransitionOrderStatus,
  cartSubtotalPaise,
  formatINRFromPaise,
  removeCartItem,
  setCartItemQuantity,
  validateDeliveryDetails,
  validateLocationFix,
  type CartLine,
  type MenuItem,
} from './index.ts';

const soup: MenuItem = menuItem({
  id: 'soup', businessId: 'ammu-sammu', name: 'Soup', description: '', category: 'Starter',
  pricePaise: 12550, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0,
});
const rice: MenuItem = { ...soup, id: 'rice', name: 'Rice', pricePaise: 9900 };
const otherBusiness: MenuItem = { ...soup, id: 'fish', businessId: 'kokani-dine-inn' };

function errorCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof DomainValidationError && error.code === code);
}

test('cart is immutable, bounded, one-business, and totals integer paise safely', () => {
  const first = addCartItem([], soup);
  assert.deepEqual(first, [{ item: soup, quantity: 1 }]);
  const two = addCartItem(first, soup, 2);
  assert.equal(first[0].quantity, 1);
  assert.equal(two[0].quantity, 3);
  assert.equal(cartSubtotalPaise(two), 37650);
  assert.equal(setCartItemQuantity(two, 'soup', 2)[0].quantity, 2);
  assert.deepEqual(removeCartItem(two, 'soup'), []);
  errorCode(() => addCartItem(first, otherBusiness), 'CART_BUSINESS_MISMATCH');
  errorCode(() => addCartItem(first, soup, 0), 'INVALID_QUANTITY');
  errorCode(() => addCartItem(first, soup, 1.5), 'INVALID_QUANTITY');
  errorCode(() => addCartItem(first, soup, 10), 'INVALID_QUANTITY');
  errorCode(() => addCartItem([], { ...soup, pricePaise: Number.MAX_SAFE_INTEGER + 1 }), 'INVALID_PRICE');
  errorCode(() => cartSubtotalPaise([{ item: { ...soup, pricePaise: Number.MAX_SAFE_INTEGER }, quantity: 2 }]), 'PRICE_OVERFLOW');
  const many: CartLine[] = Array.from({ length: 20 }, (_, i) => ({ item: { ...soup, id: `item-${i}` }, quantity: 1 }));
  errorCode(() => addCartItem(many, rice), 'CART_LINE_LIMIT');
});

test('delivery validation trims fields and normalizes Indian mobile numbers', () => {
  assert.deepEqual(validateDeliveryDetails({ name: '  Neha  ', phone: ' +91 98765 43210 ', addressLine: '  12 Main Street, Pune  ' }), {
    name: 'Neha', phone: '+919876543210', addressLine: '12 Main Street, Pune',
  });
  assert.deepEqual(validateDeliveryDetails({ name: 'Aarav', phone: '9876543210', addressLine: 'Flat 4, Park Road' }).phone, '+919876543210');
  assert.throws(() => validateDeliveryDetails({ name: 'A', phone: '12345', addressLine: 'Short' }), (error: unknown) => {
    assert.ok(error instanceof DomainValidationError);
    assert.deepEqual(Object.keys(error.fields).sort(), ['addressLine', 'name', 'phone']);
    return true;
  });
});

test('location fix checks finite bounds, accuracy, freshness, and future timestamps', () => {
  const now = Date.parse('2026-11-12T12:00:00.000Z');
  const current = { latitude: 18.52, longitude: 73.85, accuracy: 25, capturedAtISO: '2026-11-12T11:59:00.000Z' };
  assert.equal(validateLocationFix(current, now), current);
  errorCode(() => validateLocationFix({ ...current, latitude: Number.NaN }, now), 'INVALID_LOCATION_FIX');
  errorCode(() => validateLocationFix({ ...current, longitude: 181 }, now), 'INVALID_LOCATION_FIX');
  errorCode(() => validateLocationFix({ ...current, accuracy: 100.1 }, now), 'INVALID_LOCATION_FIX');
  errorCode(() => validateLocationFix({ ...current, capturedAtISO: '2026-11-12T11:54:59.999Z' }, now), 'INVALID_LOCATION_FIX');
  errorCode(() => validateLocationFix({ ...current, capturedAtISO: '2026-11-12T12:00:30.001Z' }, now), 'INVALID_LOCATION_FIX');
});

test('order status transitions allow only the defined forward and cancellation paths', () => {
  assert.equal(canTransitionOrderStatus('placed', 'accepted'), true);
  assert.equal(canTransitionOrderStatus('preparing', 'cancelled'), true);
  assert.equal(canTransitionOrderStatus('out_for_delivery', 'cancelled'), false);
  assert.equal(canTransitionOrderStatus('delivered', 'cancelled'), false);
});

test('INR formatting uses paise and rejects unsafe amounts', () => {
  assert.equal(formatINRFromPaise(12550), '₹125.50');
  assert.equal(formatINRFromPaise(0), '₹0.00');
  assert.equal(formatINRFromPaise(Number.MAX_SAFE_INTEGER), '₹9,00,71,99,25,47,409.91');
  errorCode(() => formatINRFromPaise(Number.MAX_SAFE_INTEGER + 1), 'INVALID_AMOUNT');
});

// Classification is owner supplied, including for sample dishes.
test('diet values stay explicit through cart changes; unknown never becomes vegetarian', () => {
  for (const diet of ['veg', 'egg', 'non_veg'] as const) {
    assert.ok(isDiet(diet));
    assert.ok(dietLabels[diet]);
    assert.equal(setCartItemQuantity(addCartItem([], { ...soup, diet }), soup.id, 2)[0].item.diet, diet);
  }
  for (const value of [null, undefined, '', 'vegetarian', 'fish', false]) assert.equal(isDiet(value), false);
  assert.equal(addCartItem([], { ...soup, diet: null, isDemo: true })[0].item.diet, null);
});

test('menu merchandising stays attached to cart items without affecting price or diet', () => {
  const item = { ...soup, isFeatured: true, sortOrder: -2, diet: null };
  const cart = setCartItemQuantity(addCartItem([], item), item.id, 2);
  assert.deepEqual(cart[0].item, item);
  assert.equal(cartSubtotalPaise(cart), 25100);
});
