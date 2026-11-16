import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptPickedDate, addDaysISO, amountFontSize, minPickedDate, cancelledLabel, chipLabel, defaultPickedDate, deliveredLabel, deliveredNote, istDateISO, istYesterdayISO, outstandingNote, placedLabel, requestDate, scopeWord, shortDateLabel, stepPickedDate } from './today-model.ts';

const at = (iso: string) => Date.parse(iso);

test('the day is the India-time day, not the UTC or device day', () => {
  assert.equal(istDateISO(at('2026-11-13T18:29:59Z')), '2026-11-13'); // 23:59:59 IST
  assert.equal(istDateISO(at('2026-11-13T18:30:00Z')), '2026-11-14'); // midnight IST
  assert.equal(istDateISO(at('2026-11-13T00:00:00Z')), '2026-11-13'); // 05:30 IST
  assert.equal(istYesterdayISO(at('2026-11-13T18:30:00Z')), '2026-11-13');
  assert.equal(istYesterdayISO(at('2026-03-01T00:00:00+05:30')), '2026-02-28');
  assert.equal(addDaysISO('2028-03-01', -1), '2028-02-29');
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
});
test('chips and headings use short India-time dates', () => {
  const now = at('2026-11-13T10:00:00+05:30');
  assert.equal(shortDateLabel('2026-11-03'), '3 Nov');
  assert.equal(chipLabel('today', '', now), 'Today, 13 Nov');
  assert.equal(chipLabel('yesterday', '', now), 'Yesterday');
  assert.equal(chipLabel('date', '2026-11-10', now), 'Pick a date');
  assert.equal(shortDateLabel('nope'), 'nope');
});
test('requests omit the date for today and send the India-time day otherwise', () => {
  const now = at('2026-11-14T00:10:00+05:30');
  assert.equal(requestDate('today', '2026-11-10', now), undefined);
  assert.equal(requestDate('yesterday', '2026-11-10', now), '2026-11-13');
  assert.equal(requestDate('date', '2026-11-10', now), '2026-11-10');
});
test('picked dates must be real days no later than today', () => {
  const now = at('2026-11-13T10:00:00+05:30');
  assert.equal(acceptPickedDate('2026-11-13', now), '2026-11-13');
  assert.equal(acceptPickedDate('2026-11-14', now), null);
  assert.equal(acceptPickedDate('2026-02-30', now), null);
  assert.equal(acceptPickedDate('', now), null);
  assert.equal(stepPickedDate('2026-11-13', 1, now), '2026-11-13');
  assert.equal(stepPickedDate('2026-11-12', 1, now), '2026-11-13');
  assert.equal(stepPickedDate('2026-11-01', -1, now), '2026-10-31');
  assert.equal(defaultPickedDate(now), '2026-11-11');
});
test('date-scoped labels follow the selected day', () => {
  const now = at('2026-11-13T10:00:00+05:30');
  assert.equal(scopeWord('2026-11-13', now), 'today');
  assert.equal(scopeWord('2026-11-12', now), 'yesterday');
  assert.equal(scopeWord('2026-11-10', now), 'on 10 Nov');
  assert.equal(placedLabel('2026-11-13', now), 'Placed today');
  assert.equal(deliveredLabel('2026-11-12', now), 'Delivered yesterday');
  assert.equal(cancelledLabel('2026-11-10', now), 'Cancelled on 10 Nov');
  assert.equal(deliveredNote(11, '2026-11-13', now), '11 orders delivered today');
  assert.equal(deliveredNote(1, '2026-11-10', now), '1 order delivered on 10 Nov');
  assert.equal(outstandingNote(6), '6 open orders · all dates');
  assert.equal(outstandingNote(1), '1 open order · all dates');
});

test('picked days stay within two years back and cash figures shrink to fit two columns', () => {
  const now = Date.parse('2026-11-13T06:00:00Z');
  assert.equal(minPickedDate(now), '2024-11-12');
  assert.equal(acceptPickedDate('0202-11-10', now), null, 'a half-typed year never reaches the server');
  assert.equal(acceptPickedDate('2024-11-11', now), null);
  assert.equal(acceptPickedDate('2024-11-12', now), '2024-11-12');
  assert.equal(addDaysISO('2028-02-28', 1), '2028-02-29');
  assert.equal(istDateISO(Date.parse('2026-12-31T18:30:00Z')), '2027-01-01');
  assert.equal(amountFontSize('₹4,260', '₹2,210'), 30);
  assert.equal(amountFontSize('₹1,880.50', '₹2,210'), 26);
  assert.equal(amountFontSize('₹10,880.50', '₹2,210'), 22);
  assert.equal(amountFontSize('₹1,23,456.50', '₹2,210'), 18);
});
