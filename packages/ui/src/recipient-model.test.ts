import assert from 'node:assert/strict';
import test from 'node:test';
import { activeContact, chooseMode, editActive, emptyRecipient, mobileFieldValue, nameToSaveAfterOrder, ownNameKey, parseOwnName, planOwnName, prefillOwn, restoreDelivery, type ProfileRead } from './recipient-model.ts';

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

test('the older device name is read per user, and unreadable values are ignored', () => {
  const stored = (name: unknown) => JSON.stringify({ name });
  assert.equal(parseOwnName(stored('  Rohan Sawant ')), 'Rohan Sawant');
  assert.equal(parseOwnName(stored('N')), 'N', 'one character is a name (#45)');
  assert.equal(parseOwnName(stored('😀'.repeat(120))), '😀'.repeat(120), 'characters are counted as the database counts them');
  for (const raw of [null, '', 'not json', 'null', '"x"', '{"name":1}', '{}', '{"name":"  "}', stored('N'.repeat(121)), stored('😀'.repeat(121))]) assert.equal(parseOwnName(raw), null, String(raw));
  assert.notEqual(ownNameKey('user-a'), ownNameKey('user-b'));
});

test('a profile name that arrives after a manual edit never replaces it, and a refreshed name updates untouched fields', () => {
  const loaded = prefillOwn(emptyRecipient, 'Asha', '919876543210');
  assert.equal(prefillOwn(loaded, 'Asha Patil', '919876543210').own.name, 'Asha Patil', 'an untouched name follows the profile (for example after Edit profile)');
  const edited = editActive(loaded, { name: 'Asha P', phone: '9876543210' });
  assert.equal(prefillOwn(edited, 'Someone New', '919876543210'), edited, 'a manual edit wins over every later profile refresh');
  const early = editActive(emptyRecipient, { name: 'Typed first', phone: '' });
  assert.equal(prefillOwn(early, 'Profile Name', null).own.name, 'Typed first', 'typing before the profile loads is kept');
  assert.equal(prefillOwn(chooseMode(emptyRecipient, 'other'), 'Profile Name', null).other.name, '', 'the recipient is never filled from the profile');
});

const read = (status: ProfileRead['status'], name: string | null = null): ProfileRead => ({ status, name });
const legacy = JSON.stringify({ name: 'Old Device Name' });

test('migration decision table: the device name is used only when the profile confirmed none', () => {
  // [profile read, raw device key] -> [name shown in "Me", remove the key now]
  const table: Array<[string, ProfileRead, string | null, string | null, boolean]> = [
    ['profile has a name, no old key', read('ready', 'Asha'), null, 'Asha', false],
    ['profile has a name, old key: profile wins, key is obsolete', read('ready', 'Asha'), legacy, 'Asha', true],
    ['profile has a name, unusable key: still removed', read('ready', 'Asha'), 'junk', 'Asha', true],
    ['confirmed none, no key', read('ready'), null, null, false],
    ['confirmed none, usable key: migrate (key kept until the name is saved)', read('ready'), legacy, 'Old Device Name', false],
    ['confirmed none, unusable key: nothing to migrate, remove', read('ready'), 'junk', null, true],
    ['confirmed none, 121-character key: unusable, remove', read('ready'), JSON.stringify({ name: 'N'.repeat(121) }), null, true],
    ['unavailable (error): never use or touch the key', read('error'), legacy, null, false],
    ['still loading', read('loading'), legacy, null, false],
    ['not read yet', read('idle'), legacy, null, false],
    ['unavailable with a stale name in the view: ignored', read('error', 'Stale'), legacy, null, false],
  ];
  for (const [label, profile, raw, prefill, removeKey] of table) assert.deepEqual(planOwnName(profile, raw), { prefill, removeKey }, label);
});

test('the profile is saved after an order only for "Me", only when confirmed empty, and only with a usable name', () => {
  assert.equal(nameToSaveAfterOrder(true, read('ready'), '  Asha Patil '), 'Asha Patil', 'trimmed');
  assert.equal(nameToSaveAfterOrder(true, read('ready'), 'N'), 'N');
  assert.equal(nameToSaveAfterOrder(false, read('ready'), 'Ravi'), null, 'a recipient is never saved');
  assert.equal(nameToSaveAfterOrder(true, read('ready', 'Asha'), 'Asha P'), null, 'an existing profile name is never overwritten by an order');
  for (const status of ['idle', 'loading', 'error'] as const) assert.equal(nameToSaveAfterOrder(true, read(status), 'Asha'), null, `${status}: unavailable is not "no name"`);
  for (const bad of ['', '   ', 'N'.repeat(121)]) assert.equal(nameToSaveAfterOrder(true, read('ready'), bad), null, `unusable name ${bad.length}`);
});
