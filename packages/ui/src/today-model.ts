// Pure helpers for the owners' Today screen. Days run midnight to midnight in India time (Asia/Kolkata,
// UTC+05:30, no daylight saving), never the device zone, so the offset is applied by hand.
const istOffsetMs = 330 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type TodayChip = 'today' | 'yesterday' | 'date';
export const todayChips: readonly TodayChip[] = ['today', 'yesterday', 'date'];

/** The India-time calendar day (YYYY-MM-DD) containing this instant. */
export const istDateISO = (now: number | Date = Date.now()): string => new Date((typeof now === 'number' ? now : now.getTime()) + istOffsetMs).toISOString().slice(0, 10);
export const isValidDateISO = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const addDaysISO = (dateISO: string, days: number): string => new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
export const istTodayISO = (now?: number | Date) => istDateISO(now);
export const istYesterdayISO = (now?: number | Date) => addDaysISO(istDateISO(now), -1);

/** "13 Nov" */
export function shortDateLabel(dateISO: string): string {
  if (!isValidDateISO(dateISO)) return dateISO;
  return `${Number(dateISO.slice(8, 10))} ${months[Number(dateISO.slice(5, 7)) - 1]}`;
}
/** The day a choice shows. Today omits the date so the server uses its own India-time today; the others send it. */
export function requestDate(chip: TodayChip, picked: string, now?: number | Date): string | undefined {
  return chip === 'today' ? undefined : chip === 'yesterday' ? istYesterdayISO(now) : picked;
}
/** A picked day must be a real day, not after today (India time). Returns it, or null. */
/** Earliest pickable day (two years back): typing a year digit by digit never asks for year 0002. */
export const minPickedDate = (now?: number | Date) => addDaysISO(istDateISO(now), -731);
export function acceptPickedDate(value: string, now?: number | Date): string | null {
  return isValidDateISO(value) && value <= istDateISO(now) && value >= minPickedDate(now) ? value : null;
}
/** Cash figures shrink together as they lengthen, so two columns fit a phone (e.g. ₹1,23,456.50). */
export const amountFontSize = (...amounts: string[]) => { const longest = Math.max(0, ...amounts.map(text => text.length)); return longest > 11 ? 18 : longest > 9 ? 22 : longest > 7 ? 26 : 30; };
/** Previous/next day for the native stepper, never beyond today. */
export const stepPickedDate = (dateISO: string, step: -1 | 1, now?: number | Date): string => {
  const next = addDaysISO(dateISO, step);
  return next > istDateISO(now) ? istDateISO(now) : next;
};
/** The default picked day when "Pick a date" is first chosen: the day before yesterday. */
export const defaultPickedDate = (now?: number | Date) => addDaysISO(istDateISO(now), -2);

export function chipLabel(chip: TodayChip, picked: string, now?: number | Date): string {
  if (chip === 'today') return `Today, ${shortDateLabel(istDateISO(now))}`;
  if (chip === 'yesterday') return 'Yesterday';
  return 'Pick a date';
}
/** "today" | "yesterday" | "on 10 Nov": the phrase that scopes a date-bound label. */
export function scopeWord(dateISO: string, now?: number | Date): string {
  if (dateISO === istDateISO(now)) return 'today';
  if (dateISO === istYesterdayISO(now)) return 'yesterday';
  return `on ${shortDateLabel(dateISO)}`;
}
export const placedLabel = (dateISO: string, now?: number | Date) => `Placed ${scopeWord(dateISO, now)}`;
export const deliveredLabel = (dateISO: string, now?: number | Date) => `Delivered ${scopeWord(dateISO, now)}`;
export const cancelledLabel = (dateISO: string, now?: number | Date) => `Cancelled ${scopeWord(dateISO, now)}`;
export const deliveredNote = (count: number, dateISO: string, now?: number | Date) => `${count} ${count === 1 ? 'order' : 'orders'} delivered ${scopeWord(dateISO, now)}`;
export const outstandingNote = (count: number) => `${count} open ${count === 1 ? 'order' : 'orders'} · all dates`;
export const collectedHeading = (dateISO: string, now?: number | Date) => `Collected ${scopeWord(dateISO, now)}`;
export const summaryFooter = "Days run midnight to midnight, India time. Cancelled orders aren't counted in cash.";
