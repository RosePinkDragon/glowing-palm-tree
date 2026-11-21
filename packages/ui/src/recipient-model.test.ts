import assert from 'node:assert/strict';
import test from 'node:test';
import { activeContact, chooseMode, editActive, emptyRecipient, mobileFieldValue, ownNameKey, parseOwnName, prefillOwn, restoreDelivery, serializeOwnName } from './recipient-model.ts';

test('mobileFieldValue gives the ten digits the Mobile field and validation accept', () => {
  assert.equal(mobileFieldValue('919876543210'), '9876543210', 'Supabase stores the phone without a plus');
  assert.equal(mobileFieldValue('+919876543210'), '9876543210');
  assert.equal(mobileFieldValue('+91 98765 43210'), '9876543210');
  assert.equal(mobileFieldValue('9876543210'), '9876543210');
  for (const bad of ['', null, undefined, '12345', '919876', '5876543210', '9198765432101', 'abc']) assert.equal(mobileFieldValue(bad), '', String(bad));
});

test('"Me" is prefilled from the remembered name and verified phone, and only into untouched fields', () => {
  const filled = prefillOwn(emptyRecipient, 'Asha', '919876543210');
  assert.deepEqual(filled.own, { name: 'Asha', phone: '9876543210' });
  assert.equal(filled.mode, 'me'); assert.deepEqual(filled.other, { name: '', phone: '' });
  assert.deepEqual(prefillOwn(emptyRecipient, null, '919876543210').own, { name: '', phone: '9876543210' }, 'first order: name left empty');
  const typed = editActive(emptyRecipient, { name: 'Typed', phone: '' });
  assert.deepEqual(prefillOwn(typed, 'Remembered', '919876543210').own, { name: 'Typed', phone: '9876543210' }, 'typed name kept, untouched phone filled');
  const cleared = editActive(prefillOwn(emptyRecipient, 'Asha', '919876543210'), { name: '', phone: '9876543210' });
  assert.equal(prefillOwn(cleared, 'Asha', '919876543210').own.name, '', 'a name the customer cleared stays cleared');
  assert.equal(prefillOwn(filled, null, 'bad'), filled, 'nothing to fill leaves the state as it was');
});

test('"Someone else" has its own empty fields and never touches the account holder\'s', () => {
  const me = prefillOwn(emptyRecipient, 'Asha', '919876543210');
  const other = chooseMode(me, 'other');
  assert.deepEqual(activeContact(other), { name: '', phone: '' }, 'empty by default');
  const typed = editActive(other, { name: 'Ravi', phone: '9000011111' });
  assert.deepEqual(activeContact(typed), { name: 'Ravi', phone: '9000011111' });
  assert.deepEqual(typed.own, { name: 'Asha', phone: '9876543210' }, 'own details unchanged');
  assert.deepEqual(typed.typed, me.typed, 'recipient typing does not block the own prefill');
  assert.deepEqual(prefillOwn(typed, 'Asha', '919876543210').other, { name: 'Ravi', phone: '9000011111' }, 'a late own prefill never fills the recipient');
  assert.deepEqual(activeContact(chooseMode(typed, 'me')), { name: 'Asha', phone: '9876543210' }, 'switching back restores the account holder');
  assert.deepEqual(chooseMode(chooseMode(typed, 'me'), 'other').other, { name: 'Ravi', phone: '9000011111' });
});

test('restoring an order attempt shows exactly what was sent', () => {
  const me = prefillOwn(emptyRecipient, 'Asha', '919876543210');
  const own = restoreDelivery(chooseMode(me, 'other'), { name: 'Asha', phone: '+919876543210' });
  assert.equal(own.mode, 'me'); assert.deepEqual(activeContact(own), { name: 'Asha', phone: '9876543210' });
  const someone = restoreDelivery(me, { name: 'Ravi', phone: '+919000011111' });
  assert.equal(someone.mode, 'other'); assert.deepEqual(activeContact(someone), { name: 'Ravi', phone: '9000011111' });
  assert.deepEqual(someone.own, me.own, 'own details are not overwritten by a recipient');
  const first = restoreDelivery(prefillOwn(emptyRecipient, null, '919876543210'), { name: 'Neha', phone: '+919876543210' });
  assert.equal(first.mode, 'me', 'a first-timer\'s typed name restores as their own');
  assert.equal(prefillOwn(first, 'Other', '919123456780').own.name, 'Neha', 'and is not replaced by a late prefill');
});

test('the remembered name is per user and unreadable values are ignored', () => {
  assert.equal(parseOwnName(serializeOwnName('  Rohan Sawant ')), 'Rohan Sawant');
  assert.equal(parseOwnName(serializeOwnName('N')), 'N', 'one character is a name (#45)');
  for (const raw of [null, '', 'not json', 'null', '"x"', '{"name":1}', '{}', '{"name":"  "}', JSON.stringify({ name: 'N'.repeat(121) })]) assert.equal(parseOwnName(raw), null, String(raw));
  assert.notEqual(ownNameKey('user-a'), ownNameKey('user-b'));
  assert.equal(serializeOwnName('Asha').includes('phone'), false, 'only the name is stored');
});
