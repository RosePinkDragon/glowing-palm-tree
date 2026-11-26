import { formatClock, validateOpeningHours, type OpeningHours, type OpeningHoursField } from '@market/core';
import type { SaveOpeningHoursInput } from '@market/services';

// Pure form model for the owners' "Opening hours" section (#253). Two plain text boxes, so it works the same on web and native:
// "09:00", "9", "9:30", "7:30 pm", "7.30pm" are all accepted, and "Midnight" (or 24:00 / 12 am) closes at the end of the day.
// The rules themselves are validateOpeningHours from @market/core, the same ones the save path and the database use.
export interface HoursForm { allDay: boolean; opensAt: string; closesAt: string }
export type HoursErrors = Partial<Record<OpeningHoursField, string>>;
export const hoursFieldOrder = ['opensAt', 'closesAt'] as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** The 24-hour "HH:MM" an owner meant, or the trimmed text itself when it is not a time (validation then says so). */
export function parseClockText(text: string): string {
  const raw = text.trim().toLowerCase();
  if (raw === 'midnight') return '00:00';
  if (raw === 'noon') return '12:00';
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm)?$/.exec(raw);
  if (!match) return text.trim();
  let hour = Number(match[1]); const minute = match[2] === undefined ? 0 : Number(match[2]), meridiem = match[3];
  if (minute > 59) return text.trim();
  if (meridiem) { if (hour < 1 || hour > 12) return text.trim(); hour = hour % 12 + (meridiem === 'pm' ? 12 : 0); }
  else if (hour === 24 && minute === 0) return '24:00';
  if (hour > 23) return text.trim();
  return `${pad(hour)}:${pad(minute)}`;
}

/** What the owner sees in a box for a stored time: 24-hour, except the end of the day, which reads "Midnight". */
export const clockText = (value: string, closing = false) => closing && value === '00:00' ? 'Midnight' : value;

export const hoursFormFrom = (hours: OpeningHours | null): HoursForm => hours ? { allDay: false, opensAt: hours.opensAt, closesAt: clockText(hours.closesAt, true) } : { allDay: true, opensAt: '', closesAt: '' };

/** A live reading of what is typed, for the line under the boxes ("Opens at 9 am, closes at 7:30 pm"), or null while it is not a valid window. */
export function hoursPreview(form: HoursForm): string | null {
  if (form.allDay) return 'Open all day: customers can order whenever the ordering switch is on.';
  const result = validateOpeningHours(parseClockText(form.opensAt), parseClockText(form.closesAt));
  return result.hours ? `Customers can order from ${formatClock(result.hours.opensAt)} to ${result.hours.closesAt === '00:00' ? 'midnight' : formatClock(result.hours.closesAt)}, India time.` : null;
}

export type HoursResult = { ok: true; input: SaveOpeningHoursInput } | { ok: false; errors: HoursErrors };
/** Validate the typed hours; any error means nothing is sent. "Open all day" sends both times as null. */
export function validateHoursForm(form: HoursForm, version: number): HoursResult {
  if (form.allDay) return { ok: true, input: { opensAt: null, closesAt: null, expectedVersion: version } };
  const result = validateOpeningHours(parseClockText(form.opensAt), parseClockText(form.closesAt));
  if (!result.hours) {
    const errors = { ...result.errors };
    if (!form.opensAt.trim() && errors.opensAt) errors.opensAt = 'Enter the opening time, for example 09:00.';
    if (!form.closesAt.trim() && errors.closesAt) errors.closesAt = 'Enter the closing time, for example 19:30, or Midnight.';
    return { ok: false, errors };
  }
  return { ok: true, input: { opensAt: result.hours.opensAt, closesAt: result.hours.closesAt, expectedVersion: version } };
}

/** The window an owner would save, normalised ("7:30 pm" and "19:30" are the same; unreadable text is compared as typed). */
export function normalizeHours(form: HoursForm) {
  if (form.allDay) return { allDay: true, opensAt: '', closesAt: '' };
  const closes = parseClockText(form.closesAt);
  return { allDay: false, opensAt: parseClockText(form.opensAt), closesAt: closes === '24:00' ? '00:00' : closes };
}
