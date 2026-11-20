import assert from 'node:assert/strict';
import test from 'node:test';
import type { CartLine, MenuItem } from '@market/core';
import type { PricingTerms } from '@market/services';
import { bannerText, billTotals, discountLabel, nudgeText, offerChangedMessage, offerDescription, offerErrorMessage, quoteSignature, quotedOffer, retryMinutes } from './offer-model.ts';
import { capturePricing } from './pricing-model.ts';
import { freezeAttempt, readAttempt } from './checkout-state.ts';

const item = (id: string, pricePaise: number) => ({ id, businessId: 'ammu-sammu', name: id, pricePaise, isAvailable: true, isDemo: false }) as unknown as MenuItem;
const lines: CartLine[] = [{ item: item('a', 30000), quantity: 2 }];
const offer = { id: '00000000-0000-4000-8000-000000000001', name: 'Launch offer', code: null, kind: 'percent' as const };

test('offer descriptions and the banner', () => {
  assert.equal(offerDescription({ kind: 'percent', value: 20, maxDiscountPaise: 10000, minOrderPaise: 30000 }), '20% off up to ₹100 on orders above ₹300');
  assert.equal(offerDescription({ kind: 'flat', value: 5000, minOrderPaise: 0 }), '₹50 off');
  assert.equal(offerDescription({ kind: 'free_delivery', value: null, minOrderPaise: 20000 }), 'Free delivery on orders above ₹200');
  assert.equal(bannerText([]), null);
  assert.equal(bannerText([{ kind: 'flat', value: 5000, minOrderPaise: 0 }, { kind: 'free_delivery', value: null, minOrderPaise: 0 }] as never), '₹50 off (+1 more)');
  assert.equal(nudgeText({ offerId: 'x', name: 'n', kind: 'percent', value: 20, shortfallPaise: 5000 }), 'Add ₹50 more to get 20% off');
  assert.equal(nudgeText({ offerId: 'x', name: 'n', kind: 'free_delivery', value: null, shortfallPaise: 5000 }), 'Add ₹50 more to get free delivery');
});

test('every refusal has friendly copy; not found and ended read the same', () => {
  assert.equal(offerErrorMessage({ reason: 'not_found' }), 'This code isn\'t valid');
  assert.equal(offerErrorMessage({ reason: 'ended' }), 'This code isn\'t valid');
  assert.equal(offerErrorMessage({ reason: 'used_up' }), 'This offer has run out');
  assert.equal(offerErrorMessage({ reason: 'min_order', shortfallPaise: 5000 }), 'Add ₹50 more to use this code');
  assert.equal(offerErrorMessage({ reason: 'per_customer_limit' }), 'You\'ve already used this code');
  assert.equal(offerErrorMessage({ reason: 'first_order_only' }), 'This code is only for your first order here');
  assert.equal(offerErrorMessage({ reason: 'rate_limited', retryAfterSeconds: 61 }), 'Too many tries. Try again in 2 min');
  assert.equal(offerErrorMessage({ reason: 'rate_limited', retryAfterSeconds: 5 }), 'Too many tries. Try again in 1 min');
  assert.equal(retryMinutes(undefined), 1);
  for (const reason of ['paused', 'not_started', 'outside_window', 'no_benefit', 'changed'] as const) assert.ok(offerErrorMessage({ reason }).length > 10);
});

test('offer changed at place time names the reason and the repriced total', () => {
  const text = offerChangedMessage({ reason: 'used_up' }, 62000);
  assert.match(text, /^Your offer changed: the offer has run out\./);
  assert.match(text, /₹620/); assert.match(text, /Tap Place order/);
  assert.match(offerChangedMessage({ reason: 'rate_limited', retryAfterSeconds: 120 }, 62000), /Try again in 2 min/);
});

test('the quote signature changes with quantities, prices and the fee', () => {
  const base = quoteSignature(lines, 2000, 0);
  assert.equal(base, quoteSignature(lines, 2000, 0));
  assert.notEqual(base, quoteSignature([{ ...lines[0], quantity: 3 }], 2000, 0));
  assert.notEqual(base, quoteSignature([{ item: item('a', 31000), quantity: 2 }], 2000, 0));
  assert.notEqual(base, quoteSignature(lines, 3000, 0));
});

test('accepted pricing carries the server discount and offer, and matches the server quote', () => {
  const none = capturePricing(lines, 2000, 0);
  assert.equal('discount_paise' in none || 'offer' in none, false, 'no offer: exactly the old contract');
  const server: PricingTerms = { ...none, discount_paise: 10000, offer, total_paise: 60000 + 2000 - 10000 };
  const mine = capturePricing(lines, 2000, 0, quotedOffer(server));
  assert.deepEqual(mine, server);
  assert.equal(capturePricing(lines, 2000, 0, quotedOffer(none)).total_paise, 62000);
  // A discount can never take the total below zero, even against a cart that shrank.
  assert.equal(capturePricing([{ item: item('a', 100), quantity: 1 }], 0, 0, { discount_paise: 99999, offer }).total_paise, 0);
  assert.deepEqual(billTotals(60000, 2000, quotedOffer(server)), { discountPaise: 10000, totalPaise: 52000 });
  assert.deepEqual(billTotals(60000, 2000, null), { discountPaise: 0, totalPaise: 62000 });
});

test('the saved attempt keeps the code, so a recovery replays the same request', () => {
  const attempt = freezeAttempt({ businessId: 'ammu-sammu', userId: 'u', idempotencyKey: 'k', lines, pricing: capturePricing(lines, 2000, 0), offerCode: 'SAVE20', delivery: { name: 'A', phone: '9876543210' }, savedAddress: { id: 'x', version: 1 }, location: null });
  assert.equal(readAttempt(JSON.stringify(attempt), 'ammu-sammu')?.offerCode, 'SAVE20');
  assert.equal(readAttempt(JSON.stringify({ ...attempt, offerCode: undefined }), 'ammu-sammu')?.offerCode, undefined, 'older attempts have no code');
  assert.throws(() => readAttempt(JSON.stringify({ ...attempt, offerCode: 5 }), 'ammu-sammu'));
});

test('owner label names the offer or its code', () => {
  assert.equal(discountLabel({ name: 'Launch offer', code: null }), 'Discount (Launch offer)');
  assert.equal(discountLabel({ name: '', code: 'SAVE20' }), 'Discount (SAVE20)');
  assert.equal(discountLabel(undefined), 'Discount');
});
