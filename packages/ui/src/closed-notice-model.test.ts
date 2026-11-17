import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closedMessage, closedParts } from './closed-notice-model.ts';

test('the closed notice keeps each brand\'s exact wording, split into a lead and a follow-up', () => {
  assert.equal(closedMessage('ammu-sammu'), 'Not taking orders right now. You can still look at the menu. Check back a little later.');
  assert.equal(closedMessage('kokani-dine-inn'), "The kitchen isn't taking orders right now. Browse the menu and check back a little later.");
  assert.equal(closedParts('ammu-sammu').lead, 'Not taking orders right now.');
  assert.equal(closedParts('kokani-dine-inn').lead, "The kitchen isn't taking orders right now.");
});

test('the notice never promises a time or an offer', () => {
  for (const slug of ['ammu-sammu', 'kokani-dine-inn'] as const) assert.doesNotMatch(closedMessage(slug), /\d|minute|hour|soon|discount|free/i);
});
