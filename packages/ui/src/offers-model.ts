import { formatINRFromPaise } from '@market/core';
import { OfferValidationError, validateOffer, type OfferApplyMode, type OfferField, type OfferInput, type OfferKind, type OfferLockedPatch, type OfferStatus, type OwnerOffer } from '@market/services';
import type { PillTone } from './MarketChips';

// Pure model for the owners' Offers screens (#182 slice B): list order, wording, and the form's text <-> OfferInput conversion.
// The service validates again and the database is the authority; this only gives each field a plain message.

export const offerEndedMessage = 'This offer has ended. Create a new one to run it again.';
export const endInPastMessage = 'End must be in the future.';
export const offerLockedMessage = 'Terms are locked once an offer has been used. End it and create a new one to change them.';
export const kindLabels: Record<OfferKind, string> = { percent: 'Percent off', flat: 'Flat ₹ off', free_delivery: 'Free delivery' };
export const weekdayShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const weekdayLong = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const inr = (paise: number) => formatINRFromPaise(paise);
// Same rules as admin-model's parseRupees and rupeesInput, kept here because the model tests load files without Metro's extensionless imports.
function parseRupees(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}
const rupeesInput = (paise: number) => paise % 100 === 0 ? String(paise / 100) : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`;

/** "20% off up to ₹100", "₹50 off", "Free delivery". */
export function offerSummary(offer: Pick<OwnerOffer, 'kind' | 'value' | 'maxDiscountPaise'>): string {
  if (offer.kind === 'free_delivery') return 'Free delivery';
  if (offer.kind === 'flat') return `${inr(offer.value ?? 0)} off`;
  return `${offer.value}% off${offer.maxDiscountPaise ? ` up to ${inr(offer.maxDiscountPaise)}` : ''}`;
}
/** "Automatic" or "Code DINNER20". */
export const offerApplied = (offer: Pick<OwnerOffer, 'applyMode' | 'code'>) => offer.applyMode === 'code' ? `Code ${offer.code}` : 'Automatic';
/** "12 uses · ₹1,200 given". */
export const offerUsage = (offer: Pick<OwnerOffer, 'useCount' | 'discountGivenPaise' | 'usageKnown'>) => !offer.usageKnown ? 'Usage unavailable' : `${offer.useCount} ${offer.useCount === 1 ? 'use' : 'uses'} · ${inr(offer.discountGivenPaise)} given`;
/** "₹340 given across 7 orders". */
export const dayOffersTotal = (givenPaise: number, orders: number) => `${inr(givenPaise)} given across ${orders} ${orders === 1 ? 'order' : 'orders'}`;
export const statusLabels: Record<OfferStatus, string> = { active: 'Active', scheduled: 'Scheduled', paused: 'Paused', ended: 'Ended', used_up: 'Used up' };
export const statusTones: Record<OfferStatus, PillTone> = { active: 'positive', scheduled: 'info', paused: 'quiet', ended: 'outline', used_up: 'neutral' };

/** Active and scheduled first, then paused, then ended (including used up); newest first inside a group. */
export function offerGroups(offers: readonly OwnerOffer[]): { key: 'running' | 'paused' | 'ended'; title: string; offers: OwnerOffer[] }[] {
  const order = (a: OwnerOffer, b: OwnerOffer) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  const groups = [
    { key: 'running' as const, title: 'Active and scheduled', offers: offers.filter(o => o.status === 'active' || o.status === 'scheduled').sort(order) },
    { key: 'paused' as const, title: 'Paused', offers: offers.filter(o => o.status === 'paused').sort(order) },
    { key: 'ended' as const, title: 'Ended', offers: offers.filter(o => o.status === 'ended' || o.status === 'used_up').sort(order) },
  ];
  return groups.filter(group => group.offers.length);
}
/** Which actions an offer offers: an ended or used-up offer can only be viewed. */
export const offerActions = (offer: Pick<OwnerOffer, 'status'>) => ({
  pause: offer.status === 'active' || offer.status === 'scheduled', resume: offer.status === 'paused', end: offer.status !== 'ended',
});

// ---- India Standard Time (UTC+5:30, no daylight saving) ----
const IST_MINUTES = 330;
const pad = (n: number) => String(n).padStart(2, '0');
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istDate = (iso: string) => new Date(Date.parse(iso) + IST_MINUTES * 60000);
/** "2026-11-21 18:00" in IST: the text an owner edits. */
export function istInput(iso: string | null): string {
  if (!iso) return '';
  const d = istDate(iso);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
/** "21 Nov 2026, 6:00 pm" in IST. */
export function formatIst(iso: string | null): string {
  if (!iso) return '';
  const d = istDate(iso), h = d.getUTCHours();
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'am' : 'pm'}`;
}
/** Parse "YYYY-MM-DD HH:MM" as IST. Empty is null (no limit); anything else must be a real date and time. */
export function parseIstInput(text: string): { ok: true; iso: string | null } | { ok: false } {
  const value = text.trim();
  if (!value) return { ok: true, iso: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (!m) return { ok: false };
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return { ok: false };
  return { ok: true, iso: new Date(utc - IST_MINUTES * 60000).toISOString() };
}
/** "6:00 pm to 10:30 pm, Mon, Wed, Fri". */
export function formatWindow(window: NonNullable<OfferInput['window']>): string {
  const clock = (t: string) => { const [h, m] = t.split(':').map(Number) as [number, number]; return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'am' : 'pm'}`; };
  return `${clock(window.from)} to ${clock(window.to)}, ${window.days.length === 7 ? 'every day' : window.days.map(d => weekdayShort[d - 1]).join(', ')}`;
}

// ---- The form ----
export interface OfferForm {
  name: string; kind: OfferKind; value: string; maxDiscount: string; minOrder: string; applyMode: OfferApplyMode; code: string; firstOrderOnly: boolean;
  perCustomerLimit: string; totalLimit: string; startsAt: string; endsAt: string; windowOn: boolean; windowFrom: string; windowTo: string; windowDays: number[];
}
export type OfferFormErrors = Partial<Record<OfferField, string>>;
export const emptyOfferForm = (): OfferForm => ({ name: '', kind: 'percent', value: '', maxDiscount: '', minOrder: '', applyMode: 'automatic', code: '', firstOrderOnly: false, perCustomerLimit: '', totalLimit: '',
  startsAt: '', endsAt: '', windowOn: false, windowFrom: '15:00', windowTo: '18:00', windowDays: [1, 2, 3, 4, 5, 6, 7] });
export function formFromOffer(o: OwnerOffer): OfferForm {
  return { name: o.name, kind: o.kind, value: o.value === null ? '' : o.kind === 'flat' ? rupeesInput(o.value) : String(o.value), maxDiscount: o.maxDiscountPaise === null ? '' : rupeesInput(o.maxDiscountPaise),
    minOrder: o.minOrderPaise ? rupeesInput(o.minOrderPaise) : '', applyMode: o.applyMode, code: o.code ?? '', firstOrderOnly: o.firstOrderOnly, perCustomerLimit: o.perCustomerLimit === null ? '' : String(o.perCustomerLimit),
    totalLimit: o.totalLimit === null ? '' : String(o.totalLimit), startsAt: istInput(o.startsAt), endsAt: istInput(o.endsAt), windowOn: o.window !== null, windowFrom: o.window?.from ?? '15:00', windowTo: o.window?.to ?? '18:00',
    windowDays: o.window?.days ?? [1, 2, 3, 4, 5, 6, 7] };
}
/** The order the fields appear in, so focus goes to the first problem. */
export const offerFieldOrder: OfferField[] = ['name', 'kind', 'value', 'maxDiscount', 'minOrder', 'applyMode', 'code', 'perCustomerLimit', 'totalLimit', 'startsAt', 'endsAt', 'window'];
export const firstOfferError = (errors: OfferFormErrors): OfferField | undefined => offerFieldOrder.find(field => errors[field]);
const dateHint = 'Enter it as 2026-11-21 18:00 (India time), or leave it empty.';
const messages = (kind: OfferKind): Partial<Record<OfferField, string>> => ({
  name: 'Enter a name of 3 to 40 characters.', value: kind === 'percent' ? 'Enter a whole percent from 1 to 90.' : 'Enter an amount from ₹1 to ₹1,000.',
  maxDiscount: 'Enter an amount from ₹1 to ₹1,000, or leave it empty.', minOrder: 'Enter an amount from ₹0 to ₹10,000, or leave it empty.', code: 'Enter a code of 4 to 15 letters and numbers.',
  perCustomerLimit: 'Enter a number from 1 to 99, or leave it empty.', totalLimit: 'Enter a number from 1 to 100,000, or leave it empty.', startsAt: dateHint,
  window: 'Choose a from and to time like 15:00 and 18:00 that differ, and at least one day.',
});
const whole = (text: string) => /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : NaN;
const optionalWhole = (text: string) => text.trim() === '' ? null : whole(text);
const optionalPaise = (text: string) => text.trim() === '' ? null : parseRupees(text) ?? NaN;

/** Text in, a complete OfferInput out, or one plain message per invalid field. Nothing is sent while any field is invalid. */
export function validateOfferForm(form: OfferForm, options: { creating?: boolean; now?: Date } = {}): { ok: true; input: OfferInput } | { ok: false; errors: OfferFormErrors } {
  const errors: OfferFormErrors = {};
  const starts = parseIstInput(form.startsAt), ends = parseIstInput(form.endsAt);
  const code = form.code.trim().toUpperCase();
  const candidate: OfferInput = {
    name: form.name, kind: form.kind,
    value: form.kind === 'free_delivery' ? null : form.kind === 'percent' ? whole(form.value) : parseRupees(form.value) ?? NaN,
    maxDiscountPaise: form.kind === 'percent' ? optionalPaise(form.maxDiscount) : null, minOrderPaise: form.minOrder.trim() === '' ? 0 : parseRupees(form.minOrder) ?? NaN,
    applyMode: form.applyMode, code: form.applyMode === 'code' ? code : null, firstOrderOnly: form.firstOrderOnly, perCustomerLimit: optionalWhole(form.perCustomerLimit), totalLimit: optionalWhole(form.totalLimit),
    startsAt: starts.ok ? starts.iso : 'invalid', endsAt: ends.ok ? ends.iso : 'invalid',
    window: form.windowOn ? { from: form.windowFrom.trim(), to: form.windowTo.trim(), days: form.windowDays } : null,
  };
  // A new offer that has already ended would never run: block it rather than save a dead offer.
  const past = options.creating === true && ends.ok && ends.iso !== null && Date.parse(ends.iso) <= (options.now ?? new Date()).getTime();
  try { const input = validateOffer(candidate); return past ? { ok: false, errors: { endsAt: endInPastMessage } } : { ok: true, input }; }
  catch (error) {
    if (!(error instanceof OfferValidationError)) throw error;
    const text = messages(form.kind);
    for (const [field, message] of Object.entries(error.fields) as [OfferField, string][]) errors[field] = field === 'endsAt' ? (ends.ok ? message : dateHint) : text[field] ?? message;
    if (past && !errors.endsAt) errors.endsAt = endInPastMessage;
    return { ok: false, errors };
  }
}
/** The only fields an offer that has been used can still change. */
export function validateLockedForm(form: Pick<OfferForm, 'name' | 'endsAt'>): { ok: true; patch: Required<OfferLockedPatch> } | { ok: false; errors: OfferFormErrors } {
  const errors: OfferFormErrors = {};
  const name = form.name.trim(), ends = parseIstInput(form.endsAt);
  if ([...name].length < 3 || [...name].length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) errors.name = 'Enter a name of 3 to 40 characters.';
  if (!ends.ok) errors.endsAt = dateHint;
  return Object.keys(errors).length || !ends.ok ? { ok: false, errors } : { ok: true, patch: { name, endsAt: ends.iso } };
}
/** Server field errors (field names are the service's) shown with the same plain wording. */
export const serverOfferErrors = (fields: OfferFormErrors, kind: OfferKind): OfferFormErrors =>
  Object.fromEntries(Object.entries(fields).map(([field, message]) => [field, (messages(kind) as Record<string, string | undefined>)[field] ?? message])) as OfferFormErrors;
