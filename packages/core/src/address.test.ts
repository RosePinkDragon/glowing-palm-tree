import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressLine, addressTitle, validateAddressDraft, type AddressDraft } from './address.ts';
import { DomainValidationError } from './domain.ts';

const draft: AddressDraft = { label: 'home', house: ' 12, Shivaji Nagar ', streetArea: ' Station Road, Khed ', landmark: '  ', latitude: 17.7189, longitude: 73.3961, locationSource: 'pin' };
const fieldsOf = (input: AddressDraft) => { try { validateAddressDraft(input); return {}; } catch (e) { assert.ok(e instanceof DomainValidationError); assert.equal(e.code, 'INVALID_ADDRESS'); return e.fields; } };

test('address drafts are trimmed, blank optional fields dropped, and custom names kept only for other', () => {
  assert.deepEqual(validateAddressDraft(draft), { label: 'home', house: '12, Shivaji Nagar', streetArea: 'Station Road, Khed', latitude: 17.7189, longitude: 73.3961, locationSource: 'pin' });
  assert.equal(validateAddressDraft({ ...draft, customLabel: 'Ignored' }).customLabel, undefined, 'home has no custom name');
  assert.equal(validateAddressDraft({ ...draft, label: 'other', customLabel: ' Aai ' }).customLabel, 'Aai');
  assert.equal(validateAddressDraft({ ...draft, label: 'other', customLabel: '  ' }).customLabel, undefined);
  assert.equal(validateAddressDraft({ ...draft, landmark: ' Near temple ' }).landmark, 'Near temple');
});

test('address drafts follow the database limits, field by field', () => {
  assert.deepEqual(Object.keys(fieldsOf({ ...draft, house: '  ', streetArea: '' })).sort(), ['house', 'streetArea']);
  assert.ok(fieldsOf({ ...draft, house: 'a'.repeat(121) }).house);
  assert.deepEqual(fieldsOf({ ...draft, house: 'a'.repeat(120) }), {});
  assert.ok(fieldsOf({ ...draft, streetArea: 'a'.repeat(201) }).streetArea);
  assert.ok(fieldsOf({ ...draft, landmark: 'a'.repeat(121) }).landmark);
  assert.ok(fieldsOf({ ...draft, label: 'other', customLabel: 'a'.repeat(41) }).customLabel);
  assert.ok(fieldsOf({ ...draft, house: 'Flat\n3' }).house, 'control characters are refused');
  assert.ok(fieldsOf({ ...draft, label: 'office' as never }).label);
  for (const bad of [{ latitude: 91 }, { longitude: -181 }, { latitude: Number.NaN }, { longitude: Number.POSITIVE_INFINITY }, { locationSource: 'typed' as never }]) {
    assert.ok(fieldsOf({ ...draft, ...bad }).location, JSON.stringify(bad));
  }
});

test('titles and one-line addresses', () => {
  assert.equal(addressTitle({ label: 'home' }), 'Home');
  assert.equal(addressTitle({ label: 'work', customLabel: 'x' }), 'Work');
  assert.equal(addressTitle({ label: 'other', customLabel: 'Aai' }), 'Aai');
  assert.equal(addressTitle({ label: 'other' }), 'Other');
  assert.equal(addressLine({ house: '12', streetArea: 'Station Road' }), '12, Station Road');
  assert.equal(addressLine({ house: '12', streetArea: 'Station Road', landmark: 'Near temple' }), '12, Station Road, Near temple');
});
