import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyProfileView, initialsOf, needsNameStep, profileFailure, validateProfileName, verifiedPhoneDisplay, type ProfileView } from './profile-model.ts';

const view = (change: Partial<ProfileView>): ProfileView => ({ ...emptyProfileView, ...change });
const saved = { fullName: 'Asha Patil' };

test('the name step is only for an account that just signed in and the server says has no name', () => {
  assert.equal(needsNameStep(view({ fresh: true, status: 'ready', profile: null })), true);
  assert.equal(needsNameStep(view({ fresh: true, status: 'ready', profile: saved })), false, 'a saved name is never asked for again');
  assert.equal(needsNameStep(view({ fresh: false, status: 'ready', profile: null })), false, 'a restored session is not interrupted');
  for (const status of ['idle', 'loading', 'error'] as const) assert.equal(needsNameStep(view({ fresh: true, status, profile: null })), false, `${status} never blocks the menu`);
  assert.equal(needsNameStep(emptyProfileView), false, 'another account starts with nothing');
});

test('names are trimmed and 1 to 120 characters, counting an emoji as one', () => {
  assert.equal(validateProfileName('  Asha  ').name, 'Asha'); assert.equal(validateProfileName('  Asha  ').error, '');
  assert.equal(validateProfileName('N').error, '');
  assert.equal(validateProfileName('N'.repeat(120)).error, '');
  assert.equal(validateProfileName('😀'.repeat(120)).error, '');
  for (const bad of ['', '   ', 'N'.repeat(121), '😀'.repeat(121)]) assert.equal(validateProfileName(bad).error, 'Enter a name from 1 to 120 characters.', bad.slice(0, 5));
});

test('failures give fixed friendly copy and never echo server text', () => {
  const failure = (code: string, text = 'secret server text') => profileFailure(Object.assign(new Error(text), { code }));
  assert.equal(failure('PROFILE_INVALID_NAME').kind, 'name');
  assert.equal(failure('SIGN_IN_REQUIRED').kind, 'sign-in');
  assert.equal(failure('PROFILE_REQUEST_FAILED').kind, 'retry');
  for (const code of ['PROFILE_INVALID_NAME', 'SIGN_IN_REQUIRED', 'SESSION_CHANGED', 'DEMO_MODE', 'CUSTOMER_REQUIRED', 'PROFILE_REQUEST_FAILED', 'OTHER']) assert.equal(failure(code).message.includes('secret'), false, code);
  assert.equal(profileFailure(new TypeError('Failed to fetch')).kind, 'retry'); assert.equal(profileFailure(null).kind, 'retry');
});

test('the drawer shows initials and the verified number as the design does', () => {
  assert.equal(initialsOf('  rohan   sawant kumar '), 'RS'); assert.equal(initialsOf('Asha'), 'A'); assert.equal(initialsOf(''), '');
  assert.equal(verifiedPhoneDisplay('919876543210'), '+91 98765 43210');
  assert.equal(verifiedPhoneDisplay('+919876543210'), '+91 98765 43210');
  assert.equal(verifiedPhoneDisplay('+44 20 7946 0000'), '+44 20 7946 0000', 'a number that is not an Indian mobile is shown as stored');
  assert.equal(verifiedPhoneDisplay(null), ''); assert.equal(verifiedPhoneDisplay(undefined), '');
});

test('a profile save on an account that is being deleted says so (#51)', () => {
  const failure = profileFailure(Object.assign(new Error('raw'), { code: 'ACCOUNT_LIFECYCLE_PENDING' }));
  assert.equal(failure.message, 'This account is being deleted, so it can no longer be changed.');
});
