import { clockMinutes, hoursLabel, indiaMinutes, isOpenNow, opensAtLabel, type BusinessSlug, type OpeningHours } from '@market/core';

// Pure rules for the customer's opening-hours state (#253). The window and the "is it open" answer come from @market/core
// (which mirrors the server); this adds when to look again, and the copy.
type WithHours = { openingHours?: OpeningHours | null };

/** A stable key for a business's hours: a refusal belongs to the hours it was made under, so an edit clears it. */
export const hoursSignature = (business: WithHours | null | undefined): string => business?.openingHours ? `${business.openingHours.opensAt}-${business.openingHours.closesAt}` : 'all-day';

/**
 * The next instant (epoch milliseconds, after `nowMs`) at which isOpenNow can change: the next opening or closing time in India.
 * Null for a business with no (or malformed) hours, which never changes. Closing at midnight is the end of the day (24:00).
 */
export function nextBoundaryMs(business: WithHours | null | undefined, nowMs: number): number | null {
  const hours = business?.openingHours;
  const open = hours ? clockMinutes(hours.opensAt) : null, closeRaw = hours ? clockMinutes(hours.closesAt) : null;
  if (open === null || closeRaw === null) return null;
  const close = closeRaw === 0 ? 1440 : closeRaw;
  const now = indiaMinutes(new Date(nowMs)), dayStart = nowMs - now * 60_000;
  const next = now < open ? open : now < close ? close : open + 1440;
  return Math.round(dayStart + next * 60_000);
}

/** How long to wait before looking again: the next boundary, never less than a moment, never more than a day (setTimeout's limit is ~24.8 days). */
export function msUntilBoundary(business: WithHours | null | undefined, nowMs: number): number | null {
  const at = nextBoundaryMs(business, nowMs);
  return at === null ? null : Math.min(Math.max(at - nowMs, 250), 86_400_000);
}

/** A server refusal outside hours is trusted for this long (the device clock may be off); focusing the app or any boundary also looks again. */
export const refusalMs = 120_000;

export type HoursState = { open: boolean; opensAtLabel: string | null };
/** Is the restaurant within its hours right now? `refusal` is the server's "outside hours" answer for these same hours, if it is still fresh. */
export function hoursState(business: WithHours | null | undefined, nowMs: number, refusal: { signature: string; at: number; label: string | null } | null): HoursState {
  const refused = !!refusal && refusal.signature === hoursSignature(business) && nowMs - refusal.at >= 0 && nowMs - refusal.at < refusalMs;
  const open = !refused && isOpenNow(business ?? {}, new Date(nowMs));
  return { open, opensAtLabel: open ? null : (refused ? refusal.label : null) ?? (business ? opensAtLabel(business) : null) };
}

/** "Open 9 am to 7:30 pm" for the facts line, or null with no hours. */
export const openHoursFact = (business: WithHours | null | undefined): string | null => { const label = business ? hoursLabel(business) : null; return label ? `Open ${label}` : null; };

/** The closed-by-hours notice (customer p. 28 pattern, #58): "Closed now · Opens at 9 am" with a brand-voiced follow-up. */
export const hoursClosedParts = (slug: BusinessSlug, label: string | null): { lead: string; rest: string } => ({
  lead: label ? `Closed now · ${label}` : 'Closed now',
  rest: slug === 'ammu-sammu' ? 'You can still look at the menu.' : 'Browse the menu and order when the kitchen opens.',
});
export const hoursClosedMessage = (slug: BusinessSlug, label: string | null) => { const { lead, rest } = hoursClosedParts(slug, label); return `${lead}. ${rest}`; };
