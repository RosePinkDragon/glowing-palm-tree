import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOpenNow } from '@market/core';
import { hoursClosedMessage, hoursClosedParts, hoursSignature, hoursState, msUntilBoundary, nextBoundaryMs, openHoursFact, refusalMs } from './hours-model.ts';

// India time is UTC+05:30: 09:00 IST on 2 Dec 2026 is 03:30 UTC.
const ist = (clock: string, day = '2026-12-02') => Date.parse(`${day}T${clock.length === 5 ? `${clock}:00` : clock}+05:30`);
const ammu = { openingHours: { opensAt: '09:00', closesAt: '19:30' } }, kokani = { openingHours: { opensAt: '11:00', closesAt: '00:00' } };

test('the next boundary is the next opening or closing instant in India time', () => {
  assert.equal(nextBoundaryMs(ammu, ist('06:00')), ist('09:00'), 'before opening: opens');
  assert.equal(nextBoundaryMs(ammu, ist('08:59:59')), ist('09:00'));
  assert.equal(nextBoundaryMs(ammu, ist('09:00')), ist('19:30'), 'at opening the next change is closing');
  assert.equal(nextBoundaryMs(ammu, ist('19:29:59')), ist('19:30'));
  assert.equal(nextBoundaryMs(ammu, ist('19:30')), ist('09:00', '2026-12-03'), 'at closing the next change is tomorrow morning');
  assert.equal(nextBoundaryMs(ammu, ist('23:59:59')), ist('09:00', '2026-12-03'));
  assert.equal(nextBoundaryMs(kokani, ist('12:00')), ist('00:00', '2026-12-03'), 'midnight closing is the end of the day');
  assert.equal(nextBoundaryMs(kokani, ist('00:00', '2026-12-03')), ist('11:00', '2026-12-03'), 'at midnight the next change is the opening');
  assert.equal(nextBoundaryMs(kokani, ist('05:00')), ist('11:00'));
});

test('the boundary is always when isOpenNow changes, across a whole day of instants', () => {
  for (const business of [ammu, kokani, { openingHours: { opensAt: '00:00', closesAt: '23:59' } }]) {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = ist('00:00') + minute * 60_000 + 13_000, at = nextBoundaryMs(business, now)!;
      assert.ok(at > now, 'strictly later');
      assert.notEqual(isOpenNow(business, new Date(at)), isOpenNow(business, new Date(at - 1)), `${JSON.stringify(business)} flips at the boundary after ${minute}`);
      assert.equal(isOpenNow(business, new Date(at - 1)), isOpenNow(business, new Date(now)), 'and nothing changes before it');
    }
  }
});

test('no hours never change, and the wait is bounded', () => {
  assert.equal(nextBoundaryMs({ openingHours: null }, ist('10:00')), null); assert.equal(nextBoundaryMs({}, ist('10:00')), null); assert.equal(nextBoundaryMs(null, 1), null);
  assert.equal(nextBoundaryMs({ openingHours: { opensAt: 'x', closesAt: '19:00' } }, ist('10:00')), null, 'malformed hours: the server decides');
  assert.equal(msUntilBoundary(ammu, ist('08:00')), 3_600_000);
  assert.equal(msUntilBoundary(ammu, ist('08:59:59.9')), 250, 'never a busy loop');
  assert.equal(msUntilBoundary(ammu, ist('19:30')), 48_600_000, 'at closing: 13.5 hours to tomorrow morning, well inside a timer'); assert.ok(msUntilBoundary(kokani, ist('00:00', '2026-12-03'))! <= 86_400_000);
  assert.equal(msUntilBoundary(null, 5), null);
});

test('hours state: open within the window, closed with the opening label outside it, null hours always open', () => {
  assert.deepEqual(hoursState(ammu, ist('12:00'), null), { open: true, opensAtLabel: null });
  assert.deepEqual(hoursState(ammu, ist('08:59'), null), { open: false, opensAtLabel: 'Opens at 9 am' });
  assert.deepEqual(hoursState(ammu, ist('19:30'), null), { open: false, opensAtLabel: 'Opens at 9 am' });
  assert.deepEqual(hoursState(kokani, ist('00:00'), null), { open: false, opensAtLabel: 'Opens at 11 am' });
  assert.deepEqual(hoursState({ openingHours: null }, ist('03:00'), null), { open: true, opensAtLabel: null });
  assert.deepEqual(hoursState(null, ist('03:00'), null), { open: true, opensAtLabel: null }, 'no restaurant yet: the loading state, not the hours, decides');
});

test('a server refusal closes a restaurant the device clock thinks is open, but only for those hours and only briefly', () => {
  const now = ist('12:00'), refusal = { signature: hoursSignature(ammu), at: now, label: 'Opens at 9 am' };
  assert.deepEqual(hoursState(ammu, now + 1000, refusal), { open: false, opensAtLabel: 'Opens at 9 am' });
  assert.equal(hoursState(ammu, now + refusalMs, refusal).open, true, 'it expires, so a corrected clock is not blocked all day');
  assert.equal(hoursState({ openingHours: { opensAt: '09:00', closesAt: '20:00' } }, now + 1000, refusal).open, true, 'edited hours clear it');
  assert.equal(hoursState({ ...ammu }, now + 1000, refusal).open, false, 'reloading the same hours does not (no reload loop)');
  assert.equal(hoursState(ammu, now - 1, refusal).open, true, 'a refusal from the future (clock moved back) is ignored');
});

test('copy', () => {
  assert.equal(openHoursFact(ammu), 'Open 9 am to 7:30 pm'); assert.equal(openHoursFact(kokani), 'Open 11 am to 12 am (midnight)');
  assert.equal(openHoursFact({ openingHours: null }), null); assert.equal(openHoursFact(null), null);
  assert.deepEqual(hoursClosedParts('ammu-sammu', 'Opens at 9 am'), { lead: 'Closed now · Opens at 9 am', rest: 'You can still look at the menu.' });
  assert.equal(hoursClosedParts('kokani-dine-inn', null).lead, 'Closed now');
  assert.equal(hoursClosedMessage('kokani-dine-inn', 'Opens at 11 am'), 'Closed now · Opens at 11 am. Browse the menu and order when the kitchen opens.');
  assert.equal(hoursSignature(null), 'all-day'); assert.equal(hoursSignature(ammu), '09:00-19:30');
});
