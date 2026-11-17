import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError } from '@market/services';
import { checkOwnerName, isSaveLock, ownerNameChanged, ownerNameProblem } from './owner-name-model.ts';

test('names are trimmed and empty text is refused', () => {
  assert.deepEqual(checkOwnerName('  Suresh Pawar '), { ok: true, name: 'Suresh Pawar' });
  for (const text of ['', '   ']) assert.deepEqual(checkOwnerName(text), { ok: false, message: 'Enter your name.' });
});

test('length counts code points like the server, not UTF-16 units', () => {
  assert.ok(checkOwnerName('a'.repeat(60)).ok);
  assert.ok(!checkOwnerName('a'.repeat(61)).ok);
  assert.ok(checkOwnerName('😀'.repeat(60)).ok);
  assert.ok(!checkOwnerName('😀'.repeat(61)).ok);
});

test('other rules are left to the server', () => {
  assert.ok(checkOwnerName('Ana​nd').ok);
});

test('changed compares the trimmed text with the stored name', () => {
  assert.equal(ownerNameChanged(' Suresh ', 'Suresh'), false);
  assert.equal(ownerNameChanged('Suresh P', 'Suresh'), true);
  assert.equal(ownerNameChanged('', null), false);
  assert.equal(ownerNameChanged('Suresh', null), true);
});

test('service errors map to owner messages', () => {
  const invalid = ownerNameProblem(new ServiceError('INVALID_OWNER_NAME', 'Enter a trimmed owner name.'));
  assert.deepEqual(invalid, { kind: 'invalid', message: 'Enter a trimmed owner name.' });
  assert.equal(ownerNameProblem(new ServiceError('ADMIN_REQUIRED', 'x')).kind, 'denied');
  assert.equal(ownerNameProblem(new ServiceError('SESSION_CHANGED', 'x')).kind, 'reload');
  assert.match(ownerNameProblem(new ServiceError('SESSION_CHANGED', 'x')).message, /Reload/);
  assert.equal(ownerNameProblem(new ServiceError('OWNER_NAME_SAVE_FAILED', 'x')).kind, 'failed');
  const retry = 'Could not save your name. Check your connection and try again.';
  assert.deepEqual(ownerNameProblem(new Error('boom: secret detail')), { kind: 'failed', message: retry });
  assert.deepEqual(ownerNameProblem(new ServiceError('OWNER_PROFILE_REQUEST_FAILED', 'raw transport text')), { kind: 'failed', message: retry });
  assert.deepEqual(ownerNameProblem('weird'), { kind: 'failed', message: retry });
  assert.equal(isSaveLock(ownerNameProblem(new ServiceError('ADMIN_REQUIRED', 'x'))), true);
  assert.equal(isSaveLock(ownerNameProblem(new ServiceError('SESSION_CHANGED', 'x'))), true);
  assert.equal(isSaveLock(ownerNameProblem(new Error('x'))), false);
  assert.equal(isSaveLock(null), false);
});
