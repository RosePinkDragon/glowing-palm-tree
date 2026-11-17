import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SavedAddress } from '@market/core';
import { addDeliveryAddressPrompt, addressErrorMessage, deliveryAddressLine, bothAppsNote, checkAddressForm, emptyAddressForm, formatDistance, formFromAddress, locationErrorMessage, locationRequiredMessage } from './address-model.ts';

const gps = { latitude: 17.72, longitude: 73.39, source: 'gps' as const };

test('distances read as metres, one-decimal km, then whole km', () => {
  assert.equal(formatDistance(null), '');
  assert.equal(formatDistance(-5), '');
  assert.equal(formatDistance(4), '10 m');
  assert.equal(formatDistance(847), '850 m');
  assert.equal(formatDistance(1200), '1.2 km');
  assert.equal(formatDistance(9960), '10.0 km');
  assert.equal(formatDistance(34000), '34 km');
});

test('the form needs a house, a street and a location, and says so per field', () => {
  const none = checkAddressForm(emptyAddressForm);
  assert.ok('errors' in none);
  assert.deepEqual(Object.keys(none.errors).sort(), ['house', 'location', 'streetArea']);
  assert.equal(none.errors.location, locationRequiredMessage);
  const located = checkAddressForm({ ...emptyAddressForm, location: gps });
  assert.ok('errors' in located && !located.errors.location && !!located.errors.house);
  const noLocation = checkAddressForm({ ...emptyAddressForm, house: '12', streetArea: 'Station Road' });
  assert.ok('errors' in noLocation); assert.deepEqual(Object.keys(noLocation.errors), ['location']);
});

test('a valid form becomes a trimmed draft; a custom name only counts for Other', () => {
  const home = checkAddressForm({ label: 'home', customLabel: 'Ignored', house: ' 12 ', streetArea: 'Station Road', landmark: '', location: gps });
  assert.ok('draft' in home); assert.deepEqual(home.draft, { label: 'home', house: '12', streetArea: 'Station Road', latitude: 17.72, longitude: 73.39, locationSource: 'gps' });
  const other = checkAddressForm({ label: 'other', customLabel: 'Aai\'s place', house: '12', streetArea: 'Station Road', landmark: 'Near temple', location: gps });
  assert.ok('draft' in other); assert.equal(other.draft.customLabel, 'Aai\'s place'); assert.equal(other.draft.landmark, 'Near temple');
  const long = checkAddressForm({ label: 'other', customLabel: 'x'.repeat(41), house: '12', streetArea: 'Station Road', landmark: '', location: gps });
  assert.ok('errors' in long && !!long.errors.customLabel);
});

test('editing starts from the saved values, including its pin', () => {
  const saved: SavedAddress = { id: 'a', version: 2, updatedAtISO: '2026-11-16T00:00:00Z', inArea: true, distanceM: 1200, label: 'other', customLabel: 'Aai', house: '1', streetArea: 'Road', latitude: 1, longitude: 2, locationSource: 'pin' };
  assert.deepEqual(formFromAddress(saved), { label: 'other', customLabel: 'Aai', house: '1', streetArea: 'Road', landmark: '', location: { latitude: 1, longitude: 2, source: 'pin' } });
});

test('service errors become friendly copy', () => {
  assert.equal(addressErrorMessage({ code: 'ADDRESS_CHANGED' }), 'This address was changed elsewhere. Reload and try again.');
  assert.match(addressErrorMessage({ code: 'ADDRESS_LIMIT' }), /up to 20 addresses/);
  assert.equal(addressErrorMessage(new Error('Could not save')), 'Could not save');
  assert.match(addressErrorMessage('x'), /Something went wrong/);
  assert.match(locationErrorMessage(Object.assign(new Error('x'), { code: 'INVALID_LOCATION_FIX' })), /accurate location/);
  assert.match(locationErrorMessage(new Error('Location permission is needed to check delivery.')), /permission is off/);
  assert.match(locationErrorMessage(null), /couldn't read your location/);
  assert.equal(bothAppsNote(['A', 'B']), 'Changes apply in both the A and B apps. Past orders keep the address they were delivered to.');
});

test('the top bar line names the selected address, or neutrally asks for one', () => {
  assert.equal(deliveryAddressLine(null), addDeliveryAddressPrompt);
  assert.equal(deliveryAddressLine(undefined), 'Add delivery address');
  assert.equal(deliveryAddressLine({ label: 'home', house: ' Flat 3 ', streetArea: 'Sai Krupa', customLabel: undefined }), 'Home · Flat 3, Sai Krupa');
  assert.equal(deliveryAddressLine({ label: 'work', house: '9', streetArea: 'MIDC', customLabel: 'ignored' }), 'Work · 9, MIDC');
  assert.equal(deliveryAddressLine({ label: 'other', house: '1', streetArea: 'Road', customLabel: 'Aai' }), 'Aai · 1, Road');
  assert.equal(deliveryAddressLine({ label: 'other', house: '1', streetArea: 'Road', customLabel: ' ' }), 'Other · 1, Road');
});
