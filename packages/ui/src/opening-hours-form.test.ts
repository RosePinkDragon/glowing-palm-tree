import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clockText, hoursFormFrom, hoursPreview, normalizeHours, parseClockText, validateHoursForm } from './opening-hours-form.ts';
import { hoursAreDirty } from './discard-model.ts';

test('times are read the way owners type them', () => {
  for (const [typed, clock] of [['09:00', '09:00'], ['9', '09:00'], ['9:30', '09:30'], ['930', '09:30'], ['7:30 pm', '19:30'], ['7.30pm', '19:30'], ['7 PM', '19:00'], ['12 am', '00:00'], ['12 pm', '12:00'], ['12:15am', '00:15'], ['noon', '12:00'], ['Midnight', '00:00'], [' midnight ', '00:00'], ['24:00', '24:00'], ['23:59', '23:59'], ['0', '00:00']] as const) assert.equal(parseClockText(typed), clock, typed);
  for (const bad of ['', 'abc', '25:00', '24:30', '9:75', '13 pm', '0 am', '7:5', '9 30 pm x']) assert.equal(parseClockText(bad), bad.trim(), `${bad} is left as typed so validation can refuse it`);
});

test('a form from stored hours shows 24-hour times and Midnight; no hours is Open all day', () => {
  assert.deepEqual(hoursFormFrom({ opensAt: '09:00', closesAt: '19:30' }), { allDay: false, opensAt: '09:00', closesAt: '19:30' });
  assert.deepEqual(hoursFormFrom({ opensAt: '11:00', closesAt: '00:00' }), { allDay: false, opensAt: '11:00', closesAt: 'Midnight' });
  assert.deepEqual(hoursFormFrom(null), { allDay: true, opensAt: '', closesAt: '' });
  assert.equal(clockText('00:00', true), 'Midnight'); assert.equal(clockText('00:00'), '00:00');
});

test('valid hours become the exact input with the loaded version', () => {
  assert.deepEqual(validateHoursForm({ allDay: false, opensAt: '9 am', closesAt: '7:30 pm' }, 4), { ok: true, input: { opensAt: '09:00', closesAt: '19:30', expectedVersion: 4 } });
  assert.deepEqual(validateHoursForm({ allDay: false, opensAt: '11:00', closesAt: 'Midnight' }, 4), { ok: true, input: { opensAt: '11:00', closesAt: '00:00', expectedVersion: 4 } });
  assert.deepEqual(validateHoursForm({ allDay: false, opensAt: '11:00', closesAt: '24:00' }, 4), { ok: true, input: { opensAt: '11:00', closesAt: '00:00', expectedVersion: 4 } });
  assert.deepEqual(validateHoursForm({ allDay: true, opensAt: 'junk', closesAt: '' }, 7), { ok: true, input: { opensAt: null, closesAt: null, expectedVersion: 7 } }, 'Open all day ignores the boxes');
});

test('invalid hours name the field and send nothing', () => {
  const errors = (opensAt: string, closesAt: string) => { const result = validateHoursForm({ allDay: false, opensAt, closesAt }, 1); assert.equal(result.ok, false); return result.ok ? {} : result.errors; };
  assert.deepEqual(Object.keys(errors('', '')), ['opensAt', 'closesAt']);
  assert.equal(errors('', '19:00').opensAt, 'Enter the opening time, for example 09:00.');
  assert.equal(errors('09:00', '').closesAt, 'Enter the closing time, for example 19:30, or Midnight.');
  assert.match(errors('banana', '19:00').opensAt!, /opening time/);
  assert.match(errors('09:00', '25:00').closesAt!, /closing time/);
  assert.match(errors('19:00', '09:00').closesAt!, /after opening/, 'a window never crosses midnight');
  assert.match(errors('09:00', '09:00').closesAt!, /after opening/);
  assert.match(errors('Midnight', 'Midnight').closesAt!, /after opening/);
});

test('the preview reads back the window, or says nothing while it is not valid', () => {
  assert.equal(hoursPreview({ allDay: false, opensAt: '09:00', closesAt: '19:30' }), 'Customers can order from 9 am to 7:30 pm, India time.');
  assert.equal(hoursPreview({ allDay: false, opensAt: '11:00', closesAt: 'midnight' }), 'Customers can order from 11 am to midnight, India time.');
  assert.equal(hoursPreview({ allDay: false, opensAt: '', closesAt: '19:00' }), null);
  assert.match(hoursPreview({ allDay: true, opensAt: '', closesAt: '' })!, /^Open all day/);
});

test('hours are dirty only when the window or Open all day really changed (#200)', () => {
  const saved = hoursFormFrom({ opensAt: '09:00', closesAt: '19:30' });
  assert.equal(hoursAreDirty(saved, { ...saved }), false);
  assert.equal(hoursAreDirty(saved, { ...saved, opensAt: '9:00 am', closesAt: '7:30pm' }), false, 'the same times typed another way');
  assert.equal(hoursAreDirty(saved, { ...saved, opensAt: ' 09:00 ' }), false, 'whitespace');
  assert.equal(hoursAreDirty(saved, { ...saved, opensAt: '09:15' }), true);
  assert.equal(hoursAreDirty(saved, { ...saved, closesAt: 'Midnight' }), true);
  assert.equal(hoursAreDirty(saved, { ...saved, allDay: true }), true);
  assert.equal(hoursAreDirty(hoursFormFrom(null), { allDay: true, opensAt: '10:00', closesAt: '12:00' }), false, 'boxes hidden by Open all day are not changes');
  assert.equal(hoursAreDirty(hoursFormFrom(null), { allDay: false, opensAt: '', closesAt: '' }), true, 'switching Open all day off is a change');
  assert.equal(hoursAreDirty(hoursFormFrom({ opensAt: '11:00', closesAt: '00:00' }), { allDay: false, opensAt: '11:00', closesAt: '24:00' }), false, 'midnight has one meaning');
  assert.deepEqual(normalizeHours({ allDay: false, opensAt: '9', closesAt: 'Midnight' }), { allDay: false, opensAt: '09:00', closesAt: '00:00' });
});
