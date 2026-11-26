import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyAddressForm, type AddressForm } from './address-model.ts';
import type { DishDraft } from './menu-model.ts';
import type { DetailsForm } from './restaurant-details-model.ts';
import { addressIsDirty, detailsAreDirty, discardCopy, dishIsDirty } from './discard-model.ts';

const address: AddressForm = { label: 'home', customLabel: '', house: 'Flat 3', streetArea: 'Bharne Naka', landmark: '', location: { latitude: 17.7172, longitude: 73.3961, source: 'gps' } };

test('an untouched or empty new address is clean', () => {
  assert.equal(addressIsDirty(emptyAddressForm, { ...emptyAddressForm }), false);
  assert.equal(addressIsDirty(address, { ...address }), false);
});

test('address edits are dirty, but whitespace, float noise and a hidden custom name are not', () => {
  assert.equal(addressIsDirty(address, { ...address, house: 'Flat 4' }), true);
  assert.equal(addressIsDirty(emptyAddressForm, { ...emptyAddressForm, landmark: 'Temple' }), true);
  assert.equal(addressIsDirty(address, { ...address, label: 'work' }), true);
  assert.equal(addressIsDirty(address, { ...address, location: null }), true);
  assert.equal(addressIsDirty(address, { ...address, location: { latitude: 17.7172001, longitude: 73.3961, source: 'gps' } }), false, 'a 0.1 mm difference is the same pin');
  assert.equal(addressIsDirty(address, { ...address, location: { latitude: 17.72, longitude: 73.3961, source: 'gps' } }), true, 'a new fix is a change');
  assert.equal(addressIsDirty(address, { ...address, house: '  Flat 3 ', landmark: '   ' }), false);
  assert.equal(addressIsDirty(address, { ...address, customLabel: 'Aai' }), false, 'the name only counts for the Other label');
  assert.equal(addressIsDirty({ ...address, label: 'other' }, { ...address, label: 'other', customLabel: 'Aai' }), true);
  assert.equal(addressIsDirty({ ...address, house: 'Flat 4' }, { ...address, house: 'Flat 4' }), false, 'after a save the saved form is the new baseline');
});

const dish: DishDraft = { id: 'd1', name: 'Fish thali', description: 'With rice', categoryId: 'c1', price: '250', diet: 'non_veg', isAvailable: true, isFeatured: false, isDemo: false };

test('dish drafts compare normalized fields', () => {
  assert.equal(dishIsDirty(dish, { ...dish }), false);
  assert.equal(dishIsDirty(dish, { ...dish, price: '260' }), true);
  assert.equal(dishIsDirty(dish, { ...dish, price: ' 250.00 ' }), false, 'the same price written differently');
  assert.equal(dishIsDirty(dish, { ...dish, price: '25o' }), true);
  assert.equal(dishIsDirty(dish, { ...dish, name: ' Fish thali ', description: 'With rice  ' }), false);
  assert.equal(dishIsDirty(dish, { ...dish, name: 'Fish Thali' }), true);
  for (const change of [{ categoryId: 'c2' }, { diet: 'veg' as const }, { isAvailable: false }, { isFeatured: true }, { isDemo: true }]) assert.equal(dishIsDirty(dish, { ...dish, ...change }), true, JSON.stringify(change));
});

test('making a sample dish real is an unsaved change until saved (#201)', () => {
  const sample = { ...dish, isDemo: true };
  assert.equal(dishIsDirty(sample, { ...sample }), false);
  assert.equal(dishIsDirty(sample, { ...sample, isDemo: false, isAvailable: false }), true);
  const saved = { ...sample, isDemo: false, isAvailable: false };
  assert.equal(dishIsDirty(saved, { ...saved }), false, 'the saved conversion becomes the baseline');
});

test('a new dish is clean until something is typed, and a saved draft becomes the baseline', () => {
  const blank: DishDraft = { name: '', description: '', categoryId: '', price: '', diet: null, isAvailable: true, isFeatured: false, isDemo: false };
  assert.equal(dishIsDirty(blank, { ...blank }), false);
  assert.equal(dishIsDirty(blank, { ...blank, name: 'x' }), true);
  assert.equal(dishIsDirty(blank, { ...blank, name: '   ' }), false);
  const typed = { ...blank, name: 'Sol kadhi', price: '40' };
  assert.equal(dishIsDirty(typed, { ...typed }), false);
});

const details: DetailsForm = { contactPhone: '+91 98200 44556', whatsappPhone: '', deliveryFee: '30', minOrder: '150.50' };

test('restaurant details compare phone digits and amounts, not their spelling', () => {
  assert.equal(detailsAreDirty(details, { ...details }), false);
  assert.equal(detailsAreDirty(details, { ...details, contactPhone: '+919820044556' }), false);
  assert.equal(detailsAreDirty(details, { ...details, deliveryFee: '30.00' }), false);
  assert.equal(detailsAreDirty(details, { ...details, deliveryFee: '35' }), true);
  assert.equal(detailsAreDirty(details, { ...details, minOrder: '150.5' }), false);
  assert.equal(detailsAreDirty(details, { ...details, whatsappPhone: '+91 98200 44557' }), true);
  assert.equal(detailsAreDirty(details, { ...details, contactPhone: '+91 98200 4455' }), true);
  assert.equal(detailsAreDirty(details, { ...details, minOrder: 'abc' }), true);
});

test('the confirmation names the consequence and the safe choice', () => {
  assert.equal(discardCopy.title, 'Discard changes?');
  assert.equal(discardCopy.keep, 'Keep editing');
  assert.match(discardCopy.message, /lost/);
});
