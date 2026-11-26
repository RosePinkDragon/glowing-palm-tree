/**
 * Opening hours (#253). One window per day, in India time (Asia/Kolkata, UTC+05:30, no daylight saving), as 24-hour
 * "HH:MM" strings. The window is [opensAt, closesAt): opening is inclusive and closing is exclusive. A closing time of
 * "00:00" means midnight at the END of the day ("11:00" to "00:00" is 11:00 to midnight); "24:00" is accepted on input and
 * normalised to "00:00", so midnight has one representation, the same as the database. A window never crosses midnight into
 * the next day. A business with no hours (null) is open all day. The server is the authority; this mirrors it for display.
 */
export interface OpeningHours { opensAt: string; closesAt: string }
export type OpeningHoursField = 'opensAt' | 'closesAt' | 'openingHours';

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const IST_OFFSET_MINUTES = 330;
const clock = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Minutes after midnight of an "HH:MM" string, or null when it is not a clock time (24:00 is not one; see normalizeClosesAt). */
export function clockMinutes(value: unknown): number | null {
  const match = typeof value === 'string' ? clock.exec(value) : null;
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
/** The server returns times as "HH:MM:SS"; keep whole minutes. A time with seconds is not a valid hour setting. */
export function clockFromDatabase(value: unknown): string | null {
  const match = typeof value === 'string' ? /^([01][0-9]|2[0-3]):([0-5][0-9])(:00(\.0+)?)?$/.exec(value) : null;
  return match ? `${match[1]}:${match[2]}` : null;
}

/** Validate an owner's input. Returns the normalised hours (null clears them: open all day) or the field problems. */
export function validateOpeningHours(opensAt: string | null, closesAt: string | null): { hours: OpeningHours | null; errors: Partial<Record<OpeningHoursField, string>> } {
  const errors: Partial<Record<OpeningHoursField, string>> = {};
  if (opensAt === null && closesAt === null) return { hours: null, errors };
  if (opensAt === null || closesAt === null) return { hours: null, errors: { openingHours: 'Set both an opening and a closing time, or neither.' } };
  const closes = closesAt === '24:00' ? '00:00' : closesAt;
  const open = clockMinutes(opensAt), close = clockMinutes(closes);
  if (open === null) errors.opensAt = 'Enter the opening time as hours and minutes, for example 09:00.';
  if (close === null) errors.closesAt = 'Enter the closing time as hours and minutes, for example 19:30, or 24:00 for midnight.';
  if (open !== null && close !== null && !(open < close || (close === 0 && open > 0))) errors.closesAt = 'Closing must be after opening on the same day. Midnight is allowed.';
  return Object.keys(errors).length ? { hours: null, errors } : { hours: { opensAt, closesAt: closes }, errors };
}

/** Minutes after midnight in India at this instant, with seconds as a fraction (so 19:29:59 is below 19:30 = 1170). */
export function indiaMinutes(now: Date): number {
  const ms = now.getTime() + IST_OFFSET_MINUTES * 60_000;
  return (((ms % 86_400_000) + 86_400_000) % 86_400_000) / 60_000;
}

/** Is a business with these hours open at this instant? Null or missing hours mean open all day. */
export function isOpenNow(business: { openingHours?: OpeningHours | null }, now: Date): boolean {
  const hours = business.openingHours;
  if (!hours) return true;
  const open = clockMinutes(hours.opensAt), close = clockMinutes(hours.closesAt);
  if (open === null || close === null) return false; // malformed hours: fail closed, the server decides anyway
  const t = indiaMinutes(now);
  return t >= open && (close === 0 || t < close);
}

/** "09:00" -> "9 am", "19:30" -> "7:30 pm", "00:00" -> "12 am", "12:00" -> "12 pm". */
export function formatClock(value: string): string {
  const minutes = clockMinutes(value);
  if (minutes === null) return value;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}
/** "Opens at 9 am", or null when the business has no hours. Shown while closed by hours (before opening or after closing, the next opening time is the same). */
export function opensAtLabel(business: { openingHours?: OpeningHours | null }): string | null {
  return business.openingHours ? `Opens at ${formatClock(business.openingHours.opensAt)}` : null;
}
/** "9 am to 7:30 pm", "11 am to 12 am (midnight)"; null with no hours. */
export function hoursLabel(business: { openingHours?: OpeningHours | null }): string | null {
  const hours = business.openingHours;
  if (!hours) return null;
  return `${formatClock(hours.opensAt)} to ${formatClock(hours.closesAt)}${hours.closesAt === '00:00' ? ' (midnight)' : ''}`;
}
