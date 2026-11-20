import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OwnerOffer } from '@market/services';
import { emptyOfferForm, firstOfferError, formatIst, formatWindow, formFromOffer, istInput, offerActions, offerApplied, offerGroups, offerSummary, offerUsage, parseIstInput, validateLockedForm, validateOfferForm, type OfferForm } from './offers-model.ts';

const offer = (over: Partial<OwnerOffer> = {}): OwnerOffer => ({ id: 'a', version: 1, paused: false, createdAt: '2026-11-20T10:00:00.000Z', status: 'active', useCount: 0, discountGivenPaise: 0, termsLocked: false, name: 'Dinner', kind: 'percent', value: 20, maxDiscountPaise: 10000,
  minOrderPaise: 30000, applyMode: 'automatic', code: null, firstOrderOnly: false, perCustomerLimit: null, totalLimit: null, startsAt: null, endsAt: null, window: null, ...over });
const form = (over: Partial<OfferForm> = {}): OfferForm => ({ ...emptyOfferForm(), name: 'Dinner deal', value: '20', ...over });
const errorsOf = (f: OfferForm) => { const r = validateOfferForm(f); assert.equal(r.ok, false); return r.ok ? {} : r.errors; };

test('summaries, application and usage wording', () => {
  assert.equal(offerSummary(offer()), '20% off up to ₹100'); assert.equal(offerSummary(offer({ maxDiscountPaise: null })), '20% off');
  assert.equal(offerSummary(offer({ kind: 'flat', value: 5000, maxDiscountPaise: null })), '₹50 off'); assert.equal(offerSummary(offer({ kind: 'free_delivery', value: null, maxDiscountPaise: null })), 'Free delivery');
  assert.equal(offerApplied(offer()), 'Automatic'); assert.equal(offerApplied(offer({ applyMode: 'code', code: 'DINNER20' })), 'Code DINNER20');
  assert.equal(offerUsage(offer({ useCount: 12, discountGivenPaise: 120000 })), '12 uses · ₹1,200 given'); assert.equal(offerUsage(offer({ useCount: 1, discountGivenPaise: 5050 })), '1 use · ₹50.50 given'); assert.equal(offerUsage(offer()), '0 uses · ₹0 given');
});

test('list order: active and scheduled, then paused, then ended and used up', () => {
  const list = [offer({ id: 'e', status: 'ended' }), offer({ id: 'p', status: 'paused' }), offer({ id: 's', status: 'scheduled', createdAt: '2026-11-19T00:00:00.000Z' }), offer({ id: 'a' }), offer({ id: 'u', status: 'used_up' }), offer({ id: 'n', createdAt: '2026-11-21T00:00:00.000Z' })];
  assert.deepEqual(offerGroups(list).map(g => [g.title, g.offers.map(o => o.id)]), [['Active and scheduled', ['n', 'a', 's']], ['Paused', ['p']], ['Ended', ['e', 'u']]]);
  assert.deepEqual(offerGroups([]), []); assert.deepEqual(offerGroups([offer({ status: 'paused' })]).map(g => g.key), ['paused'], 'empty groups are omitted');
  assert.deepEqual(offerActions(offer()), { pause: true, resume: false, end: true }); assert.deepEqual(offerActions(offer({ status: 'paused' })), { pause: false, resume: true, end: true });
  assert.deepEqual(offerActions(offer({ status: 'scheduled' })), { pause: true, resume: false, end: true }); assert.deepEqual(offerActions(offer({ status: 'ended' })), { pause: false, resume: false, end: false });
  assert.deepEqual(offerActions(offer({ status: 'used_up' })), { pause: false, resume: false, end: true });
});

