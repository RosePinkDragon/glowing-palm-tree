/** WhatsApp one-time-code login (#50): phone and code rules, the resend cooldown and the screen copy for the error codes @market/services raises (OtpError). */
export const OTP_LENGTH = 6;
/** How long Get code / Send a new code stays disabled after a code was sent. A server-stated wait (RESEND_COOLDOWN) overrides it. */
export const RESEND_COOLDOWN_SECONDS = 30;

export type OtpErrorCode = 'WRONG_OR_EXPIRED_CODE' | 'RESEND_COOLDOWN' | 'NOT_ON_WHATSAPP' | 'RATE_LIMITED' | 'GENERIC';
export const otpErrorCodes: readonly OtpErrorCode[] = ['WRONG_OR_EXPIRED_CODE', 'RESEND_COOLDOWN', 'NOT_ON_WHATSAPP', 'RATE_LIMITED', 'GENERIC'];
export const isOtpErrorCode = (value: unknown): value is OtpErrorCode => typeof value === 'string' && (otpErrorCodes as readonly string[]).includes(value);

/** Accepts what people type or paste (spaces, dashes, +91, 91 or a leading 0) and returns +91XXXXXXXXXX, or null when it is not an Indian mobile number. */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(digits)) return null;
  if (digits.startsWith('+')) { if (!digits.startsWith('+91')) return null; digits = digits.slice(3); }
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
/** The text of the 10-digit field: digits only, with a pasted +91/91/0 prefix removed, at most ten digits. */
export function phoneFieldValue(input: string): string {
  const digits = input.replace(/\D/g, '');
  const stripped = /^\s*\+/.test(input) && digits.startsWith('91') ? digits.slice(2) : digits.length >= 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return stripped.slice(0, 10);
}
export function phoneFieldError(input: string): string {
  if (!input.trim()) return 'Enter your 10-digit mobile number.';
  return normalizeIndianMobile(input) ? '' : 'Enter a valid 10-digit mobile number that starts with 6, 7, 8 or 9.';
}
/** +919876543210 -> "+91 98765 43210". */
export function formatPhone(e164: string): string {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
}
/** Digits only, at most six, so pasting "482 916" or "482-916" works. */
export function codeFieldValue(input: string): string { return input.replace(/\D/g, '').slice(0, OTP_LENGTH); }
export const isCompleteCode = (code: string) => code.length === OTP_LENGTH;

/** Cooldown model: a deadline in epoch ms; the screen derives the remaining whole seconds from the clock. */
export const cooldownDeadline = (nowMs: number, seconds = RESEND_COOLDOWN_SECONDS) => nowMs + Math.max(1, Math.round(seconds)) * 1000;
export const cooldownRemaining = (deadlineMs: number, nowMs: number) => Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
export function formatCountdown(seconds: number): string { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

export const otpErrorCopy: Record<OtpErrorCode, string> = {
  WRONG_OR_EXPIRED_CODE: 'That code didn\'t match, or it has expired. Check the latest WhatsApp message, or send a new code.',
  RESEND_COOLDOWN: 'Please wait a moment before asking for another code.',
  NOT_ON_WHATSAPP: 'We couldn\'t deliver the code on WhatsApp. Check the number.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  GENERIC: 'Something went wrong. Please try again.',
};
