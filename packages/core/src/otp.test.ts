import assert from 'node:assert/strict';
import test from 'node:test';
import { codeFieldValue, cooldownDeadline, cooldownRemaining, formatCountdown, formatPhone, normalizeIndianMobile, phoneFieldError, phoneFieldValue, isOtpErrorCode, otpErrorCodes, otpErrorCopy } from './otp.ts';

test('normalises Indian mobile numbers however they are typed or pasted', () => {
  for (const input of ['9876543210', '98765 43210', '98765-43210', '+91 98765 43210', '919876543210', '09876543210', ' +91-9876543210 ']) assert.equal(normalizeIndianMobile(input), '+919876543210', input);
  for (const input of ['', '12345', '5876543210', '98765432101', '+14155550123', '98765abcde', '+9198765']) assert.equal(normalizeIndianMobile(input), null, input);
});
test('the phone field keeps only the ten digits', () => {
  assert.equal(phoneFieldValue('+91 98765 43210'), '9876543210');
  assert.equal(phoneFieldValue('919876543210'), '9876543210');
  assert.equal(phoneFieldValue('98765abc43210999'), '9876543210');
  assert.equal(phoneFieldValue('9876'), '9876');
  assert.equal(phoneFieldValue('91234567890'), '9123456789', 'a valid number that starts with 91 is not mistaken for a prefix');
  assert.match(phoneFieldError(''), /Enter your 10-digit/);
  assert.match(phoneFieldError('12345'), /valid 10-digit/);
  assert.equal(phoneFieldError('9876543210'), '');
  assert.equal(formatPhone('+919876543210'), '+91 98765 43210');
});
test('the code field keeps six digits', () => {
  assert.equal(codeFieldValue('482 916'), '482916'); assert.equal(codeFieldValue('48-29-16-77'), '482916'); assert.equal(codeFieldValue('abc'), '');
});
test('cooldown counts down in whole seconds and never goes negative', () => {
  const start = 1_000_000, deadline = cooldownDeadline(start);
  assert.equal(cooldownRemaining(deadline, start), 30); assert.equal(cooldownRemaining(deadline, start + 5_500), 25); assert.equal(cooldownRemaining(deadline, start + 29_999), 1);
  assert.equal(cooldownRemaining(deadline, start + 30_000), 0); assert.equal(cooldownRemaining(deadline, start + 90_000), 0);
  assert.equal(cooldownRemaining(cooldownDeadline(start, 60), start), 60);
  assert.equal(formatCountdown(24), '0:24'); assert.equal(formatCountdown(5), '0:05'); assert.equal(formatCountdown(60), '1:00'); assert.equal(formatCountdown(-3), '0:00');
});
test('every service error code has screen copy', () => {
  for (const code of otpErrorCodes) assert.ok(otpErrorCopy[code].length > 10, code);
  assert.equal(otpErrorCopy.NOT_ON_WHATSAPP, 'We couldn\'t deliver the code on WhatsApp. Check the number.');
  assert.equal(isOtpErrorCode('RATE_LIMITED'), true); assert.equal(isOtpErrorCode('over_sms_send_rate_limit'), false);
});
