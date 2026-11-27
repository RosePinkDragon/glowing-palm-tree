import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@market/services';
import { ORDER_RECORD_RETENTION_COPY, accountPendingCopy, clearLocalKeys, deleteAccountCopy, deletedNotice, deletionFailure } from './account-deletion-model.ts';

test('the warning names both restaurants, the retention copy once, and says it cannot be undone', () => {
  const copy = deleteAccountCopy('Ammu Sammu', 'Kokani Dine Inn');
  assert.equal(copy.title, 'Delete your account?');
  assert.match(copy.intro, /both the Ammu Sammu and Kokani Dine Inn apps\. It can't be undone\./);
  assert.equal(copy.points.filter(point => point.text.includes(ORDER_RECORD_RETENTION_COPY)).length, 1, 'the period appears in one place, from one constant');
  assert.equal(ORDER_RECORD_RETENTION_COPY, 'up to 1 year');
  assert.ok(copy.points.some(point => /Deleted right away/.test(point.heading) && /name, saved addresses and notifications/.test(point.text)));
  assert.ok(copy.points.some(point => /Active orders/.test(point.heading)));
  assert.notEqual(copy.confirm, copy.keep);
});

test('the final state never says the deletion is finished', () => {
  assert.match(deletedNotice.title, /being deleted/);
  assert.doesNotMatch(`${deletedNotice.title} ${deletedNotice.message}`, /has been deleted|is deleted|fully deleted|permanently deleted/i);
  assert.match(accountPendingCopy, /being deleted/);
});

test('every failure maps to its own friendly copy, never server text', () => {
  const code = (value: string, cause?: unknown) => new ServiceError(value, 'raw server text private', cause);
  assert.deepEqual([deletionFailure(code('ACCOUNT_HAS_ACTIVE_ORDER')).kind, deletionFailure(code('ACCOUNT_HAS_ACTIVE_ORDER')).retry], ['active-order', false]);
  assert.equal(deletionFailure(code('ONLY_OWNER')).kind, 'only-owner');
  assert.equal(deletionFailure(code('SIGN_IN_REQUIRED')).kind, 'sign-in');
  assert.equal(deletionFailure(code('SESSION_CHANGED')).kind, 'sign-in');
  assert.equal(deletionFailure(code('ACCOUNT_LIFECYCLE_PENDING')).kind, 'already-pending');
  assert.deepEqual([deletionFailure(code('ACCOUNT_DELETION_FAILED', new TypeError('Failed to fetch'))).kind, deletionFailure(code('ACCOUNT_DELETION_FAILED', new TypeError('Failed to fetch'))).retry], ['offline', true]);
  assert.deepEqual([deletionFailure(code('ACCOUNT_DELETION_FAILED', { message: 'boom' })).kind, deletionFailure(code('INVALID_RESPONSE')).retry], ['retry', true]);
  for (const error of [code('ACCOUNT_HAS_ACTIVE_ORDER'), code('ONLY_OWNER'), code('SIGN_IN_REQUIRED'), code('ACCOUNT_DELETION_FAILED', { message: 'internal' }), 'string', null]) {
    const failure = deletionFailure(error); assert.doesNotMatch(`${failure.title} ${failure.message}`, /raw server text|internal|private/);
  }
});

test('clearing the phone removes every key, once, and a blocked key neither stops the rest nor throws', async () => {
  const removed: string[] = [];
  const failed = await clearLocalKeys({ removeItem: async key => { if (key === 'b') throw new Error('blocked'); removed.push(key); } }, ['a', 'b', 'c', 'a']);
  assert.deepEqual(removed, ['a', 'c']);
  assert.deepEqual(failed, ['b']);
  assert.deepEqual(await clearLocalKeys({ removeItem: async () => {} }, []), []);
});