test('dates are India time and must be real', () => {
  assert.deepEqual(parseIstInput('2026-11-21 18:00'), { ok: true, iso: '2026-11-21T12:30:00.000Z' }); assert.deepEqual(parseIstInput('2026-11-21T00:10'), { ok: true, iso: '2026-11-20T18:40:00.000Z' });
  assert.deepEqual(parseIstInput('  '), { ok: true, iso: null });
  for (const bad of ['2026-02-30 10:00', '2026-13-01 10:00', '2026-11-21 24:00', '2026-11-21 10:60', '21/11/2026 18:00', '2026-11-21', 'tomorrow']) assert.deepEqual(parseIstInput(bad), { ok: false }, bad);
  assert.equal(istInput('2026-11-21T12:30:00.000Z'), '2026-11-21 18:00'); assert.equal(istInput('2026-11-20T18:40:00.000Z'), '2026-11-21 00:10'); assert.equal(istInput(null), '');
  assert.equal(formatIst('2026-11-21T12:30:00.000Z'), '21 Nov 2026, 6:00 pm'); assert.equal(formatIst('2026-11-20T18:40:00.000Z'), '21 Nov 2026, 12:10 am'); assert.equal(formatIst('2026-11-21T06:30:00.000Z'), '21 Nov 2026, 12:00 pm');
  assert.equal(formatWindow({ from: '18:00', to: '22:30', days: [1, 3, 5] }), '6:00 pm to 10:30 pm, Mon, Wed, Fri'); assert.equal(formatWindow({ from: '00:00', to: '12:00', days: [1, 2, 3, 4, 5, 6, 7] }), '12:00 am to 12:00 pm, every day');
});

test('a valid form becomes an exact OfferInput', () => {
  const r = validateOfferForm(form({ maxDiscount: '100', minOrder: '300', applyMode: 'code', code: ' dinner20 ', firstOrderOnly: true, perCustomerLimit: '2', totalLimit: '500', startsAt: '2026-11-21 18:00', endsAt: '2026-12-31 23:59',
    windowOn: true, windowFrom: '18:00', windowTo: '22:30', windowDays: [5, 1] }));
  assert.ok(r.ok); if (r.ok) assert.deepEqual(r.input, { name: 'Dinner deal', kind: 'percent', value: 20, maxDiscountPaise: 10000, minOrderPaise: 30000, applyMode: 'code', code: 'DINNER20', firstOrderOnly: true, perCustomerLimit: 2, totalLimit: 500,
    startsAt: '2026-11-21T12:30:00.000Z', endsAt: '2026-12-31T18:29:00.000Z', window: { from: '18:00', to: '22:30', days: [1, 5] } });
  const flat = validateOfferForm(form({ kind: 'flat', value: '50.50', maxDiscount: '999' })); assert.ok(flat.ok); if (flat.ok) assert.deepEqual([flat.input.value, flat.input.maxDiscountPaise], [5050, null], 'max discount is for percent offers only');
  const free = validateOfferForm(form({ kind: 'free_delivery', value: 'ignored', maxDiscount: 'ignored' })); assert.ok(free.ok); if (free.ok) assert.deepEqual([free.input.value, free.input.maxDiscountPaise, free.input.minOrderPaise, free.input.window], [null, null, 0, null]);
  const dropped = validateOfferForm(form({ code: 'IGNORED', windowFrom: '99:99' })); assert.ok(dropped.ok); if (dropped.ok) assert.deepEqual([dropped.input.code, dropped.input.window], [null, null], 'a code or window that is switched off is not sent');
});

