import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressLine, addressTitle, remoteOrderFlag, validateAddressDraft, type AddressDraft } from './address.ts';
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
  assert.ok(fieldsOf({ ...draft, streetArea: 'Road\u202eKhed' }).streetArea, 'direction overrides are refused');
  assert.ok(fieldsOf({ ...draft, landmark: 'Near\u200btemple' }).landmark, 'zero-width spaces are refused');
  assert.ok(fieldsOf({ ...draft, house: 'Flat\u20283' }).house, 'line separators are refused like the database does');
  assert.ok(fieldsOf({ ...draft, house: 12 as never }).house, 'a non-string is a field error, not a crash');
  assert.deepEqual(fieldsOf({ ...draft, house: '\u0915\u094d\u200d\u0937' }), {}, 'ZWJ in Devanagari is allowed');
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

test('remote order flag: saved-address orders only, distance wording and rounding', () => {
  const address = { label: 'home', house: '1', streetArea: 'Road', locationSource: 'pin' };
  const flag = (placedFromDistanceM?: number | null, withAddress = true) => remoteOrderFlag({ ...(withAddress ? { address } : {}), placedFromDistanceM });
  assert.equal(flag(null), 'Customer location not confirmed');
  assert.equal(flag(undefined), 'Customer location not confirmed');
  assert.equal(flag(0), null);
  assert.equal(flag(150), null, 'at the threshold is near');
  assert.equal(flag(151), 'Ordered from 150 m away');
  assert.equal(flag(420), 'Ordered from 400 m away');
  assert.equal(flag(430), 'Ordered from 450 m away');
  assert.equal(flag(990), 'Ordered from 1.0 km away', 'metres never round up to 1000 m');
  assert.equal(flag(1000), 'Ordered from 1.0 km away');
  assert.equal(flag(2449), 'Ordered from 2.4 km away');
  assert.equal(flag(9949), 'Ordered from 9.9 km away');
  assert.equal(flag(9960), 'Ordered from 10 km away');
  assert.equal(flag(12400), 'Ordered from 12 km away');
  assert.equal(flag(12600), 'Ordered from 13 km away');
  assert.equal(flag(5000, false), null, 'legacy orders never get a flag');
  assert.equal(flag(null, false), null);
});
