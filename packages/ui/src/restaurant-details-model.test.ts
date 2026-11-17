import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestaurantSettingsValidationError } from '@market/services';
import { displayPhone, firstErrorField, formFromSettings, paiseToRupees, serverFieldErrors, validateDetailsForm, type DetailsForm } from './restaurant-details-model.ts';

const form: DetailsForm = { contactPhone: '98200 44556', whatsappPhone: '+91 98200 44556', deliveryFee: '30', minOrder: '150' };

test('paise convert to rupee text exactly', () => {
  for (const [paise, text] of [[0, '0'], [1, '0.01'], [5, '0.05'], [10, '0.10'], [3000, '30'], [3050, '30.50'], [99999, '999.99'], [100000, '1000'], [1000000, '10000']] as const) assert.equal(paiseToRupees(paise), text);
});

test('valid form becomes exact integer paise and canonical phones', () => {
  const result = validateDetailsForm(form, 4);
  assert.deepEqual(result, { ok: true, input: { contactPhone: '+919820044556', whatsappPhone: '+919820044556', deliveryFeePaise: 3000, minOrderPaise: 15000, expectedVersion: 4 } });
  // Amounts that floating point would misparse (0.07 * 100 = 7.000000000000001, 1.15 * 100 = 114.99999999999999).
  for (const [text, paise] of [['0.07', 7], ['1.15', 115], ['19.99', 1999], ['0.29', 29], ['4.35', 435], ['  12.5 ', 1250], ['0', 0], ['1000', 100000], ['1000.00', 100000]] as const) {
    const r = validateDetailsForm({ ...form, deliveryFee: text }, 1);
    assert.ok(r.ok, text); assert.equal(r.input.deliveryFeePaise, paise, text);
  }
  const max = validateDetailsForm({ ...form, minOrder: '10000.00' }, 1); assert.ok(max.ok); assert.equal(max.input.minOrderPaise, 1000000);
});

test('empty WhatsApp is allowed and sent as null; landline is allowed for the customer number only', () => {
  const r = validateDetailsForm({ ...form, whatsappPhone: '  ', contactPhone: '022 2345 6789' }, 2);
  assert.ok(r.ok); assert.equal(r.input.whatsappPhone, null); assert.equal(r.input.contactPhone, '+912223456789');
  const landline = validateDetailsForm({ ...form, whatsappPhone: '022 2345 6789' }, 2);
  assert.ok(!landline.ok); assert.deepEqual(Object.keys(landline.errors), ['whatsappPhone']);
});

test('every invalid field is reported together and nothing is sent', () => {
  const r = validateDetailsForm({ contactPhone: '', whatsappPhone: '12345', deliveryFee: '1000.01', minOrder: '1.234' }, 1);
  assert.ok(!r.ok);
  assert.deepEqual(Object.keys(r.errors).sort(), ['contactPhone', 'deliveryFee', 'minOrder', 'whatsappPhone']);
  assert.equal(firstErrorField(r.errors), 'contactPhone');
  assert.match(r.errors.deliveryFee!, /0 to 1000 rupees/);
  assert.match(r.errors.minOrder!, /two decimal places/);
});

test('rupee text that is not a plain amount is refused, never rounded', () => {
  for (const text of ['', ' ', '-1', '1e2', '0x10', '1.001', '.5', '5.', '1,000', '₹30', 'NaN', 'Infinity', '1000.01', '100000']) {
    const r = validateDetailsForm({ ...form, deliveryFee: text }, 1);
    assert.ok(!r.ok, `"${text}" should be refused`); assert.ok(r.errors.deliveryFee, text);
  }
  assert.ok(!validateDetailsForm({ ...form, minOrder: '10000.01' }, 1).ok);
  assert.equal(firstErrorField({ minOrder: 'x', deliveryFee: 'y' }), 'deliveryFee');
  assert.equal(firstErrorField({}), null);
});

test('foreign and malformed phone numbers are refused', () => {
  for (const contactPhone of ['+1 202 555 0123', '12345', '0000000000', 'call me', '+91 98200 4455']) assert.ok(!validateDetailsForm({ ...form, contactPhone }, 1).ok, contactPhone);
  assert.ok(!validateDetailsForm({ ...form, whatsappPhone: '5820044556' }, 1).ok, 'WhatsApp must be a mobile number');
});

test('a missing version asks for a reload instead of a field error', () => {
  const r = validateDetailsForm(form, 0);
  assert.ok(!r.ok); assert.match(r.formError ?? '', /Refresh/);
});

test('loaded settings fill the form, and server field errors map back to form fields', () => {
  assert.deepEqual(formFromSettings({ contactPhone: '+919820044556', whatsappPhone: null, deliveryFeePaise: 3050, minOrderPaise: 15000, version: 2 }), { contactPhone: '+91 98200 44556', whatsappPhone: '', deliveryFee: '30.50', minOrder: '150' });
  assert.equal(formFromSettings({ contactPhone: null, whatsappPhone: null, deliveryFeePaise: 0, minOrderPaise: 0, version: 1 }).contactPhone, '');
  assert.equal(displayPhone('+912223456789'), '+91 22234 56789'); assert.equal(displayPhone('garbage'), 'garbage'); assert.equal(displayPhone(null), '');
  assert.deepEqual(serverFieldErrors(new RestaurantSettingsValidationError({ deliveryFeePaise: 'a', minOrderPaise: 'b', contactPhone: 'c', whatsappPhone: 'd' }).fields), { deliveryFee: 'a', minOrder: 'b', contactPhone: 'c', whatsappPhone: 'd' });
});