test('every invalid field gets a plain message, and focus order starts at the first', () => {
  assert.deepEqual(errorsOf(form({ name: 'ab' })), { name: 'Enter a name of 3 to 40 characters.' });
  for (const value of ['', '0', '91', '1.5', 'x', '-5']) assert.deepEqual(errorsOf(form({ value })), { value: 'Enter a whole percent from 1 to 90.' }, value);
  for (const value of ['', '0.99', '1000.01', '1e2']) assert.deepEqual(errorsOf(form({ kind: 'flat', value })), { value: 'Enter an amount from ₹1 to ₹1,000.' }, value);
  assert.ok(validateOfferForm(form({ kind: 'flat', value: '1' })).ok); assert.ok(validateOfferForm(form({ kind: 'flat', value: '1000' })).ok);
  assert.deepEqual(errorsOf(form({ maxDiscount: '0.50' })), { maxDiscount: 'Enter an amount from ₹1 to ₹1,000, or leave it empty.' }); assert.deepEqual(errorsOf(form({ maxDiscount: '1000.01' })).maxDiscount, 'Enter an amount from ₹1 to ₹1,000, or leave it empty.');
  assert.deepEqual(errorsOf(form({ minOrder: '10000.01' })), { minOrder: 'Enter an amount from ₹0 to ₹10,000, or leave it empty.' }); assert.ok(validateOfferForm(form({ minOrder: '10000' })).ok); assert.ok(validateOfferForm(form({ minOrder: '0' })).ok);
  for (const code of ['', 'ABC', 'A'.repeat(16), 'AB CD', 'AB-CD']) assert.deepEqual(errorsOf(form({ applyMode: 'code', code })), { code: 'Enter a code of 4 to 15 letters and numbers.' }, code);
  assert.deepEqual(errorsOf(form({ perCustomerLimit: '0' })), { perCustomerLimit: 'Enter a number from 1 to 99, or leave it empty.' }); assert.ok(errorsOf(form({ perCustomerLimit: '100' })).perCustomerLimit);
  assert.deepEqual(errorsOf(form({ totalLimit: '100001' })), { totalLimit: 'Enter a number from 1 to 100,000, or leave it empty.' }); assert.ok(validateOfferForm(form({ totalLimit: '100000' })).ok);
  assert.deepEqual(errorsOf(form({ startsAt: 'soon' })), { startsAt: 'Enter it as 2026-11-21 18:00 (India time), or leave it empty.' });
  assert.deepEqual(errorsOf(form({ endsAt: 'later' })), { endsAt: 'Enter it as 2026-11-21 18:00 (India time), or leave it empty.' });
  assert.deepEqual(errorsOf(form({ startsAt: '2026-11-21 18:00', endsAt: '2026-11-21 18:00' })), { endsAt: 'The end must be after the start.' }); assert.deepEqual(errorsOf(form({ startsAt: '2026-11-21 18:00', endsAt: '2026-11-21 09:00' })), { endsAt: 'The end must be after the start.' });
  for (const w of [{ windowFrom: '18:00', windowTo: '18:00' }, { windowFrom: '6pm', windowTo: '9pm' }, { windowDays: [] as number[] }]) assert.ok(errorsOf(form({ windowOn: true, ...w })).window, JSON.stringify(w));
  const many = errorsOf(form({ name: '', value: '', minOrder: 'x', applyMode: 'code', code: '', endsAt: 'bad' }));
  assert.deepEqual(Object.keys(many).sort(), ['code', 'endsAt', 'minOrder', 'name', 'value']); assert.equal(firstOfferError(many), 'name'); assert.equal(firstOfferError({ endsAt: 'x', code: 'y' }), 'code'); assert.equal(firstOfferError({}), undefined);
});

test('an offer round-trips through the form, and a used offer only edits name and end', () => {
  const o = offer({ kind: 'flat', value: 5050, maxDiscountPaise: null, minOrderPaise: 0, applyMode: 'code', code: 'SAVE50', perCustomerLimit: 1, startsAt: '2026-11-21T12:30:00.000Z', window: { from: '18:00', to: '22:30', days: [2, 4] } });
  const f = formFromOffer(o);
  assert.deepEqual([f.value, f.minOrder, f.startsAt, f.windowOn, f.windowDays], ['50.50', '', '2026-11-21 18:00', true, [2, 4]]);
  const r = validateOfferForm(f); assert.ok(r.ok); if (r.ok) { const { name, kind, value, maxDiscountPaise, minOrderPaise, applyMode, code, firstOrderOnly, perCustomerLimit, totalLimit, startsAt, endsAt, window } = o; assert.deepEqual(r.input, { name, kind, value, maxDiscountPaise, minOrderPaise, applyMode, code, firstOrderOnly, perCustomerLimit, totalLimit, startsAt, endsAt, window }); }
  assert.deepEqual(validateLockedForm({ name: ' New name ', endsAt: '2026-12-01 00:00' }), { ok: true, patch: { name: 'New name', endsAt: '2026-11-30T18:30:00.000Z' } });
  assert.deepEqual(validateLockedForm({ name: 'Fine', endsAt: '' }), { ok: true, patch: { name: 'Fine', endsAt: null } });
  assert.deepEqual(validateLockedForm({ name: 'x', endsAt: 'nope' }), { ok: false, errors: { name: 'Enter a name of 3 to 40 characters.', endsAt: 'Enter it as 2026-11-21 18:00 (India time), or leave it empty.' } });
});
