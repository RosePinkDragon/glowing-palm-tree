import assert from 'node:assert/strict';
import test from 'node:test';
import { clockFromDatabase, formatClock, hoursLabel, indiaMinutes, isOpenNow, opensAtLabel, validateOpeningHours, type OpeningHours } from './index.ts';

// India is UTC+05:30 all year, so 09:00 IST is 03:30 UTC.
const at = (ist: string) => new Date(`2026-11-26T${ist}+05:30`);
const ammu = { openingHours: { opensAt: '09:00', closesAt: '19:30' } };
const kokani = { openingHours: { opensAt: '11:00', closesAt: '00:00' } };

test('Ammu Sammu 09:00 to 19:30: just before opening, at opening, just before closing, at closing', () => {
  assert.equal(isOpenNow(ammu, at('08:59:59')), false);
  assert.equal(isOpenNow(ammu, at('08:59:59.999')), false);
  assert.equal(isOpenNow(ammu, at('09:00:00')), true);
  assert.equal(isOpenNow(ammu, at('19:29:59')), true);
  assert.equal(isOpenNow(ammu, at('19:29:59.999')), true);
  assert.equal(isOpenNow(ammu, at('19:30:00')), false);
  assert.equal(isOpenNow(ammu, at('00:00:00')), false);
  assert.equal(isOpenNow(ammu, at('23:59:59')), false);
});

test('Kokani Dine Inn 11:00 to midnight: the window ends at 00:00 and nothing crosses into the next day', () => {
  assert.equal(isOpenNow(kokani, at('10:59:59')), false);
  assert.equal(isOpenNow(kokani, at('11:00:00')), true);
  assert.equal(isOpenNow(kokani, at('23:59:59')), true);
  assert.equal(isOpenNow(kokani, new Date('2026-11-27T00:00:00+05:30')), false);
  assert.equal(isOpenNow(kokani, new Date('2026-11-27T00:00:01+05:30')), false);
  assert.equal(isOpenNow(kokani, new Date('2026-11-27T03:00:00+05:30')), false);
});

test('no hours (null or missing) means open all day', () => {
  for (const ist of ['00:00:00', '03:00:00', '12:00:00', '23:59:59']) {
    assert.equal(isOpenNow({ openingHours: null }, at(ist)), true);
    assert.equal(isOpenNow({}, at(ist)), true);
  }
});

test('the window is read in India time whatever the date or the device zone', () => {
  // 18:30 UTC on the 25th is 00:00 IST on the 26th; 03:30 UTC is 09:00 IST.
  assert.equal(isOpenNow(ammu, new Date('2026-11-26T03:30:00Z')), true);
  assert.equal(isOpenNow(ammu, new Date('2026-11-26T03:29:59Z')), false);
  assert.equal(isOpenNow(kokani, new Date('2026-11-25T18:30:00Z')), false);
  assert.equal(indiaMinutes(new Date('2026-11-25T18:30:00Z')), 0);
  assert.equal(indiaMinutes(new Date('1969-12-31T18:29:00Z')), 1439);
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(isOpenNow(ammu, at('09:00:00')), true);
      assert.equal(isOpenNow(ammu, at('19:30:00')), false);
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('malformed hours fail closed', () => {
  assert.equal(isOpenNow({ openingHours: { opensAt: '9am', closesAt: '19:30' } }, at('12:00:00')), false);
  assert.equal(isOpenNow({ openingHours: { opensAt: '09:00', closesAt: '24:00' } }, at('12:00:00')), false);
});

test('validateOpeningHours mirrors the database: one window per day, 24:00 is midnight', () => {
  const ok = (a: string | null, b: string | null): OpeningHours | null => { const r = validateOpeningHours(a, b); assert.deepEqual(r.errors, {}); return r.hours; };
  assert.deepEqual(ok('09:00', '19:30'), { opensAt: '09:00', closesAt: '19:30' });
  assert.deepEqual(ok('11:00', '24:00'), { opensAt: '11:00', closesAt: '00:00' });
  assert.deepEqual(ok('11:00', '00:00'), { opensAt: '11:00', closesAt: '00:00' });
  assert.deepEqual(ok('00:00', '12:00'), { opensAt: '00:00', closesAt: '12:00' });
  assert.equal(ok(null, null), null);
  assert.deepEqual(validateOpeningHours('09:00', null).errors, { openingHours: 'Set both an opening and a closing time, or neither.' });
  assert.deepEqual(Object.keys(validateOpeningHours(null, '19:30').errors), ['openingHours']);
  for (const [a, b] of [['09:00', '09:00'], ['19:30', '09:00'], ['22:00', '02:00'], ['00:00', '00:00'], ['00:00', '24:00']]) assert.deepEqual(Object.keys(validateOpeningHours(a, b).errors), ['closesAt'], `${a} to ${b}`);
  for (const bad of ['9:00', '09:00:30', '24:00', '25:00', '09:60', '', 'nine', '09.00']) assert.deepEqual(Object.keys(validateOpeningHours(bad, '19:30').errors), ['opensAt'], bad);
  assert.deepEqual(Object.keys(validateOpeningHours('09:00', '19:60').errors), ['closesAt']);
});

test('labels are ready for the customer and owner screens', () => {
  assert.equal(opensAtLabel(ammu), 'Opens at 9 am');
  assert.equal(opensAtLabel(kokani), 'Opens at 11 am');
  assert.equal(opensAtLabel({ openingHours: { opensAt: '07:30', closesAt: '12:00' } }), 'Opens at 7:30 am');
  assert.equal(opensAtLabel({ openingHours: null }), null);
  assert.deepEqual(['00:00', '00:05', '09:00', '12:00', '12:30', '13:00', '19:30', '23:59'].map(formatClock), ['12 am', '12:05 am', '9 am', '12 pm', '12:30 pm', '1 pm', '7:30 pm', '11:59 pm']);
  assert.equal(hoursLabel(ammu), '9 am to 7:30 pm');
  assert.equal(hoursLabel(kokani), '11 am to 12 am (midnight)');
  assert.equal(hoursLabel({}), null);
});

test('clockFromDatabase keeps whole minutes from the HH:MM:SS the server returns', () => {
  assert.equal(clockFromDatabase('09:00:00'), '09:00');
  assert.equal(clockFromDatabase('00:00:00'), '00:00');
  assert.equal(clockFromDatabase('19:30'), '19:30');
  for (const bad of ['09:00:30', '24:00:00', '9:00:00', null, 5, undefined]) assert.equal(clockFromDatabase(bad), null);
});
