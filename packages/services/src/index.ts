import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import { businesses, clockFromDatabase, formatClock, validateOpeningHours, normalizeFullName, FULL_NAME_MESSAGE, isAddressLabel, isAddressLocationSource, isDiet, validateAddressDraft, type AddressDraft, type OrderAddress, type SavedAddress, type Diet, type AppAudience, type BusinessSlug, type CartLine, type DailySummary, type LocationFix, type OpeningHours, type OpeningHoursField, type MenuItem, type Order, type OrderStatus } from '@market/core';
import { storage } from './storage';

export type { SupportedStorage } from '@supabase/supabase-js';
export interface PublicConfig { url?: string; anonKey?: string }
export interface Business { /** Opening hours in India time (#253); null or missing means open all day. Use isOpenNow(business, now) from @market/core. */ openingHours?: OpeningHours | null; contactPhone?: string | null; whatsappPhone?: string | null; settingsVersion?: number; id: string; slug: BusinessSlug; name: string; deliveryFeePaise: number; minOrderPaise: number; isDemo: boolean; orderingEnabled: boolean; acceptingOrders: boolean }
export interface RestaurantSettings { contactPhone: string | null; whatsappPhone: string | null; deliveryFeePaise: number; minOrderPaise: number; version: number }
export interface OwnerProfile { displayName: string; readonly phone: string | null }
/** Delivery-area status from the business row (the polygon is never fetched): a verified radius, another verified source, or not verified. */
export type DeliveryAreaStatus = { kind: 'radius'; radiusM: number } | { kind: 'verified' } | { kind: 'unverified' };
/** What the owner's Restaurant details screen reads: the editable settings plus developer-controlled facts shown read-only. */
export interface RestaurantSettingsView extends RestaurantSettings { orderPrefix: string; deliveryArea: DeliveryAreaStatus; /** The owner-editable window (#253); null is open all day. Saved separately with saveOpeningHours. */ openingHours: OpeningHours | null }
/** Input of saveOpeningHours: both times as 24-hour "HH:MM" ("24:00" is midnight), or both null for open all day. expectedVersion is the settings version last read. */
export interface SaveOpeningHoursInput { opensAt: string | null; closesAt: string | null; expectedVersion: number }
export interface SavedOpeningHours { openingHours: OpeningHours | null; version: number }
export interface SaveRestaurantSettingsInput { contactPhone: string; whatsappPhone: string | null; deliveryFeePaise: number; minOrderPaise: number; expectedVersion: number }
type SettingsField = keyof SaveRestaurantSettingsInput;
/** National, trunk-prefixed, or +91 Indian numbers become canonical E.164. */
function settingsPhone(value: unknown, mobileOnly: boolean): string | null {
  if (typeof value !== 'string' || !/^\+?[0-9 ().-]+$/.test(value.trim())) return null;
  let digits = value.trim().replace(/[ ().-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.startsWith('+')) return null;
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return (mobileOnly ? /^[6-9][0-9]{9}$/ : /^[1-9][0-9]{9}$/).test(digits) ? `+91${digits}` : null;
}
/** Parse rupee input exactly: never round a third decimal place or a floating-point amount. */
export function restaurantAmountPaise(value: string, field: 'deliveryFeePaise' | 'minOrderPaise'): number {
  const limit = field === 'deliveryFeePaise' ? 100000 : 1000000;
  if (typeof value !== 'string' || !/^[0-9]{1,5}(\.[0-9]{1,2})?$/.test(value.trim())) throw new RestaurantSettingsValidationError({ [field]: 'Enter rupees with up to two decimal places.' });
  const [whole, fraction = ''] = value.trim().split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (paise > limit) throw new RestaurantSettingsValidationError({ [field]: `Enter an amount from 0 to ${limit / 100} rupees.` });
  return paise;
}
export function validateRestaurantSettings(input: SaveRestaurantSettingsInput): SaveRestaurantSettingsInput {
  const fields: Partial<Record<SettingsField, string>> = {};
  const contactPhone = settingsPhone(input?.contactPhone, false);
  const whatsappEmpty = input?.whatsappPhone === null || (typeof input?.whatsappPhone === 'string' && !input.whatsappPhone.trim());
  const whatsappPhone = whatsappEmpty ? null : settingsPhone(input?.whatsappPhone, true);
  if (!contactPhone) fields.contactPhone = 'Enter an Indian mobile or landline number.';
  if (!whatsappEmpty && !whatsappPhone) fields.whatsappPhone = 'Enter an Indian mobile number or leave it empty.';
  if (!Number.isSafeInteger(input?.deliveryFeePaise) || input.deliveryFeePaise < 0 || input.deliveryFeePaise > 100000) fields.deliveryFeePaise = 'Enter a delivery fee from 0 to 1,000 rupees, in whole paise.';
  if (!Number.isSafeInteger(input?.minOrderPaise) || input.minOrderPaise < 0 || input.minOrderPaise > 1000000) fields.minOrderPaise = 'Enter a minimum order from 0 to 10,000 rupees, in whole paise.';
  if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion >= 2147483647) fields.expectedVersion = 'Refresh restaurant details before saving.';
  if (Object.keys(fields).length) throw new RestaurantSettingsValidationError(fields);
  return { contactPhone: contactPhone!, whatsappPhone, deliveryFeePaise: input.deliveryFeePaise, minOrderPaise: input.minOrderPaise, expectedVersion: input.expectedVersion };
}
export interface MenuCategory { id: string; businessId: BusinessSlug; name: string; sortOrder: number }
export interface SaveCategoryInput { id?: string; name: string; sortOrder: number }
export interface SaveMenuItemInput { diet: Diet | null; id?: string; name: string; description: string; categoryId: string; pricePaise: number; isAvailable: boolean; isDemo: boolean; isFeatured: boolean; sortOrder: number }
export type OfferKind = 'percent' | 'flat' | 'free_delivery';
/** The offer an order or quote used (#182). `code` is null for an automatic offer. */
export interface OfferSnapshot { id: string; name: string; code: string | null; kind: OfferKind }
export interface PricingTerms {
  lines: { menu_item_id: string; quantity: number; unit_price_paise: number; line_total_paise: number }[];
  delivery_fee_paise: number; min_order_paise: number; subtotal_paise: number; total_paise: number;
  /** Present only when an offer applies (so a cart with no offer is priced exactly as before offers existed): total = subtotal + delivery - discount. */
  discount_paise?: number; offer?: OfferSnapshot;
}
/** An active automatic offer, as shown on the menu and in the cart. Never carries a code or a limit. */
export interface ActiveOffer {
  id: string; name: string; kind: OfferKind; value: number | null; maxDiscountPaise: number | null; minOrderPaise: number; firstOrderOnly: boolean;
  endsAtISO: string | null; window: { from: string; to: string; days: number[] } | null;
}
/** A code that applies to this customer; the cart minimum is checked by the quote. */
export interface CheckedOfferCode { id: string; name: string; kind: OfferKind; value: number | null; maxDiscountPaise: number | null; minOrderPaise: number; firstOrderOnly: boolean }
/** "Add shortfallPaise more to get ..." for the closest automatic offer the cart is just short of. */
export interface OfferNudge { offerId: string; name: string; kind: OfferKind; value: number | null; shortfallPaise: number }
export interface OrderQuote { pricing: PricingTerms; offerError: OfferError | null; nudge: OfferNudge | null }
/**
 * An order goes to a saved address (#48): the server checks that address's pin and snapshots the
 * reviewed version. location (the phone, optional) only measures how far away the customer is.
 */
export interface PlaceOrderInput { pricing: PricingTerms; /** The code the customer entered, if any. It is part of the idempotent request: retry with the same value. */ offerCode?: string | null; lines: readonly CartLine[]; delivery: { name: string; phone: string }; location: LocationFix | null; idempotencyKey: string; savedAddress: { id: string; version: number } }
/** Preserve the database timestamp verbatim: JavaScript dates lose microseconds. */
/** The signed-in customer's profile (#45): one row per account, shared by both restaurant apps. Phone comes from Auth, not from here. */
export interface CustomerProfile { fullName: string; updatedAtISO: string }
export interface SaveProfileInput { fullName: string }
/** Server confirmation that account deletion was accepted (#51). The account is closed and its active data is gone; the same call repeats safely. Signing out on the device is the screen's job. */
export interface AccountDeletionReceipt { customerId: string; state: 'deletion_pending'; requestedAtISO: string }
export interface OrderCursor { createdAtISO: string; id: string }
export interface OrderPageOptions { cursor?: OrderCursor | null; limit?: number }
export interface OrderPage { orders: Order[]; nextCursor: OrderCursor | null }
export interface CustomerNotification {
  id: string; businessId: BusinessSlug; orderId: string; eventStatus: OrderStatus;
  title: string; body: string; readAtISO: string | null; createdAtISO: string;
}
export interface NotificationPageOptions { cursor?: OrderCursor | null; limit?: number }
export interface NotificationPage { notifications: CustomerNotification[]; nextCursor: OrderCursor | null }
export interface ServiceOptions { businessSlug: BusinessSlug; audience: AppAudience; config?: PublicConfig; storage?: SupportedStorage; /** How long quoteOrder waits before giving up (default 8 s). For tests. */ quoteTimeoutMs?: number }

export interface LeaveBusinessReceipt {
  customerId: string; businessId: string; requestId: string; generation: string;
  startedAtISO: string; completedAtISO: string; state: 'left';
  localCleanup: { businessSlug: BusinessSlug; generation: string; requestId: string };
}

export interface CustomerBusinessRelationship {
  customerId: string;
  businessId: string;
  generation: string;
  joinedAtISO: string;
  state: 'active';
}

/** One of the caller's own customer_businesses rows (#52), with the restaurant it points at. */
export interface CustomerRestaurantLink {
  businessId: string; businessSlug: BusinessSlug; businessName: string; generation: string;
  state: 'active' | 'leave_pending' | 'left';
}

export class ServiceError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) { super(message); this.name = 'ServiceError'; this.code = code; this.cause = cause; }
}
export class OpeningHoursValidationError extends ServiceError {
  readonly fields: Partial<Record<OpeningHoursField, string>>;
  constructor(fields: Partial<Record<OpeningHoursField, string>>) { super('INVALID_SETTINGS', 'Check the opening hours.'); this.name = 'OpeningHoursValidationError'; this.fields = fields; }
}
/**
 * The server refused a quote or a new order because the restaurant is outside its opening hours (#253). It is a
 * NOT_ACCEPTING_ORDERS error (screens already treat that as closed) with `reason: 'OUTSIDE_HOURS'` and `opensAt`
 * ("HH:MM" India time, null if unknown) plus `opensAtLabel` ("9 am") for "Opens at 9 am". Nothing was ordered and no key was spent.
 */
export class OutsideHoursError extends ServiceError {
  readonly reason = 'OUTSIDE_HOURS' as const;
  readonly opensAt: string | null;
  readonly opensAtLabel: string | null;
  constructor(opensAt: string | null, cause?: unknown) {
    super('NOT_ACCEPTING_ORDERS', opensAt ? `The restaurant is closed right now. It opens at ${formatClock(opensAt)}.` : 'The restaurant is closed right now.', cause);
    this.name = 'OutsideHoursError'; this.opensAt = opensAt; this.opensAtLabel = opensAt ? formatClock(opensAt) : null;
  }
}
export class RestaurantSettingsValidationError extends ServiceError {
  readonly fields: Partial<Record<SettingsField, string>>;
  constructor(fields: Partial<Record<SettingsField, string>>) { super('INVALID_SETTINGS', 'Check the restaurant details.'); this.name = 'RestaurantSettingsValidationError'; this.fields = fields; }
}

/** Mirror membership_display_name_valid. btrim trims ASCII spaces; ZWJ/ZWNJ are allowed. */
export function validateOwnerDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.startsWith(' ') || value.endsWith(' ') || [...value].length < 1 || [...value].length > 60 ||
    /[\u0000-\u001f\u007f-\u009f\u00A0\u00AD\u2000-\u200B\u200E\u200F\u2028-\u202F\u205F\u2060\u2066-\u2069\u3000\uFEFF]/u.test(value) ||
    [...value].some(char => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff)) {
    throw new ServiceError('INVALID_OWNER_NAME', 'Enter an owner name of 1 to 60 characters without control or invisible characters.');
  }
  return value;
}
function ownerNameResponse(value: unknown, userId: string, businessId: string, membership: boolean): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid owner details.');
  const row = value as Record<string, unknown>;
  if (row.user_id !== userId || row.business_id !== businessId || (membership && row.role !== 'admin')) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid owner details.');
  try { return validateOwnerDisplayName(row.display_name); }
  catch { throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid owner name.'); }
}

function mapRestaurantSettings(value: unknown): RestaurantSettings {
  const row = value as Record<string, unknown> | null;
  if (!row || (row.contact_phone !== null && (typeof row.contact_phone !== 'string' || !/^\+91[1-9][0-9]{9}$/.test(row.contact_phone))) ||
      (row.whatsapp_phone !== null && (typeof row.whatsapp_phone !== 'string' || !/^\+91[6-9][0-9]{9}$/.test(row.whatsapp_phone))) ||
      !Number.isInteger(row.settings_version) || (row.settings_version as number) < 1 || (row.settings_version as number) > 2147483647 ||
      !Number.isInteger(row.delivery_fee_paise) || (row.delivery_fee_paise as number) < 0 || (row.delivery_fee_paise as number) > 100000 ||
      !Number.isInteger(row.min_order_paise) || (row.min_order_paise as number) < 0 || (row.min_order_paise as number) > 1000000) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid restaurant details.');
  return { contactPhone: row.contact_phone as string | null, whatsappPhone: row.whatsapp_phone as string | null, deliveryFeePaise: row.delivery_fee_paise as number, minOrderPaise: row.min_order_paise as number, version: row.settings_version as number };
}
/** Strict mapping of the read: the four settings plus order prefix and delivery-area status columns. */
export function mapRestaurantSettingsView(value: unknown): RestaurantSettingsView {
  const settings = mapRestaurantSettings(value);
  const row = value as Record<string, unknown>;
  const text = (field: unknown) => field === null || field === undefined || typeof field === 'string';
  if (typeof row.order_prefix !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(row.order_prefix) || !text(row.service_area_source) || !text(row.service_area_version) || !text(row.service_area_verified_at)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid restaurant details.');
  const source = (row.service_area_source as string | null | undefined)?.trim(), version = (row.service_area_version as string | null | undefined)?.trim();
  let deliveryArea: DeliveryAreaStatus = { kind: 'unverified' };
  if (source && version && row.service_area_verified_at) {
    const radius = version.match(/^radius-([0-9]{3,5})m$/);
    const metres = radius ? Number(radius[1]) : 0;
    deliveryArea = metres >= 500 && metres <= 50000 ? { kind: 'radius', radiusM: metres } : { kind: 'verified' };
  }
  return { ...settings, orderPrefix: row.order_prefix, deliveryArea, openingHours: mapOpeningHours(row.opens_at, row.closes_at) };
}
/** Strict: both null (or absent) is no hours; otherwise both must be whole-minute times and form a valid window. */
export function mapOpeningHours(opens: unknown, closes: unknown): OpeningHours | null {
  if ((opens === null || opens === undefined) && (closes === null || closes === undefined)) return null;
  const opensAt = clockFromDatabase(opens), closesAt = clockFromDatabase(closes);
  if (!opensAt || !closesAt || Object.keys(validateOpeningHours(opensAt, closesAt).errors).length) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid opening hours.');
  return { opensAt, closesAt };
}
/** PT409 with detail OUTSIDE_HOURS and the opening time as the hint. Must run before the generic PT409 (switch off) mapping. */
function outsideHoursError(error: { code?: string; details?: string | null; hint?: string | null } | null): void {
  if (error?.code === 'PT409' && error.details === 'OUTSIDE_HOURS') throw new OutsideHoursError(clockFromDatabase(error.hint ?? null), error);
}

export type OfferErrorCode = 'OFFER_NOT_FOUND' | 'OFFER_NOT_ELIGIBLE' | 'OFFER_USED_UP' | 'OFFER_CHANGED' | 'OFFER_RATE_LIMITED';
/** Why the server refused an offer. Stable machine values; the wording is fixed here (server text is never shown). */
export type OfferReason = 'not_found' | 'paused' | 'ended' | 'not_started' | 'outside_window' | 'used_up' | 'first_order_only' | 'per_customer_limit' | 'min_order' | 'no_benefit' | 'rate_limited' | 'changed';
const offerReasons: ReadonlySet<string> = new Set(['not_found', 'paused', 'ended', 'not_started', 'outside_window', 'used_up', 'first_order_only', 'per_customer_limit', 'min_order', 'no_benefit', 'rate_limited', 'changed']);
const offerMessages: Record<OfferReason, string> = {
  not_found: 'That code is not valid.', paused: 'This offer is not available right now.', ended: 'This offer has ended.', not_started: 'This offer has not started yet.',
  outside_window: 'This offer is not available at this time of day.', used_up: 'This offer has been fully used.', first_order_only: 'This offer is only for your first order with this restaurant.',
  per_customer_limit: 'You\'ve already used this code', min_order: 'Your order is below the minimum for this offer.', no_benefit: 'This offer would not save anything on this order.',
  rate_limited: 'Too many tries. Please wait a little and try again.', changed: 'The offer on your order has changed. Review the new total.',
};
/** Offer failures with stable codes. `reason` is the server's reason; `shortfallPaise` is set for min_order; `retryAfterSeconds` for OFFER_RATE_LIMITED. */
export class OfferError extends ServiceError {
  readonly reason: OfferReason;
  readonly shortfallPaise?: number;
  readonly retryAfterSeconds?: number;
  /** For OFFER_CHANGED: the cart as the server now prices it. Review it, then place with a fresh idempotency key. */
  readonly pricing?: PricingTerms;
  constructor(code: OfferErrorCode, reason: OfferReason, extra: { shortfallPaise?: number; retryAfterSeconds?: number; pricing?: PricingTerms; cause?: unknown } = {}) {
    super(code, offerMessages[reason], extra.cause); this.name = 'OfferError'; this.reason = reason;
    if (extra.shortfallPaise !== undefined) this.shortfallPaise = extra.shortfallPaise;
    if (extra.retryAfterSeconds !== undefined) this.retryAfterSeconds = extra.retryAfterSeconds;
    if (extra.pricing) this.pricing = extra.pricing;
  }
}
/** Map a server reason to its code. Unknown reasons become the generic, safe OFFER_NOT_ELIGIBLE / OFFER_CHANGED. */
export function offerError(reason: unknown, extra: { shortfallPaise?: unknown; retryAfterSeconds?: unknown; pricing?: PricingTerms; changed?: boolean; cause?: unknown } = {}): OfferError {
  const known: OfferReason = typeof reason === 'string' && offerReasons.has(reason) ? reason as OfferReason : 'changed';
  const safe = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : undefined;
  const detail = { shortfallPaise: safe(extra.shortfallPaise), retryAfterSeconds: safe(extra.retryAfterSeconds), pricing: extra.pricing, cause: extra.cause };
  if (extra.changed) return new OfferError('OFFER_CHANGED', known, detail);
  if (known === 'not_found') return new OfferError('OFFER_NOT_FOUND', known, detail);
  if (known === 'used_up') return new OfferError('OFFER_USED_UP', known, detail);
  if (known === 'rate_limited') return new OfferError('OFFER_RATE_LIMITED', known, { ...detail, retryAfterSeconds: detail.retryAfterSeconds ?? 60 });
  return new OfferError('OFFER_NOT_ELIGIBLE', known, detail);
}

// ---- Owner offers (#182 slice B) -------------------------------------------------------------------------------------
export type OfferApplyMode = 'automatic' | 'code';
/** Derived, never stored. An ended offer wins over everything, then used up, then paused, then scheduled. */
export type OfferStatus = 'scheduled' | 'active' | 'paused' | 'ended' | 'used_up';
/** A daily happy-hour window in Asia/Kolkata. `from` and `to` are "HH:MM"; `from` later than `to` runs past midnight. Days are ISO weekdays: 1 = Monday ... 7 = Sunday. */
export interface OfferWindow { from: string; to: string; days: number[] }
/** What an owner sets. `value` is a whole percent for `percent`, paise for `flat` and null for `free_delivery`. Money is paise; times are ISO instants. */
export interface OfferInput {
  name: string; kind: OfferKind; value: number | null; maxDiscountPaise: number | null; minOrderPaise: number;
  applyMode: OfferApplyMode; code: string | null; firstOrderOnly: boolean; perCustomerLimit: number | null; totalLimit: number | null;
  startsAt: string | null; endsAt: string | null; window: OfferWindow | null;
}
/** Only these two stay editable once an offer has been used. */
export type OfferLockedPatch = Partial<Pick<OfferInput, 'name' | 'endsAt'>>;
/** An offer as the owner sees it. `useCount` and `discountGivenPaise` count non-cancelled orders only; `termsLocked` is true once ANY redemption exists, even on a since-cancelled order, because that is what the database locks on. */
export interface OwnerOffer extends OfferInput {
  id: string; version: number; paused: boolean; createdAt: string;
  status: OfferStatus; useCount: number; discountGivenPaise: number; termsLocked: boolean;
  /** False when usage could not be read: counts are then 0, terms are not treated as locked, and the database decides (PT409). */
  usageKnown: boolean;
}
/** Is the daily window open at this instant, in India time? Same rule as the database (a window past midnight belongs to the day it starts on). */
export function offerWindowOpen(window: OfferWindow | null, now: Date): boolean {
  if (!window) return true;
  const ist = new Date(now.getTime() + 330 * 60000), t = ist.getUTCHours() * 60 + ist.getUTCMinutes(), day = ist.getUTCDay() || 7, previous = day === 1 ? 7 : day - 1;
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)), from = minutes(window.from), to = minutes(window.to);
  return from < to ? window.days.includes(day) && t >= from && t < to : (window.days.includes(day) && t >= from) || (window.days.includes(previous) && t < to);
}
/** One offer as it was applied to the orders of a day: from the orders' own offer snapshot, so it stays right after the offer changes or ends. */
export interface DayOffer { offerId: string; name: string; code: string | null; kind: OfferKind; uses: number; givenPaise: number }
/** `running` (today only) is the active offers with no use today, or null when they could not be read. `state` is honest about what is known: running now, active but outside its happy-hour window (see `window`), or active with a total limit whose remaining uses could not be checked. */
export interface DayOffers { dateISO: string; used: DayOffer[]; orderCount: number; totalGivenPaise: number; running: { id: string; name: string; code: string | null; kind: OfferKind; state: 'running' | 'outside_window' | 'unconfirmed'; window: OfferWindow | null }[] | null }
export type OfferField = 'name' | 'kind' | 'value' | 'maxDiscount' | 'minOrder' | 'applyMode' | 'code' | 'perCustomerLimit' | 'totalLimit' | 'startsAt' | 'endsAt' | 'window' | 'expectedVersion';
export const offerFieldMessages: Record<OfferField, string> = {
  name: 'Enter a name of 3 to 40 characters.', kind: 'Choose percent off, flat off or free delivery.', value: 'Enter a percent from 1 to 90, or a flat amount from ₹1 to ₹1,000.',
  maxDiscount: 'Enter a maximum discount from ₹1 to ₹1,000, for percent offers only.', minOrder: 'Enter a minimum order from ₹0 to ₹10,000.', applyMode: 'Choose automatic or code.',
  code: 'Enter a code of 4 to 15 letters and numbers, and only for offers applied by code.', perCustomerLimit: 'Enter a limit from 1 to 99.', totalLimit: 'Enter a limit from 1 to 100,000.',
  startsAt: 'Enter a valid start date and time.', endsAt: 'The end must be after the start.', window: 'Choose a from and to time that differ, and at least one day.', expectedVersion: 'Reload the offer before saving.',
};
export class OfferValidationError extends ServiceError {
  readonly fields: Partial<Record<OfferField, string>>;
  constructor(fields: Partial<Record<OfferField, string>>) { super('INVALID_OFFER', 'Check the highlighted offer fields.'); this.name = 'OfferValidationError'; this.fields = fields; }
}
export type OwnerOfferErrorCode = 'OFFER_LOCKED' | 'OFFER_STALE' | 'OFFER_CODE_TAKEN' | 'OFFER_MISSING';
const ownerOfferMessages: Record<OwnerOfferErrorCode, string> = {
  OFFER_LOCKED: 'Terms are locked once an offer has been used. End it and create a new one to change them.',
  OFFER_STALE: 'Another owner changed this offer. Reload to see the latest.',
  OFFER_CODE_TAKEN: 'Another active or scheduled offer already uses this code.',
  OFFER_MISSING: 'This offer no longer exists, or you no longer have access to it.',
};
/** Owner write failures with stable codes; the wording is fixed here (server text is never shown). */
export class OwnerOfferError extends ServiceError {
  constructor(code: OwnerOfferErrorCode, cause?: unknown) { super(code, ownerOfferMessages[code], cause); this.name = 'OwnerOfferError'; }
}
const offerKinds: ReadonlySet<string> = new Set(['percent', 'flat', 'free_delivery']);
const clockPattern = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const instant = (v: unknown): number | null => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const nameProblem = (v: unknown) => typeof v !== 'string' || [...v.trim()].length < 3 || [...v.trim()].length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(v);

/** Mirrors the table's check constraints, so a bad value is caught before it is sent. The database stays the authority. */
export function validateOffer(input: OfferInput): OfferInput {
  const f: Partial<Record<OfferField, string>> = {};
  const int = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
  const optionalInt = (v: unknown, min: number, max: number) => v === null || int(v, min, max);
  if (nameProblem(input?.name)) f.name = offerFieldMessages.name;
  if (!offerKinds.has(input?.kind)) f.kind = offerFieldMessages.kind;
  else if (input.kind === 'percent' ? !int(input.value, 1, 90) : input.kind === 'flat' ? !int(input.value, 100, 100000) : input.value !== null) f.value = offerFieldMessages.value;
  if (input?.maxDiscountPaise !== null && (input?.kind !== 'percent' || !int(input.maxDiscountPaise, 100, 100000))) f.maxDiscount = offerFieldMessages.maxDiscount;
  if (!int(input?.minOrderPaise, 0, 1000000)) f.minOrder = offerFieldMessages.minOrder;
  const code = typeof input?.code === 'string' ? input.code.trim().toUpperCase() : null;
  if (input?.applyMode !== 'automatic' && input?.applyMode !== 'code') f.applyMode = offerFieldMessages.applyMode;
  else if (input.applyMode === 'code' ? !code || !/^[A-Z0-9]{4,15}$/.test(code) : input.code !== null) f.code = offerFieldMessages.code;
  if (!optionalInt(input?.perCustomerLimit, 1, 99)) f.perCustomerLimit = offerFieldMessages.perCustomerLimit;
  if (!optionalInt(input?.totalLimit, 1, 100000)) f.totalLimit = offerFieldMessages.totalLimit;
  const starts = input?.startsAt === null ? null : instant(input?.startsAt), ends = input?.endsAt === null ? null : instant(input?.endsAt);
  if (starts === null && input?.startsAt !== null) f.startsAt = offerFieldMessages.startsAt;
  if (ends === null && input?.endsAt !== null) f.endsAt = 'Enter a valid end date and time.';
  else if (starts !== null && ends !== null && ends <= starts) f.endsAt = offerFieldMessages.endsAt;
  const w = input?.window;
  const days = w ? [...new Set(w.days)].sort((a, b) => a - b) : [];
  if (w !== null && (!w || typeof w !== 'object' || !clockPattern.test(w.from) || !clockPattern.test(w.to) || w.from === w.to || !Array.isArray(w.days) || !days.length || days.some(d => !int(d, 1, 7)))) f.window = offerFieldMessages.window;
  if (Object.keys(f).length) throw new OfferValidationError(f);
  return { name: input.name.trim(), kind: input.kind, value: input.value, maxDiscountPaise: input.maxDiscountPaise, minOrderPaise: input.minOrderPaise, applyMode: input.applyMode, code: input.applyMode === 'code' ? code : null,
    firstOrderOnly: input.firstOrderOnly === true, perCustomerLimit: input.perCustomerLimit, totalLimit: input.totalLimit, startsAt: starts === null ? null : new Date(starts).toISOString(), endsAt: ends === null ? null : new Date(ends).toISOString(),
    window: w ? { from: w.from, to: w.to, days } : null };
}
/** A patch is either every term (an offer nobody has used yet) or only the name and end date (which stay editable). */
export function validateOfferPatch(patch: OfferInput | OfferLockedPatch): OfferInput | OfferLockedPatch {
  if (!patch || typeof patch !== 'object') throw new OfferValidationError({ name: offerFieldMessages.name });
  const keys = Object.keys(patch).filter(key => (patch as Record<string, unknown>)[key] !== undefined);
  if (keys.some(key => key !== 'name' && key !== 'endsAt')) return validateOffer(patch as OfferInput);
  const f: Partial<Record<OfferField, string>> = {}, out: OfferLockedPatch = {};
  if (keys.includes('name')) { if (nameProblem(patch.name)) f.name = offerFieldMessages.name; else out.name = (patch.name as string).trim(); }
  if (keys.includes('endsAt')) {
    const ends = patch.endsAt === null ? null : instant(patch.endsAt);
    if (ends === null && patch.endsAt !== null) f.endsAt = 'Enter a valid end date and time.'; else out.endsAt = ends === null ? null : new Date(ends).toISOString();
  }
  if (!keys.length) f.name = offerFieldMessages.name;
  if (Object.keys(f).length) throw new OfferValidationError(f);
  return out;
}
/** Status from the stored terms and the number of non-cancelled uses, as the database evaluates them. */
export function deriveOfferStatus(offer: { paused: boolean; startsAt: string | null; endsAt: string | null; totalLimit: number | null }, useCount: number, now: Date = new Date()): OfferStatus {
  const t = now.getTime();
  if (offer.endsAt !== null && Date.parse(offer.endsAt) <= t) return 'ended';
  if (offer.totalLimit !== null && useCount >= offer.totalLimit) return 'used_up';
  if (offer.paused) return 'paused';
  if (offer.startsAt !== null && Date.parse(offer.startsAt) > t) return 'scheduled';
  return 'active';
}
const offerSelect = 'id, business_id, name, kind, value, max_discount_paise, min_order_paise, apply_mode, code, first_order_only, per_customer_limit, total_limit, starts_at, ends_at, window_from, window_to, window_days, paused, created_at, version';
const offerColumns = (v: OfferInput) => ({ name: v.name, kind: v.kind, value: v.value, max_discount_paise: v.maxDiscountPaise, min_order_paise: v.minOrderPaise, apply_mode: v.applyMode, code: v.code,
  first_order_only: v.firstOrderOnly, per_customer_limit: v.perCustomerLimit, total_limit: v.totalLimit, starts_at: v.startsAt, ends_at: v.endsAt, window_from: v.window?.from ?? null, window_to: v.window?.to ?? null, window_days: v.window?.days ?? null });
const offerConstraintFields: Record<string, OfferField> = { offer_name_valid: 'name', offer_kind_valid: 'kind', offer_value_valid: 'value', offer_max_discount_valid: 'maxDiscount', offer_min_order_valid: 'minOrder', offer_apply_mode_valid: 'applyMode',
  offer_code_valid: 'code', offer_per_customer_limit_valid: 'perCustomerLimit', offer_total_limit_valid: 'totalLimit', offer_dates_valid: 'endsAt', offer_window_complete: 'window', offer_window_valid: 'window' };
type OfferRow = Record<string, unknown>;
function mapOwnerOffer(value: unknown, stat: { uses: number; given: number; redeemed: number } | undefined | 'unknown', now: Date): OwnerOffer {
  const bad = () => { throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid offer.'); };
  const row = value as OfferRow | null;
  const nullableInt = (v: unknown) => v === null || Number.isSafeInteger(v);
  const time = (v: unknown) => v === null ? null : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : bad() as never;
  if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !orderIdPattern.test(row.id) || typeof row.name !== 'string' || typeof row.kind !== 'string' || !offerKinds.has(row.kind) || !nullableInt(row.value) || !nullableInt(row.max_discount_paise) ||
      !Number.isSafeInteger(row.min_order_paise) || (row.apply_mode !== 'automatic' && row.apply_mode !== 'code') || !(row.code === null || typeof row.code === 'string') || typeof row.first_order_only !== 'boolean' || !nullableInt(row.per_customer_limit) ||
      !nullableInt(row.total_limit) || typeof row.paused !== 'boolean' || !Number.isSafeInteger(row.version) || (row.version as number) < 1 || typeof row.created_at !== 'string') return bad();
  const clock = (v: unknown) => typeof v === 'string' && /^\d\d:\d\d/.test(v) ? v.slice(0, 5) : bad() as never;
  const days = row.window_days;
  const window = row.window_from === null || row.window_from === undefined ? null : { from: clock(row.window_from), to: clock(row.window_to), days: Array.isArray(days) && days.every(d => Number.isSafeInteger(d)) ? [...days as number[]].sort((a, b) => a - b) : bad() as never };
  const base = { name: row.name, kind: row.kind as OfferKind, value: row.value as number | null, maxDiscountPaise: row.max_discount_paise as number | null, minOrderPaise: row.min_order_paise as number, applyMode: row.apply_mode as OfferApplyMode,
    code: row.code as string | null, firstOrderOnly: row.first_order_only, perCustomerLimit: row.per_customer_limit as number | null, totalLimit: row.total_limit as number | null, startsAt: time(row.starts_at), endsAt: time(row.ends_at), window };
  const usage = stat === 'unknown' ? undefined : stat, uses = usage?.uses ?? 0;
  return { ...base, id: row.id, version: row.version as number, paused: row.paused, createdAt: new Date(row.created_at).toISOString(), status: deriveOfferStatus({ ...base, paused: row.paused }, uses, now), useCount: uses, discountGivenPaise: usage?.given ?? 0, termsLocked: (usage?.redeemed ?? 0) > 0, usageKnown: stat !== 'unknown' };
}
/** Map a failed offer write to a typed error with a stable code (check violations become field errors). */
function offerWriteError(error: { message: string; code?: string; details?: string | null }): never {
  if (error.code === 'PT409' && error.details === 'OFFER_LOCKED') throw new OwnerOfferError('OFFER_LOCKED', error);
  if (error.code === '23505') throw new OwnerOfferError('OFFER_CODE_TAKEN', error);
  if (error.code === '23514') {
    const constraint = /constraint "([a-z_]+)"/.exec(`${error.message} ${error.details ?? ''}`)?.[1];
    const field = constraint ? offerConstraintFields[constraint] : undefined;
    throw field ? new OfferValidationError({ [field]: offerFieldMessages[field] }) : new ServiceError('INVALID_OFFER', 'Check the offer and try again.', error);
  }
  inactiveSessionError(error);
  if (error.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your owner access changed. Sign in again before changing offers.', error);
  fail(error, 'Could not save the offer');
  throw new ServiceError('BACKEND_ERROR', 'Could not save the offer.', error);
}
const offerRetryable = (error: { code?: string } | null) => error?.code === '40P01' || error?.code === '40001';

/** Only constructed after validating an explicit transactional no-order response. */
export class PricingChangedError extends ServiceError {
  readonly pricing: PricingTerms;
  constructor(pricing: PricingTerms) { super('PRICING_CHANGED', 'Prices or order terms have changed. Review the revised quote.'); this.pricing = pricing; }
}
export function validateRevisedPricing(value: unknown, lines: readonly CartLine[]): PricingTerms {
  const invalid = () => { throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid revised quote.'); };
  if (!value || typeof value !== 'object') return invalid();
  const q = value as PricingTerms;
  const amount = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 2147483647;
  if (!Array.isArray(q.lines) || !q.lines.length || q.lines.length !== lines.length || ![q.delivery_fee_paise, q.min_order_paise, q.subtotal_paise, q.total_paise].every(amount)) return invalid();
  let subtotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const a = q.lines[i], b = lines[i];
    if (!a || a.menu_item_id !== b.item.id || a.quantity !== b.quantity || !amount(a.unit_price_paise) || a.unit_price_paise <= 0 || !amount(a.line_total_paise) || a.line_total_paise !== a.unit_price_paise * a.quantity) return invalid();
    subtotal += a.line_total_paise;
  }
  // An offer is all-or-nothing: no offer means exactly the old contract, an offer carries a positive discount and its snapshot.
  const hasOffer = q.discount_paise !== undefined || q.offer !== undefined;
  const offer = q.offer as Partial<OfferSnapshot> | undefined;
  if (hasOffer && (!amount(q.discount_paise) || (q.discount_paise as number) <= 0 || !offer || typeof offer !== 'object' || typeof offer.id !== 'string' || !orderIdPattern.test(offer.id) ||
      typeof offer.name !== 'string' || !offer.name.trim() || offer.name.length > 40 || !(offer.code === null || (typeof offer.code === 'string' && /^[A-Z0-9]{4,15}$/.test(offer.code))) ||
      (offer.kind !== 'percent' && offer.kind !== 'flat' && offer.kind !== 'free_delivery'))) return invalid();
  const discount = hasOffer ? q.discount_paise as number : 0;
  if (discount > subtotal + q.delivery_fee_paise || (offer?.kind === 'free_delivery' && discount !== q.delivery_fee_paise)) return invalid();
  if (q.subtotal_paise !== subtotal || q.total_paise !== subtotal + q.delivery_fee_paise - discount) return invalid();
  // Copy just the validated contract, never trust arbitrary metadata in the response.
  return { lines: q.lines.map(a => ({ menu_item_id: a.menu_item_id, quantity: a.quantity, unit_price_paise: a.unit_price_paise, line_total_paise: a.line_total_paise })), delivery_fee_paise: q.delivery_fee_paise, min_order_paise: q.min_order_paise, subtotal_paise: q.subtotal_paise, total_paise: q.total_paise,
    ...(hasOffer ? { discount_paise: discount, offer: { id: offer!.id!, name: offer!.name!, code: offer!.code as string | null, kind: offer!.kind as OfferKind } } : {}) };
}
const offerAmount = (v: unknown) => v === null || (Number.isSafeInteger(v) && (v as number) >= 0);
/** Offers are display data from the server; a malformed one is dropped by the caller as an invalid response. */
function activeOffer(v: unknown): ActiveOffer {
  const o = v as Record<string, unknown> | null;
  const bad = () => { throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid offer.'); };
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !orderIdPattern.test(o.id) || typeof o.name !== 'string' || (o.kind !== 'percent' && o.kind !== 'flat' && o.kind !== 'free_delivery') ||
      !offerAmount(o.value) || !offerAmount(o.max_discount_paise) || !Number.isSafeInteger(o.min_order_paise) || typeof o.first_order_only !== 'boolean' || !(o.ends_at === null || typeof o.ends_at === 'string')) return bad();
  const w = o.window as Record<string, unknown> | null | undefined;
  if (w && (typeof w.from !== 'string' || typeof w.to !== 'string' || !Array.isArray(w.days) || !w.days.every(d => Number.isInteger(d) && d >= 1 && d <= 7))) return bad();
  return { id: o.id, name: o.name, kind: o.kind, value: o.value as number | null, maxDiscountPaise: o.max_discount_paise as number | null, minOrderPaise: o.min_order_paise as number, firstOrderOnly: o.first_order_only,
    endsAtISO: o.ends_at as string | null, window: w ? { from: w.from as string, to: w.to as string, days: w.days as number[] } : null };
}

function demoRestaurantError(error: { code?: string; details?: string; message: string } | null): void {
  if (error?.code === '22023' && error.details === 'DEMO_RESTAURANT') {
    throw new ServiceError('NOT_ACCEPTING_ORDERS', 'This is a sample restaurant. Ordering is unavailable.', error);
  }
}

function fail(error: { message: string; code?: string } | null, action: string): void {
  if (error) throw new ServiceError(error.code ?? 'BACKEND_ERROR', `${action}: ${error.message}`, error);
}

/**
 * Phone-code login errors (#50). `code` is exactly one of these five, the wording is fixed here (server text is never
 * shown), and a wait stated by the server is `error.cause.retryAfterSeconds`. A failed CAPTCHA, a malformed number and
 * every unclassified failure are GENERIC; the screens validate the number and render the CAPTCHA before calling.
 */
export type OtpErrorCode = 'WRONG_OR_EXPIRED_CODE' | 'RESEND_COOLDOWN' | 'NOT_ON_WHATSAPP' | 'RATE_LIMITED' | 'GENERIC';
const otpMessages: Record<OtpErrorCode, string> = {
  WRONG_OR_EXPIRED_CODE: 'That code is wrong or has expired. Check it, or ask for a new code.',
  RESEND_COOLDOWN: 'Please wait a moment before asking for another code.',
  NOT_ON_WHATSAPP: 'We could not deliver the code on WhatsApp. Check the number.',
  RATE_LIMITED: 'Too many attempts. Please try again later.',
  GENERIC: 'Something went wrong. Please try again.',
};
export class OtpError extends ServiceError {
  constructor(code: OtpErrorCode, cause?: unknown, retryAfterSeconds?: number) {
    super(code, otpMessages[code], retryAfterSeconds === undefined ? cause : { retryAfterSeconds, error: cause });
    this.name = 'OtpError';
  }
}
/**
 * Maps a Supabase Auth failure. NOT_ON_WHATSAPP comes from the Send SMS hook (message NOT_ON_WHATSAPP,
 * supabase/functions/send-sms-hook) and so exists only for the customer request; the owners' request never sees it.
 */
function otpFailure(error: unknown, flow: 'request' | 'verify'): OtpError {
  const e = (error && typeof error === 'object' ? error : {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : 0, code = typeof e.code === 'string' ? e.code : '', message = typeof e.message === 'string' ? e.message : '';
  if (flow === 'request' && message.includes('NOT_ON_WHATSAPP')) return new OtpError('NOT_ON_WHATSAPP', error);
  const cooldown = /only request this after (\d{1,5}) seconds?/i.exec(message);
  if (code === 'over_sms_send_rate_limit' && cooldown) return new OtpError('RESEND_COOLDOWN', error, Number(cooldown[1]));
  if (code === 'over_sms_send_rate_limit' || code === 'over_request_rate_limit' || status === 429 || message.includes('RATE_LIMITED')) return new OtpError('RATE_LIMITED', error);
  if (flow === 'verify' && (code === 'otp_expired' || [400, 401, 403, 422].includes(status))) return new OtpError('WRONG_OR_EXPIRED_CODE', error);
  return new OtpError('GENERIC', error);
}

const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validOrderCursor(value: unknown): value is OrderCursor {
  if (!value || typeof value !== 'object') return false;
  const { createdAtISO, id } = value as OrderCursor;
  if (typeof id !== 'string' || !orderIdPattern.test(id) || typeof createdAtISO !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(createdAtISO);
  if (!match || !Number.isFinite(Date.parse(createdAtISO))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && hour <= 23 && minute <= 59 && second <= 59;
}
function orderPageOptions(value: OrderPageOptions): { cursor: OrderCursor | null; limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INVALID_ORDER_QUERY', 'Choose a valid order page.');
  const { cursor = null, limit = 20 } = value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ServiceError('INVALID_ORDER_QUERY', 'Order page size must be a whole number from 1 to 50.');
  if (cursor !== null && !validOrderCursor(cursor)) throw new ServiceError('INVALID_ORDER_QUERY', 'The order page cursor is invalid.');
  return { cursor: cursor === null ? null : { createdAtISO: cursor.createdAtISO, id: cursor.id }, limit };
}

function notificationPageOptions(value: NotificationPageOptions): { cursor: OrderCursor | null; limit: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError('INVALID_NOTIFICATION_QUERY', 'Choose a valid notification page.');
  const { cursor = null, limit = 20 } = value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !validOrderCursor(cursor))) {
    throw new ServiceError('INVALID_NOTIFICATION_QUERY', 'Choose a page size from 1 to 100 and a valid notification cursor.');
  }
  return { cursor: cursor ? { ...cursor } : null, limit };
}
const notificationStatuses = new Set<string>(['placed', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled']);
const invalidNotificationResponse = () => new ServiceError('INVALID_RESPONSE', 'The server returned invalid notifications.');
function notificationTime(value: string): bigint {
  // Date parses offsets correctly but loses sub-millisecond digits; restore them for keyset comparisons.
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
function mapCustomerNotification(value: unknown, userId: string, businessId: string, slug: BusinessSlug): CustomerNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidNotificationResponse();
  const row = value as Record<string, unknown>;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  if (row.user_id !== userId || row.business_id !== businessId || typeof row.id !== 'string' || !orderIdPattern.test(row.id) ||
    typeof row.order_id !== 'string' || !orderIdPattern.test(row.order_id) || typeof row.event_status !== 'string' || !notificationStatuses.has(row.event_status) ||
    !text(row.title, 120) || !text(row.body, 1000) || !validOrderCursor({ id: row.id, createdAtISO: row.created_at }) ||
    (row.read_at !== null && !validOrderCursor({ id: row.id, createdAtISO: row.read_at }))) throw invalidNotificationResponse();
  return { id: row.id, businessId: slug, orderId: row.order_id, eventStatus: row.event_status as OrderStatus,
    title: row.title, body: row.body, createdAtISO: row.created_at as string, readAtISO: row.read_at as string | null };
}
function failNotification(error: { message: string; code?: string } | null): void {
  if (error) throw new ServiceError(error.code === '22023' || error.code === '22P02' || error.code === '22007' ? 'INVALID_NOTIFICATION_QUERY' :
    error.code === '42501' ? 'NOTIFICATION_ACCESS_DENIED' : 'NOTIFICATION_REQUEST_FAILED', 'Could not update or load your notifications.', error);
}

/** SQLSTATE raised by place_order when the restaurant is closed for new orders (#58). */
const NOT_ACCEPTING_ORDERS_SQLSTATE = 'PT409';
/** SQLSTATE raised by place_order when the reviewed saved address was edited or deleted (#48). */
const ADDRESS_CHANGED_SQLSTATE = 'PT412';
const addressChanged = (cause?: unknown) => new ServiceError('ADDRESS_CHANGED', 'This address was changed or removed, maybe in the other app. Check it and try again.', cause);

// Lifecycle conflicts have distinct details; unrelated PT409 errors retain their existing mapping.
function lifecycleError(error: { code?: string; details?: string | null } | null): void {
  if (error?.code === 'PT403' && error.details === 'BUSINESS_JOIN_REQUIRED') throw new ServiceError('BUSINESS_JOIN_REQUIRED', 'Join this restaurant before placing an order.', error);
  if (error?.code === 'PT409' && error.details === 'BUSINESS_LIFECYCLE_PENDING') throw new ServiceError('BUSINESS_LIFECYCLE_PENDING', 'Your restaurant relationship is being updated. Retry when it finishes.', error);
  if (error?.code === 'PT409' && error.details === 'ACCOUNT_LIFECYCLE_PENDING') throw new ServiceError('ACCOUNT_LIFECYCLE_PENDING', 'This account is being deleted, so it can no longer be changed.', error);
}

// An unexpired JWT whose Auth session was deleted or has expired is refused by the database (#213): 42501 with detail
// INVALID_SESSION. Nothing was written; the person must sign in again.
function inactiveSessionError(error: { code?: string; details?: string | null } | null): void {
  if (error?.code === '42501' && error.details === 'INVALID_SESSION') throw new ServiceError('SIGN_IN_REQUIRED', 'Your session ended. Sign in again.', error);
}

/** The storage key is isolated by backend, business and audience. */
export function sessionStorageKey(url: string, slug: BusinessSlug, audience: AppAudience): string {
  return `market:${encodeURIComponent(url.replace(/\/+$/, ''))}:${slug}:${audience}`;
}

/** Accept only client-facing keys; decoding the JWT here does not verify its signature. */
function isPublicKey(key: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    let bits = 0, buffer = 0, decoded = '';
    for (const char of encoded) {
      buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) { bits -= 8; decoded += String.fromCharCode((buffer >> bits) & 255); }
    }
    return JSON.parse(decoded).role === 'anon';
  } catch { return false; }
}

// JWT claims here are only a local equality guard; the backend verifies the signature,
// active session and ownership on every RPC. Missing or malformed claims fail closed.
function sessionIdentity(token: string): { userId: string; sessionId: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0, buffer = 0, decoded = '';
    for (const char of parts[1].replace(/-/g, '+').replace(/_/g, '/')) {
      buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
      if (bits >= 8) { bits -= 8; decoded += String.fromCharCode((buffer >> bits) & 255); }
    }
    const claims = JSON.parse(decoded);
    return typeof claims.sub === 'string' && claims.sub && typeof claims.session_id === 'string' && claims.session_id
      ? { userId: claims.sub, sessionId: claims.session_id } : null;
  } catch { return null; }
}

/** Retain the current session in memory if storage is blocked or fails. */
function safeStorage(backing: SupportedStorage) {
  const memory = new Map<string, string>();
  let available = true;
  const adapter: SupportedStorage = {
    async getItem(key) {
      if (available) try {
        const value = await backing.getItem(key);
        if (value != null) memory.set(key, value); else memory.delete(key);
        return value;
      } catch { available = false; }
      return memory.get(key) ?? null;
    },
    async setItem(key, value) {
      memory.set(key, value);
      if (available) try { await backing.setItem(key, value); } catch { available = false; }
    },
    async removeItem(key) {
      memory.delete(key);
      // Even after a read/write failure, try to remove an older persisted session.
      try { await backing.removeItem(key); } catch { available = false; }
    },
  };
  return { adapter, isAvailable: () => available };
}

// The direct property reads allow Expo to inline only public environment variables.
function publicConfig(): PublicConfig {
  return { url: process.env.EXPO_PUBLIC_SUPABASE_URL, anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY };
}

type MenuRow = { diet: Diet | null; id: string; name: string; description: string | null; category_id: string; menu_categories: { name: string; sort_order: number }; price_paise: number; available: boolean; is_demo: boolean; is_featured: boolean; sort_order: number; image_url: string | null };
type OrderRow = { order_number?: string | null; id: string; status: OrderStatus; version: number; subtotal_paise: number; delivery_fee_paise: number; total_paise: number; customer_name: string | null; customer_phone: string | null; delivery_address_line: string | null; latitude?: number | null; longitude?: number | null; created_at: string; address_label?: string | null; address_custom_label?: string | null; address_house?: string | null; address_street_area?: string | null; address_landmark?: string | null; address_location_source?: string | null; saved_address_id?: string | null; placed_from_distance_m?: number | null; kitchen_distance_m?: number | null; discount_paise?: number | null; offer_id?: string | null; offer_name?: string | null; offer_code?: string | null; offer_kind?: OfferKind | null; order_items: { diet: Diet | null; menu_item_id: string; name: string; quantity: number; unit_price_paise: number; line_total_paise: number }[]; order_status_history?: HistoryRow[] };
// Owner reads embed the snapshot; RLS returns null for anyone but that restaurant's owners.
type HistoryRow = { status: OrderStatus; created_at: string; order_status_actors?: { actor_name: string } | { actor_name: string }[] | null };
const actorName = (row: HistoryRow) => { const actor = Array.isArray(row.order_status_actors) ? row.order_status_actors[0] : row.order_status_actors; return typeof actor?.actor_name === 'string' ? { actorName: actor.actor_name } : {}; };
export function mapMenu(row: MenuRow, slug: BusinessSlug, storageBase = ''): MenuItem {
  return { id: row.id, businessId: slug, name: row.name, description: row.description ?? '', category: row.menu_categories.name, categoryId: row.category_id, categorySortOrder: row.menu_categories.sort_order, diet: row.diet, pricePaise: row.price_paise, isAvailable: row.available, isDemo: row.is_demo, isFeatured: row.is_featured, sortOrder: row.sort_order, ...(row.image_url ? { imageUrl: storageBase + row.image_url } : {}) };
}
// Only a complete snapshot becomes a structured address; older typed-address orders keep addressLine alone.
function orderAddress(row: OrderRow): { address?: OrderAddress; placedFromDistanceM?: number | null; kitchenDistanceM?: number | null } {
  if (!row.saved_address_id || !isAddressLabel(row.address_label) || !isAddressLocationSource(row.address_location_source) || !row.address_house || !row.address_street_area) return {};
  const address: OrderAddress = { label: row.address_label, house: row.address_house, streetArea: row.address_street_area, locationSource: row.address_location_source,
    ...(typeof row.address_custom_label === 'string' && row.address_custom_label ? { customLabel: row.address_custom_label } : {}), ...(typeof row.address_landmark === 'string' && row.address_landmark ? { landmark: row.address_landmark } : {}) };
  const distance = row.placed_from_distance_m;
  const kitchen = row.kitchen_distance_m;
  return { address, placedFromDistanceM: Number.isSafeInteger(distance) && (distance as number) >= 0 ? distance as number : null,
    kitchenDistanceM: Number.isSafeInteger(kitchen) && (kitchen as number) >= 0 ? kitchen as number : null };
}
type AddressRow = { id: string; label: string; custom_label: string | null; house: string; street_area: string; landmark: string | null; latitude: number; longitude: number; location_source: string; version: number; updated_at: string; in_area: boolean; distance_m: number | null };
export function mapSavedAddress(row: AddressRow): SavedAddress {
  const optionalText = (value: unknown) => value === null || value === undefined || typeof value === 'string';
  if (!row || typeof row.id !== 'string' || !isAddressLabel(row.label) || !isAddressLocationSource(row.location_source) || typeof row.house !== 'string' || !row.house.trim() || typeof row.street_area !== 'string' || !row.street_area.trim() ||
      !optionalText(row.custom_label) || !optionalText(row.landmark) || typeof row.updated_at !== 'string' ||
      !Number.isFinite(row.latitude) || row.latitude < -90 || row.latitude > 90 || !Number.isFinite(row.longitude) || row.longitude < -180 || row.longitude > 180 ||
      !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.in_area !== 'boolean') {
    throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid saved address.');
  }
  return { id: row.id, label: row.label, ...(row.custom_label ? { customLabel: row.custom_label } : {}), house: row.house, streetArea: row.street_area, ...(row.landmark ? { landmark: row.landmark } : {}),
    latitude: row.latitude, longitude: row.longitude, locationSource: row.location_source, version: row.version, updatedAtISO: row.updated_at,
    inArea: row.in_area, distanceM: Number.isSafeInteger(row.distance_m) && (row.distance_m as number) >= 0 ? row.distance_m : null };
}
/** Shown to owners for an order whose customer details were blanked after account deletion (#51). The phone is then empty, so no Call button. */
const DELETED_CUSTOMER_NAME = 'Deleted customer';
export function mapOrder(row: OrderRow, slug: BusinessSlug): Order {
  return { id: row.id, ...(row.order_number ? { orderNumber: row.order_number } : {}), businessId: slug, status: row.status, version: row.version, subtotalPaise: row.subtotal_paise, deliveryFeePaise: row.delivery_fee_paise, totalPaise: row.total_paise, ...(row.discount_paise ? { discountPaise: row.discount_paise } : {}), ...(row.offer_id && row.offer_name && row.offer_kind ? { offer: { id: row.offer_id, name: row.offer_name, code: row.offer_code ?? null, kind: row.offer_kind } } : {}), delivery: { name: row.customer_name ?? DELETED_CUSTOMER_NAME, phone: row.customer_phone ?? '', addressLine: row.delivery_address_line ?? 'Address removed' }, createdAtISO: row.created_at, ...(typeof row.latitude === 'number' && typeof row.longitude === 'number' ? { location: { latitude: row.latitude, longitude: row.longitude } } : {}), lines: row.order_items.map(item => ({ menuItemId: item.menu_item_id, diet: item.diet, name: item.name, quantity: item.quantity, unitPricePaise: item.unit_price_paise, lineTotalPaise: item.line_total_paise })), ...orderAddress(row), ...(row.order_status_history ? { history: row.order_status_history.map(item => ({ status: item.status, createdAtISO: item.created_at, ...actorName(item) })).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO)) } : {}) };
}
const menuSelect = '*, menu_categories!menu_items_category_business_fk(name, sort_order)';
// History columns are explicit: customers may read status and time only (#98).
const customerOrderSelect = '*, order_items(*), order_status_history(status, created_at)';
const ownerOrderSelect = '*, order_items(*), order_status_history(status, created_at, order_status_actors(actor_name))';

export function createMarketServices(options: ServiceOptions) {
  const { businessSlug: slug, audience } = options;
  const orderSelect = audience === 'admin' ? ownerOrderSelect : customerOrderSelect;
  const config = options.config ?? publicConfig();
  const url = config.url?.trim();
  const key = config.anonKey?.trim();
  const photoBase = `${url?.replace(/\/+$/, '')}/storage/v1/object/public/menu-images/`;
  if (Boolean(url) !== Boolean(key)) throw new ServiceError('INVALID_CONFIG', 'Set both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, or neither for demo browsing.');
  if (key && !isPublicKey(key)) throw new ServiceError('INVALID_CONFIG', 'Use a Supabase publishable key or legacy anon key for the client.');
  const persistence = safeStorage(options.storage ?? storage);
  const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { storage: persistence.adapter, storageKey: sessionStorageKey(url, slug, audience), persistSession: true, autoRefreshToken: true, flowType: 'pkce', detectSessionInUrl: false } }) : null;
  let disposed = false;
  let generation = 0;
  let sessionUserId: string | undefined;
  const subscriptions = new Set<() => void>();
  const publicSubscriptions = new Set<() => void>();
  const clearSubscriptions = () => { generation++; for (const unsubscribe of subscriptions) unsubscribe(); subscriptions.clear(); };
  const authListener = client?.auth.onAuthStateChange((event, session) => {
    const nextId = session?.user.id;
    if (event === 'SIGNED_OUT' || (sessionUserId && nextId !== sessionUserId)) clearSubscriptions();
    sessionUserId = nextId;
  }).data.subscription;
  const requireClient = () => {
    if (disposed) throw new ServiceError('DISPOSED', 'This service has been disposed.');
    if (!client) throw new ServiceError('DEMO_MODE', 'This is a sample menu. Connect the backend to sign in or place an order.');
    return client;
  };
  const getBusiness = async (): Promise<Business> => {
    if (!client) return { openingHours: null, id: slug, slug, name: businesses[slug].name, deliveryFeePaise: 0, minOrderPaise: 0, isDemo: true, orderingEnabled: false, acceptingOrders: false };
    const { data, error } = await client.from('businesses').select('id, slug, name, delivery_fee_paise, min_order_paise, is_demo, ordering_enabled, accepting_orders, contact_phone, whatsapp_phone, settings_version, opens_at, closes_at').eq('slug', slug).single();
    fail(error, 'Could not load business');
    if (!data) throw new ServiceError('NOT_FOUND', 'Business not found.');
    return { openingHours: mapOpeningHours(data.opens_at, data.closes_at), contactPhone: data.contact_phone ?? null, whatsappPhone: data.whatsapp_phone ?? null, settingsVersion: data.settings_version, id: data.id, slug, name: data.name, deliveryFeePaise: data.delivery_fee_paise, minOrderPaise: data.min_order_paise, isDemo: data.is_demo, orderingEnabled: data.ordering_enabled, acceptingOrders: data.accepting_orders === true };
  };
  const getMenu = async (): Promise<MenuItem[]> => {
    if (!client) return [{ id: `sample-${slug}`, businessId: slug, name: 'Sample dish', description: 'Sample menu item for browsing only.', category: 'Samples', categoryId: `sample-category-${slug}`, categorySortOrder: 0, diet: null, pricePaise: 0, isAvailable: false, isDemo: true, isFeatured: false, sortOrder: 0 }];
    const business = await getBusiness();
    const { data, error } = await client.from('menu_items').select(menuSelect).eq('business_id', business.id).order('sort_order').order('name').order('id');
    fail(error, 'Could not load menu');
    return (data ?? []).map(row => mapMenu(row as MenuRow, slug, photoBase));
  };
  const getOrders = async (): Promise<Order[]> => {
    const db = requireClient(); const business = await getBusiness();
    let query = db.from('orders').select(orderSelect).eq('business_id', business.id);
    if (audience === 'customer') {
      const { data: user, error: userError } = await db.auth.getUser(); fail(userError, 'Could not verify your account');
      if (!user.user) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to view orders.');
      query = query.eq('customer_id', user.user.id);
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    fail(error, 'Could not load orders');
    return (data ?? []).map(row => mapOrder(row as OrderRow, slug));
  };
  // These reads are explicitly customer-scoped, even when the customer also has
  // an admin membership (whose database policy can otherwise see all orders).
  const customerOrderScope = async () => {
    const db = requireClient(), started = generation;
    if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to view your order history.');
    const ensureCurrent = (userId?: string) => {
      if (disposed || generation !== started || (userId !== undefined && sessionUserId !== undefined && sessionUserId !== userId)) {
        throw new ServiceError('SESSION_CHANGED', 'Your account changed. Reload your orders.');
      }
    };
    const { data, error } = await db.auth.getUser();
    ensureCurrent(); fail(error, 'Could not verify your account');
    if (!data.user) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to view orders.');
    const userId = data.user.id;
    ensureCurrent(userId);
    const business = await getBusiness();
    ensureCurrent(userId);
    return { db, businessId: business.id, userId, ensureCurrent: () => ensureCurrent(userId) };
  };
  const readCustomerOrderPage = async (options: OrderPageOptions, activeOnly: boolean): Promise<OrderPage> => {
    const { cursor, limit } = orderPageOptions(options);
    const scope = await customerOrderScope();
    let query = scope.db.from('orders').select(customerOrderSelect).eq('business_id', scope.businessId).eq('customer_id', scope.userId);
    if (activeOnly) query = query.in('status', ['placed', 'accepted', 'preparing', 'out_for_delivery']);
    // Both values have a strict grammar before entering PostgREST's raw OR filter.
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAtISO},and(created_at.eq.${cursor.createdAtISO},id.lt.${cursor.id})`);
    const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
    scope.ensureCurrent(); fail(error, 'Could not load your orders');
    const rows = (data ?? []) as OrderRow[];
    const visible = rows.slice(0, limit), last = visible.at(-1);
    let nextCursor: OrderCursor | null = null;
    if (rows.length > limit && last) {
      nextCursor = { createdAtISO: last.created_at, id: last.id };
      if (!validOrderCursor(nextCursor)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid order page.');
    }
    return { orders: visible.map(row => mapOrder(row, slug)), nextCursor };
  };
  const getOrderHistory = (options: OrderPageOptions = {}) => readCustomerOrderPage(options, false);
  const getActiveOrders = (options: OrderPageOptions = {}) => readCustomerOrderPage(options, true);
  const getCustomerOrder = async (id: string): Promise<Order | null> => {
    if (typeof id !== 'string' || !orderIdPattern.test(id)) throw new ServiceError('INVALID_ORDER_QUERY', 'The order reference is invalid.');
    const scope = await customerOrderScope();
    const { data, error } = await scope.db.from('orders').select(customerOrderSelect).eq('business_id', scope.businessId).eq('customer_id', scope.userId).eq('id', id).maybeSingle();
    scope.ensureCurrent(); fail(error, 'Could not load your order');
    return data ? mapOrder(data as OrderRow, slug) : null;
  };
  // The customer profile (#45) belongs to the account, not to a restaurant, so its scope needs no business lookup.
  // Same identity rule as the order reads: a response that arrives after sign-out, an account switch or disposal is refused.
  const customerProfileScope = async () => {
    const db = requireClient(), started = generation;
    if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to view your profile.');
    const ensureCurrent = (userId?: string) => {
      if (disposed || generation !== started || (userId !== undefined && sessionUserId !== undefined && sessionUserId !== userId)) {
        throw new ServiceError('SESSION_CHANGED', 'Your account changed. Reload your profile.');
      }
    };
    const { data, error } = await db.auth.getUser();
    ensureCurrent();
    if (error?.name === 'AuthSessionMissingError') throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to view your profile.', error);
    fail(error, 'Could not verify your account');
    if (!data.user) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to view your profile.');
    const userId = data.user.id;
    ensureCurrent(userId);
    return { db, userId, ensureCurrent: () => ensureCurrent(userId) };
  };
  const profileSelect = 'user_id,full_name,updated_at';
  const mapProfile = (data: unknown, userId: string): CustomerProfile => {
    const row = data as { user_id?: unknown; full_name?: unknown; updated_at?: unknown } | null;
    if (!row || row.user_id !== userId || typeof row.full_name !== 'string' || typeof row.updated_at !== 'string' || !normalizeFullName(row.full_name).valid || normalizeFullName(row.full_name).name !== row.full_name) {
      throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid profile.');
    }
    return { fullName: row.full_name, updatedAtISO: row.updated_at };
  };
  /** Profile failures never echo server text. A CHECK or NOT NULL refusal means the name was invalid. */
  const profileError = (error: { code?: string; details?: string | null } | null) => {
    if (!error) return;
    inactiveSessionError(error); lifecycleError(error);
    // 23502 means an invalid name only because RLS runs before NOT NULL: a refused row never reaches the constraint.
    if (error.code === '23514' || error.code === '23502') throw new ServiceError('PROFILE_INVALID_NAME', FULL_NAME_MESSAGE, error);
    throw new ServiceError('PROFILE_REQUEST_FAILED', 'Could not reach your profile. Try again.', error);
  };
  /** The signed-in customer's own profile, or null when no name has been saved yet (the row is created on first save). */
  const getProfile = async (): Promise<CustomerProfile | null> => {
    const scope = await customerProfileScope();
    const { data, error } = await scope.db.from('profiles').select(profileSelect).eq('user_id', scope.userId).maybeSingle();
    scope.ensureCurrent(); profileError(error);
    return data ? mapProfile(data, scope.userId) : null;
  };
  /** Saves the name (trimmed, 1 to 120 characters) for the signed-in customer: an upsert of their own row, which the database pins to auth.uid(). */
  const saveProfile = async (input: SaveProfileInput): Promise<CustomerProfile> => {
    const { name, valid } = normalizeFullName(input?.fullName);
    if (!valid) throw new ServiceError('PROFILE_INVALID_NAME', FULL_NAME_MESSAGE);
    const scope = await customerProfileScope();
    // Only full_name is sent: user_id comes from the session in the database, so no request can name another account.
    const { data, error } = await scope.db.from('profiles').upsert({ full_name: name }, { onConflict: 'user_id' }).select(profileSelect).single();
    scope.ensureCurrent(); profileError(error);
    return mapProfile(data, scope.userId);
  };
  /**
   * Deletes the signed-in customer's account for both restaurant apps (#51). One database call does everything or nothing; calling it
   * again after a lost response returns the same confirmation. Refusals (nothing was changed): ACCOUNT_HAS_ACTIVE_ORDER while an order
   * is not delivered or cancelled, ONLY_OWNER while the person is the only owner of a restaurant, SIGN_IN_REQUIRED for a dead session.
   * The auth user itself is removed later by a trusted step; the account is unusable from this call on.
   */
  const requestAccountDeletion = async (): Promise<AccountDeletionReceipt> => {
    const scope = await customerProfileScope();
    const { data, error } = await scope.db.rpc('request_account_deletion');
    scope.ensureCurrent();
    if (error) {
      inactiveSessionError(error);
      lifecycleError(error);
      if (error.code === 'PT409' && error.details === 'ACCOUNT_HAS_ACTIVE_ORDER') throw new ServiceError('ACCOUNT_HAS_ACTIVE_ORDER', 'Finish your active orders before deleting your account.', error);
      if (error.code === 'PT409' && error.details === 'ONLY_OWNER') throw new ServiceError('ONLY_OWNER', 'Add another owner to your restaurant before deleting your account.', error);
      throw new ServiceError('ACCOUNT_DELETION_FAILED', 'Could not delete your account. Try again.', error);
    }
    const row = data as { customer_id?: unknown; state?: unknown; requested_at?: unknown } | null;
    if (!row || row.customer_id !== scope.userId || row.state !== 'deletion_pending' || typeof row.requested_at !== 'string' || Number.isNaN(Date.parse(row.requested_at))) {
      throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm the deletion. Try again.');
    }
    return { customerId: scope.userId, state: 'deletion_pending', requestedAtISO: row.requested_at };
  };
  const customerNotificationScope = async () => {
    try { return await customerOrderScope(); }
    catch (error) {
      if (error instanceof ServiceError && error.cause && typeof error.cause === 'object' && 'name' in error.cause && error.cause.name === 'AuthSessionMissingError') {
        throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to view notifications.', error);
      }
      throw error;
    }
  };
  const listNotifications = async (options: NotificationPageOptions = {}): Promise<NotificationPage> => {
    const { cursor, limit } = notificationPageOptions(options), scope = await customerNotificationScope();
    const { data, error } = await scope.db.rpc('list_customer_notifications', {
      p_business_slug: slug, p_limit: limit, p_before_created_at: cursor?.createdAtISO ?? null, p_before_id: cursor?.id ?? null,
    });
    scope.ensureCurrent(); failNotification(error);
    if (!Array.isArray(data) || data.length > limit + 1) throw invalidNotificationResponse();
    const rows = data.map(row => mapCustomerNotification(row, scope.userId, scope.businessId, slug));
    const seen = new Set<string>();
    let previous = cursor;
    for (const row of rows) {
      const key = row.id.toLowerCase();
      if (seen.has(key) || (previous && (notificationTime(row.createdAtISO) > notificationTime(previous.createdAtISO) ||
        (notificationTime(row.createdAtISO) === notificationTime(previous.createdAtISO) && key >= previous.id.toLowerCase())))) throw invalidNotificationResponse();
      seen.add(key); previous = { id: row.id, createdAtISO: row.createdAtISO };
    }
    const notifications = rows.slice(0, limit), last = notifications.at(-1);
    return { notifications, nextCursor: rows.length > limit && last ? { id: last.id, createdAtISO: last.createdAtISO } : null };
  };
  const markNotificationRead = async (id: string): Promise<boolean> => {
    if (typeof id !== 'string' || !orderIdPattern.test(id)) throw new ServiceError('INVALID_NOTIFICATION_QUERY', 'Choose a valid notification.');
    const scope = await customerNotificationScope();
    const { data, error } = await scope.db.rpc('mark_customer_notification_read', { p_business_slug: slug, p_notification_id: id });
    scope.ensureCurrent(); inactiveSessionError(error); failNotification(error);
    if (typeof data !== 'boolean') throw invalidNotificationResponse();
    return data;
  };
  const notificationCount = async (rpc: 'mark_all_customer_notifications_read' | 'customer_notification_unread_count'): Promise<number> => {
    const scope = await customerNotificationScope();
    const { data, error } = await scope.db.rpc(rpc, { p_business_slug: slug });
    scope.ensureCurrent(); inactiveSessionError(error); failNotification(error);
    if (!Number.isSafeInteger(data) || data < 0 || data > 2147483647) throw invalidNotificationResponse();
    return data;
  };
  const markAllNotificationsRead = () => notificationCount('mark_all_customer_notifications_read');
  const getUnreadNotificationCount = () => notificationCount('customer_notification_unread_count');
  // Explicit join also supports returning after leave. Checkout enrolls only never-linked
  // customers; retained left markers prevent automatic rejoin from placement/recovery.
  const joinBusiness = async (): Promise<CustomerBusinessRelationship> => {
    const db = requireClient(), started = generation;
    if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to join a restaurant.');
    const initial = await db.auth.getSession();
    const token = initial.data.session?.access_token;
    const expected = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Retry joining.');
    if (initial.error || !token || !expected || !orderIdPattern.test(expected.userId) || !orderIdPattern.test(expected.sessionId) || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in before joining.');
    const ensureCurrent = async () => {
      const current = await db.auth.getSession();
      const identity = current.data.session?.access_token ? sessionIdentity(current.data.session.access_token) : null;
      if (disposed || generation !== started || current.error || !identity || current.data.session?.user.id !== expected.userId ||
          identity.userId !== expected.userId || identity.sessionId !== expected.sessionId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Retry joining.');
    };
    try {
      const verified = await db.auth.getUser(token);
      await ensureCurrent();
      if (verified.error) {
        const status = verified.error.status;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in before joining.', verified.error);
        throw new ServiceError('BUSINESS_JOIN_FAILED', 'Could not verify your account.', verified.error);
      }
      if (verified.data.user?.id !== expected.userId) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm your account.');
      const business = await getBusiness();
      await ensureCurrent();
      if (!orderIdPattern.test(business.id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid restaurant.');
      const { data, error } = await db.rpc('join_business', { p_business_slug: slug }).setHeader('Authorization', `Bearer ${token}`);
      await ensureCurrent();
      if (error?.code === '42501') throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in again before joining.', error);
      if (error?.code === '22023' && error.details === 'INVALID_BUSINESS') throw new ServiceError('INVALID_BUSINESS', 'This restaurant is unavailable.', error);
      lifecycleError(error);
      if (error) throw new ServiceError('BUSINESS_JOIN_FAILED', 'Could not join this restaurant.', error);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.customer_id !== expected.userId || data.business_id !== business.id ||
          typeof data.generation !== 'string' || !orderIdPattern.test(data.generation) || data.state !== 'active' ||
          !validOrderCursor({ id: data.generation, createdAtISO: data.joined_at })) {
        throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid restaurant relationship.');
      }
      return { customerId: data.customer_id, businessId: data.business_id, generation: data.generation, joinedAtISO: data.joined_at, state: 'active' };
    } catch (error) {
      await ensureCurrent();
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('BUSINESS_JOIN_FAILED', 'Could not join this restaurant.', error);
    }
  };
  /** The signed-in customer's own restaurant links (RLS: self-select only), strictly validated. */
  const getMyRestaurants = async (): Promise<CustomerRestaurantLink[]> => {
    const db = requireClient(), started = generation;
    if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to see your restaurants.');
    const initial = await db.auth.getSession();
    const token = initial.data.session?.access_token;
    const expected = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Try again.');
    if (initial.error || !token || !expected || !orderIdPattern.test(expected.userId) || !orderIdPattern.test(expected.sessionId) || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to see your restaurants.');
    const { data, error } = await db.from('customer_businesses').select('business_id,generation,state,businesses(slug,name)').eq('customer_id', expected.userId);
    const current = await db.auth.getSession();
    const identity = current.data.session?.access_token ? sessionIdentity(current.data.session.access_token) : null;
    if (disposed || generation !== started || current.error || !identity || identity.userId !== expected.userId || identity.sessionId !== expected.sessionId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Try again.');
    if (error) throw new ServiceError('RESTAURANTS_UNAVAILABLE', 'Could not load your restaurants.', error);
    const invalid = () => new ServiceError('INVALID_RESPONSE', 'The server returned invalid restaurant links.');
    if (!Array.isArray(data) || data.length > 20) throw invalid();
    const seen = new Set<string>();
    return data.map((row: unknown) => {
      const r = row as { business_id?: unknown; generation?: unknown; state?: unknown; businesses?: { slug?: unknown; name?: unknown } | null } | null;
      const b = r?.businesses;
      if (!r || typeof r.business_id !== 'string' || !orderIdPattern.test(r.business_id) || seen.has(r.business_id.toLowerCase()) || typeof r.generation !== 'string' || !orderIdPattern.test(r.generation) ||
        (r.state !== 'active' && r.state !== 'leave_pending' && r.state !== 'left') || !b || Array.isArray(b) || (b.slug !== 'ammu-sammu' && b.slug !== 'kokani-dine-inn') ||
        typeof b.name !== 'string' || !b.name.trim() || b.name.length > 120 || /[\u0000-\u001f\u007f]/.test(b.name)) throw invalid();
      seen.add(r.business_id.toLowerCase());
      return { businessId: r.business_id, businessSlug: b.slug, businessName: b.name.trim(), generation: r.generation.toLowerCase(), state: r.state };
    });
  };
  const leaveBusiness = async (input: { requestId: string; generation: string }): Promise<LeaveBusinessReceipt> => {
    if (!input || typeof input.requestId !== 'string' || !orderIdPattern.test(input.requestId) ||
        typeof input.generation !== 'string' || !orderIdPattern.test(input.generation)) throw new ServiceError('INVALID_LEAVE_REQUEST', 'Use the original request ID and relationship generation.');
    // Copy before awaiting so callers cannot retarget an in-flight leave.
    const requestId = input.requestId.toLowerCase(), relationshipGeneration = input.generation.toLowerCase();
    const db = requireClient(), started = generation;
    if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Use the customer app to leave a restaurant.');
    const initial = await db.auth.getSession();
    const token = initial.data.session?.access_token;
    const expected = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Retry leaving.');
    if (initial.error || !token || !expected || !orderIdPattern.test(expected.userId) || !orderIdPattern.test(expected.sessionId) || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in before leaving.');
    const ensureCurrent = async () => {
      const current = await db.auth.getSession();
      const identity = current.data.session?.access_token ? sessionIdentity(current.data.session.access_token) : null;
      if (disposed || generation !== started || current.error || !identity || current.data.session?.user.id !== expected.userId ||
          identity.userId !== expected.userId || identity.sessionId !== expected.sessionId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Retry leaving.');
    };
    try {
      const verified = await db.auth.getUser(token);
      await ensureCurrent();
      if (verified.error) {
        const status = verified.error.status;
        if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in before leaving.', verified.error);
        throw new ServiceError('BUSINESS_LEAVE_FAILED', 'Could not verify your account.', verified.error);
      }
      if (verified.data.user?.id !== expected.userId) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm your account.');
      const business = await getBusiness();
      await ensureCurrent();
      if (!orderIdPattern.test(business.id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid restaurant.');
      const { data, error } = await db.rpc('leave_business', { p_business_slug: slug, p_request_id: requestId, p_generation: relationshipGeneration }).setHeader('Authorization', `Bearer ${token}`);
      await ensureCurrent();
      if (error?.code === '42501') throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in again before leaving.', error);
      if (error?.code === '22023' && error.details === 'INVALID_BUSINESS') throw new ServiceError('INVALID_BUSINESS', 'This restaurant is unavailable.', error);
      lifecycleError(error);
      const conflicts = new Set(['ACTIVE_ORDERS','LAST_BUSINESS','STALE_RELATIONSHIP','LEAVE_REQUEST_CONFLICT']);
      if (error?.code === 'PT409' && typeof error.details === 'string' && conflicts.has(error.details)) throw new ServiceError(error.details, 'The restaurant relationship cannot be left in its current state.', error);
      if (error?.code === '22023' && error.details === 'INVALID_LEAVE_REQUEST') throw new ServiceError('INVALID_LEAVE_REQUEST', 'Use the original request ID and relationship generation.', error);
      if (error) throw new ServiceError('BUSINESS_LEAVE_FAILED', 'Could not leave this restaurant. Retry with the same request ID.', error);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.customer_id !== expected.userId || data.business_id !== business.id ||
          data.generation !== relationshipGeneration || data.request_id !== requestId || data.state !== 'left' ||
          !validOrderCursor({ id: requestId, createdAtISO: data.started_at }) || !validOrderCursor({ id: requestId, createdAtISO: data.completed_at }) ||
          notificationTime(data.completed_at) < notificationTime(data.started_at)) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm leave completion. Retry with the same request ID.');
      // Server completion only. Screens perform generation-scoped cart/preferences cleanup and
      // local sign-out separately; an old receipt must never clear a later rejoin's device data.
      return { customerId: expected.userId, businessId: business.id, requestId, generation: relationshipGeneration,
        startedAtISO: data.started_at, completedAtISO: data.completed_at, state: 'left',
        localCleanup: { businessSlug: slug, generation: relationshipGeneration, requestId } };
    } catch (error) {
      await ensureCurrent();
      if (error instanceof ServiceError && ['SESSION_CHANGED','SIGN_IN_REQUIRED','INVALID_RESPONSE','INVALID_BUSINESS','INVALID_LEAVE_REQUEST','ACTIVE_ORDERS','LAST_BUSINESS','STALE_RELATIONSHIP','LEAVE_REQUEST_CONFLICT','BUSINESS_LIFECYCLE_PENDING','ACCOUNT_LIFECYCLE_PENDING','BUSINESS_LEAVE_FAILED'].includes(error.code)) throw error;
      if (error instanceof ServiceError && error.code === 'NOT_FOUND') throw new ServiceError('INVALID_BUSINESS', 'This restaurant is unavailable.', error);
      throw new ServiceError('BUSINESS_LEAVE_FAILED', 'Could not leave this restaurant.', error);
    }
  };
  const auth = {
    async session() { const { data, error } = await requireClient().auth.getSession(); fail(error, 'Could not restore session'); return data.session; },
    async signIn(email: string, password: string) { const { data, error } = await requireClient().auth.signInWithPassword({ email, password }); fail(error, 'Could not sign in'); return data; },
    async signUp(email: string, password: string, emailRedirectTo?: string) { const { data, error } = await requireClient().auth.signUp({ email, password, options: { emailRedirectTo } }); fail(error, 'Could not sign up'); return { ...data, confirmationRequired: !data.session }; },
    async resetPassword(email: string, redirectTo?: string) { const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo }); fail(error, 'Could not send password reset'); },
    async exchangeCodeForSession(code: string) { const { data, error } = await requireClient().auth.exchangeCodeForSession(code); fail(error, 'Could not complete the email link'); return data.session; },
    async setSession(accessToken: string, refreshToken: string) { const { data, error } = await requireClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken }); fail(error, 'Could not complete the email link'); return data.session; },
    async updatePassword(password: string) { const { data, error } = await requireClient().auth.updateUser({ password }); fail(error, 'Could not update password'); return data.user; },
    // Phone-code login (#50). Customers ask Supabase Auth directly; the Send SMS hook delivers the code on WhatsApp
    // whatever channel is named, so none is. Owners never call Auth to request a code (see requestOwnerCode).
    async requestCode(phone: string, captchaToken?: string) {
      if (audience !== 'customer') throw new ServiceError('CUSTOMER_REQUIRED', 'Owners request their code with requestOwnerCode.');
      const db = requireClient(); const e164 = settingsPhone(phone, true); if (!e164) throw new OtpError('GENERIC');
      const { error } = await db.auth.signInWithOtp({ phone: e164, options: { shouldCreateUser: true, ...(captchaToken ? { captchaToken } : {}) } });
      if (error) throw otpFailure(error, 'request');
    },
    // The server answers the same whether or not a code was sent (request-owner-code), so this resolves for every
    // number that passes the CAPTCHA, and the screen must look the same afterwards. It never reports NOT_ON_WHATSAPP.
    // An owner who asks again inside Auth's resend interval (30 s) is consumed silently, so the owners' screen must enforce
    // its own 30 s cooldown between requests.
    async requestOwnerCode(phone: string, captchaToken?: string) {
      if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Customers request their code with requestCode.');
      requireClient(); const e164 = settingsPhone(phone, true); if (!e164) throw new OtpError('GENERIC');
      let res: Response;
      try {
        res = await fetch(`${url!.replace(/\/+$/, '')}/functions/v1/request-owner-code`, {
          method: 'POST', headers: { apikey: key!, ...(key!.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: e164, slug, ...(captchaToken ? { captchaToken } : {}) }),
        });
      } catch (cause) { throw new OtpError('GENERIC', cause); }
      let body: { ok?: unknown; error?: unknown } | null = null;
      try { body = await res.json(); } catch { /* handled by status */ }
      if (res.ok && body?.ok === true) return;
      throw new OtpError(res.status === 429 ? 'RATE_LIMITED' : 'GENERIC');
    },
    // A new number creates a customer account here with no sign-up step. In the owners' app the code is verified on a
    // throwaway client (no persistence, no refresh, in-memory storage) and its session reaches the real client only if the
    // account is an admin member of this restaurant, so anyone else fails exactly like a wrong code and never touches the
    // real client's storage or auth events.
    async verifyCode(phone: string, code: string) {
      const db = requireClient(); const e164 = settingsPhone(phone, true); if (!e164) throw new OtpError('GENERIC');
      const token = typeof code === 'string' ? code.trim() : '';
      if (!/^[0-9]{6}$/.test(token)) throw new OtpError('WRONG_OR_EXPIRED_CODE');
      if (audience !== 'admin') {
        const { data, error } = await db.auth.verifyOtp({ phone: e164, token, type: 'sms' });
        if (error) throw otpFailure(error, 'verify');
        return data;
      }
      const memory = new Map<string, string>();
      const probe = createClient(url!, key!, { auth: {
        storage: { getItem: (name) => memory.get(name) ?? null, setItem: (name, value) => { memory.set(name, value); }, removeItem: (name) => { memory.delete(name); } },
        storageKey: `${sessionStorageKey(url!, slug, audience)}:verify`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      let admitted = false;
      try {
        const { data, error } = await probe.auth.verifyOtp({ phone: e164, token, type: 'sms' });
        if (error) throw otpFailure(error, 'verify');
        const accessToken = data.session?.access_token, refreshToken = data.session?.refresh_token, userId = data.user?.id;
        if (!accessToken || !refreshToken || !userId) throw new OtpError('GENERIC');
        let owner: boolean;
        try {
          const business = await getBusiness();
          const { data: member, error: memberError } = await probe.from('business_memberships').select('role').eq('business_id', business.id).eq('user_id', userId).eq('role', 'admin').maybeSingle();
          fail(memberError, 'Could not verify admin membership'); owner = !!member;
        } catch (cause) { throw new OtpError('GENERIC', cause); }
        if (!owner) throw new OtpError('WRONG_OR_EXPIRED_CODE');
        const { data: pinned, error: pinError } = await db.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (pinError || !pinned.session) throw otpFailure(pinError, 'verify');
        admitted = true;
        return pinned;
      } finally {
        // Revoke a non-owner's server session; an owner's lives on in the real client.
        if (!admitted) await probe.auth.signOut({ scope: 'local' }).catch(() => undefined);
      }
    },
    async signOut() { const db = requireClient(); clearSubscriptions(); const { error } = await db.auth.signOut({ scope: 'local' }); fail(error, 'Could not sign out'); },
    onChange(callback: Parameters<SupabaseClient['auth']['onAuthStateChange']>[0]) { const { data } = requireClient().auth.onAuthStateChange(callback); return () => data.subscription.unsubscribe(); },
  };
  const isAdmin = async (): Promise<boolean> => {
    const db = requireClient(); const business = await getBusiness();
    const { data: user, error: userError } = await db.auth.getUser(); fail(userError, 'Could not verify your account');
    if (!user.user) return false;
    const { data, error } = await db.from('business_memberships').select('role').eq('business_id', business.id).eq('user_id', user.user.id).eq('role', 'admin').maybeSingle();
    fail(error, 'Could not verify admin membership'); return !!data;
  };
  // The signed-in owner's display name for this restaurant (#98); null if unnamed or not an owner here.
  const getOwnerDisplayName = async (): Promise<string | null> => {
    const db = requireClient(); const business = await getBusiness();
    const { data: user, error: userError } = await db.auth.getUser(); fail(userError, 'Could not verify your account');
    if (!user.user) return null;
    const { data, error } = await db.from('business_memberships').select('display_name').eq('business_id', business.id).eq('user_id', user.user.id).eq('role', 'admin').maybeSingle();
    fail(error, 'Could not load your owner name');
    const name = (data as { display_name?: unknown } | null)?.display_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  };
  // The token is an equality guard here, never proof of authorization. The server verifies it.
  const ownerProfileScope = async () => {
    const db = requireClient(), started = generation;
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an owner account to manage your owner name.');
    const initial = await db.auth.getSession();
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your owner details.');
    const token = initial.data.session?.access_token;
    const expected = token ? sessionIdentity(token) : null;
    if (initial.error || !token || !expected || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in again to manage your owner name.');
    const ensureCurrent = async () => {
      if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your owner details.');
      const current = await db.auth.getSession();
      const accessToken = current.data.session?.access_token;
      const identity = accessToken ? sessionIdentity(accessToken) : null;
      if (disposed || generation !== started || current.error || !accessToken || !identity || current.data.session?.user.id !== expected.userId ||
        identity.userId !== expected.userId || identity.sessionId !== expected.sessionId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your owner details.');
      return accessToken;
    };
    const verified = await db.auth.getUser(token);
    await ensureCurrent();
    if (verified.error) {
      // Only a real rejection by Auth (4xx other than timeout/rate limit) means access is gone; transport and server failures are retryable.
      const status = (verified.error as { status?: unknown }).status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) throw new ServiceError('ADMIN_REQUIRED', 'Sign in again to verify your owner access.', verified.error);
      throw new ServiceError('OWNER_PROFILE_REQUEST_FAILED', 'Could not verify your account. Check your connection and try again.', verified.error);
    }
    if (!verified.data.user || verified.data.user.id !== expected.userId) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm your account.');
    const business = await getBusiness();
    const readToken = await ensureCurrent();
    if (typeof business.id !== 'string' || !orderIdPattern.test(business.id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid restaurant.');
    const { data, error } = await db.from('business_memberships').select('business_id, user_id, role, display_name')
      .eq('business_id', business.id).eq('user_id', expected.userId).eq('role', 'admin').maybeSingle()
      .setHeader('Authorization', `Bearer ${readToken}`);
    await ensureCurrent();
    if (error) throw new ServiceError('OWNER_PROFILE_REQUEST_FAILED', 'Could not load your owner details.', error);
    if (data === null) throw new ServiceError('ADMIN_REQUIRED', 'Current owner access is required.');
    const displayName = ownerNameResponse(data, expected.userId, business.id, true);
    return { db, userId: expected.userId, businessId: business.id, displayName, phone: verified.data.user.phone, ensureCurrent };
  };
  const getOwnerProfile = async (): Promise<OwnerProfile> => {
    const scope = await ownerProfileScope();
    const phone = scope.phone;
    if (phone !== undefined && phone !== null && phone !== '' && (typeof phone !== 'string' || !/^\+?[1-9][0-9]{6,14}$/.test(phone))) {
      throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid account phone.');
    }
    return { displayName: scope.displayName, phone: phone || null };
  };
  const setOwnerDisplayName = async (displayName: string): Promise<string> => {
    const valid = validateOwnerDisplayName(displayName), scope = await ownerProfileScope();
    const token = await scope.ensureCurrent();
    const { data, error } = await scope.db.rpc('set_owner_display_name', { p_business_slug: slug, p_display_name: valid })
      .setHeader('Authorization', `Bearer ${token}`);
    await scope.ensureCurrent();
    if (error?.code === '22023') throw new ServiceError('INVALID_OWNER_NAME', 'Enter an owner name of 1 to 60 characters without control or invisible characters.', error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your owner access changed. Sign in again before saving.', error);
    if (error) throw new ServiceError('OWNER_NAME_SAVE_FAILED', 'Could not save your owner name.', error);
    const saved = ownerNameResponse(data, scope.userId, scope.businessId, false);
    if (saved !== valid) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm the requested owner name.');
    return saved;
  };
  const requireAdminBusiness = async (): Promise<Business> => {
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an admin account to manage the menu.');
    const business = await getBusiness();
    if (!await isAdmin()) throw new ServiceError('ADMIN_REQUIRED', 'Admin membership is required to manage the menu.');
    return business;
  };
  const getRestaurantSettings = async (): Promise<RestaurantSettingsView> => {
    const db = requireClient(), started = generation;
    const business = await requireAdminBusiness();
    const { data, error } = await db.from('businesses').select('contact_phone, whatsapp_phone, delivery_fee_paise, min_order_paise, settings_version, order_prefix, service_area_source, service_area_version, service_area_verified_at, opens_at, closes_at').eq('id', business.id).single();
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Refresh restaurant details.');
    fail(error, 'Could not load restaurant details');
    return mapRestaurantSettingsView(data);
  };
  const saveRestaurantSettings = async (input: SaveRestaurantSettingsInput): Promise<RestaurantSettings> => {
    const valid = validateRestaurantSettings(input);
    const db = requireClient(), started = generation;
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an owner account to change restaurant details.');
    const initial = await db.auth.getSession(); fail(initial.error, 'Could not restore session');
    const expected = initial.data.session ? sessionIdentity(initial.data.session.access_token) : null;
    if (!expected || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SESSION_CHANGED', 'Sign in again before changing restaurant details.');
    await requireAdminBusiness();
    const current = await db.auth.getSession(); fail(current.error, 'Could not restore session');
    const token = current.data.session?.access_token;
    const identity = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started || !identity || identity.userId !== expected.userId || identity.sessionId !== expected.sessionId || current.data.session?.user.id !== identity.userId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Refresh restaurant details before saving.');
    const { data, error } = await db.rpc('save_restaurant_settings', {
      p_business_slug: slug, p_contact_phone: valid.contactPhone, p_whatsapp_phone: valid.whatsappPhone,
      p_delivery_fee_paise: valid.deliveryFeePaise, p_min_order_paise: valid.minOrderPaise, p_expected_version: valid.expectedVersion,
    }).setHeader('Authorization', `Bearer ${token}`);
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Refresh restaurant details to check the saved values.');
    if (error?.code === '40001') throw new ServiceError('SETTINGS_CHANGED', 'Another owner changed restaurant details. Refresh and review them before saving again.', error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your owner access changed. Sign in again before saving restaurant details.', error);
    if (error?.code === '22023') {
      const field = error.details as SettingsField;
      if (['contactPhone', 'whatsappPhone', 'deliveryFeePaise', 'minOrderPaise', 'expectedVersion'].includes(field)) throw new RestaurantSettingsValidationError({ [field]: error.message });
      throw new ServiceError('INVALID_SETTINGS', 'Check the restaurant details and try again.', error);
    }
    fail(error, 'Could not save restaurant details');
    const saved = mapRestaurantSettings(data);
    if (saved.contactPhone !== valid.contactPhone || saved.whatsappPhone !== valid.whatsappPhone || saved.deliveryFeePaise !== valid.deliveryFeePaise || saved.minOrderPaise !== valid.minOrderPaise || saved.version !== valid.expectedVersion + 1) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm the saved restaurant details. Refresh before trying again.');
    return saved;
  };
  /**
   * Save the opening hours (#253) through public.save_opening_hours, with the same optimistic version as saveRestaurantSettings
   * (a change by another owner, or to the other settings, is SETTINGS_CHANGED). Invalid windows throw OpeningHoursValidationError
   * (fields opensAt, closesAt, openingHours) before any request. Both times null clears the hours (open all day).
   */
  const saveOpeningHours = async (input: SaveOpeningHoursInput): Promise<SavedOpeningHours> => {
    const checked = validateOpeningHours(input.opensAt, input.closesAt);
    if (Object.keys(checked.errors).length) throw new OpeningHoursValidationError(checked.errors);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || input.expectedVersion > 2147483647) throw new ServiceError('INVALID_SETTINGS', 'Refresh the restaurant details before saving.');
    const hours = checked.hours;
    const db = requireClient(), started = generation;
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an owner account to change restaurant details.');
    const initial = await db.auth.getSession(); fail(initial.error, 'Could not restore session');
    const expected = initial.data.session ? sessionIdentity(initial.data.session.access_token) : null;
    if (!expected || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SESSION_CHANGED', 'Sign in again before changing restaurant details.');
    await requireAdminBusiness();
    const current = await db.auth.getSession(); fail(current.error, 'Could not restore session');
    const token = current.data.session?.access_token;
    const identity = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started || !identity || identity.userId !== expected.userId || identity.sessionId !== expected.sessionId || current.data.session?.user.id !== identity.userId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Refresh restaurant details before saving.');
    const { data, error } = await db.rpc('save_opening_hours', {
      p_business_slug: slug, p_opens_at: hours?.opensAt ?? null, p_closes_at: hours?.closesAt ?? null, p_expected_version: input.expectedVersion,
    }).setHeader('Authorization', `Bearer ${token}`);
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Refresh restaurant details to check the saved values.');
    inactiveSessionError(error);
    if (error?.code === '40001') throw new ServiceError('SETTINGS_CHANGED', 'Another owner changed restaurant details. Refresh and review them before saving again.', error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your owner access changed. Sign in again before saving restaurant details.', error);
    if (error?.code === '22023') {
      const field = error.details as OpeningHoursField;
      if (field === 'opensAt' || field === 'closesAt' || field === 'openingHours') throw new OpeningHoursValidationError({ [field]: error.message });
      throw new ServiceError('INVALID_SETTINGS', 'Check the opening hours and try again.', error);
    }
    fail(error, 'Could not save opening hours');
    const row = data as Record<string, unknown> | null;
    const saved = row && typeof row === 'object' ? mapOpeningHours(row.opens_at, row.closes_at) : undefined;
    if (!row || saved === undefined || row.settings_version !== input.expectedVersion + 1 || (saved?.opensAt ?? null) !== (hours?.opensAt ?? null) || (saved?.closesAt ?? null) !== (hours?.closesAt ?? null)) throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm the saved opening hours. Refresh before trying again.');
    return { openingHours: saved, version: row.settings_version as number };
  };
  const getCategories = async (): Promise<MenuCategory[]> => {
    if (!client) return [{ id: `sample-category-${slug}`, businessId: slug, name: 'Samples', sortOrder: 0 }];
    const business = await getBusiness();
    const { data, error } = await client.from('menu_categories').select('id, name, sort_order').eq('business_id', business.id).order('sort_order').order('name').order('id');
    fail(error, 'Could not load categories');
    return (data ?? []).map(row => ({ id: row.id, businessId: slug, name: row.name, sortOrder: row.sort_order }));
  };
  const saveCategory = async (input: SaveCategoryInput): Promise<MenuCategory> => {
    if (typeof input.name !== 'string' || !input.name.trim() || [...input.name.trim()].length > 100 ||
        !Number.isInteger(input.sortOrder) || input.sortOrder < -2147483648 || input.sortOrder > 2147483647 ||
        (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim()))) {
      throw new ServiceError('INVALID_CATEGORY', 'Enter a category name from 1 to 100 characters and a whole order from -2,147,483,648 to 2,147,483,647.');
    }
    const db = requireClient(); const business = await requireAdminBusiness();
    const values = { name: input.name.trim(), sort_order: input.sortOrder };
    const query = input.id === undefined ? db.from('menu_categories').insert({ ...values, business_id: business.id })
      : db.from('menu_categories').update(values).eq('id', input.id).eq('business_id', business.id);
    const { data, error } = await query.select('id, name, sort_order').maybeSingle();
    if (error?.code === '23505') throw new ServiceError('CATEGORY_DUPLICATE', 'A category with this name already exists. Choose another name.', error);
    inactiveSessionError(error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your admin access changed. Sign in again before managing categories.', error);
    fail(error, 'Could not save category');
    if (!data) throw new ServiceError('NOT_FOUND', 'Category was not found. Reload the menu and try again.');
    return { id: data.id, businessId: slug, name: data.name, sortOrder: data.sort_order };
  };
  const deleteCategory = async (id: string): Promise<void> => {
    if (typeof id !== 'string' || !id.trim()) throw new ServiceError('INVALID_CATEGORY', 'Choose a category to delete.');
    const db = requireClient(); const business = await requireAdminBusiness();
    const { data, error } = await db.from('menu_categories').delete().eq('id', id).eq('business_id', business.id).select('id').maybeSingle();
    if (error?.code === '23503') throw new ServiceError('CATEGORY_IN_USE', 'Move all dishes to another category before deleting this category.', error);
    inactiveSessionError(error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your admin access changed. Sign in again before managing categories.', error);
    fail(error, 'Could not delete category');
    if (!data) throw new ServiceError('NOT_FOUND', 'Category was not found. Reload the menu and try again.');
  };
  const saveMenuItem = async (input: SaveMenuItemInput): Promise<MenuItem> => {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100 ||
        typeof input.categoryId !== 'string' || !input.categoryId.trim() ||
        typeof input.description !== 'string' || input.description.length > 1000 ||
        !Number.isSafeInteger(input.pricePaise) || input.pricePaise <= 0 || input.pricePaise > 2147483647 ||
        typeof input.isAvailable !== 'boolean' || typeof input.isDemo !== 'boolean' ||
        typeof input.isFeatured !== 'boolean' || !Number.isInteger(input.sortOrder) || input.sortOrder < -2147483648 || input.sortOrder > 2147483647 ||
        (input.id !== undefined && (typeof input.id !== 'string' || !input.id.trim()))) {
      throw new ServiceError('INVALID_MENU_ITEM', 'Enter a name and category (up to 100 characters), a description (up to 1000 characters), a positive whole price in paise, availability, sample and featured status, and a whole item order from -2,147,483,648 to 2,147,483,647.');
    }
    if ((!input.id && !isDiet(input.diet)) || (input.diet !== null && !isDiet(input.diet))) {
      throw new ServiceError('INVALID_MENU_ITEM', 'Choose Vegetarian, Contains egg or Non-vegetarian for a new dish.');
    }
    const db = requireClient(); const business = await requireAdminBusiness();
    const values = { diet: input.diet, name: input.name.trim(), description: input.description.trim(), category_id: input.categoryId, price_paise: input.pricePaise, available: input.isAvailable, is_demo: input.isDemo, is_featured: input.isFeatured, sort_order: input.sortOrder };
    const query = input.id === undefined
      ? db.from('menu_items').insert({ ...values, business_id: business.id })
      : db.from('menu_items').update(values).eq('id', input.id).eq('business_id', business.id);
    const { data, error } = await query.select(menuSelect).single();
    inactiveSessionError(error);
    if (error?.code === '23503') throw new ServiceError('CATEGORY_MISSING', 'This category is no longer available. Reload the menu and choose a category.', error);
    fail(error, 'Could not save menu item');
    if (!data) throw new ServiceError('NOT_FOUND', 'Menu item was not found in this business.');
    return mapMenu(data as MenuRow, slug, photoBase);
  };
  const deleteMenuItem = async (id: string): Promise<void> => {
    if (typeof id !== 'string' || !id.trim()) throw new ServiceError('INVALID_MENU_ITEM', 'Choose a menu item to delete.');
    const db = requireClient(); const business = await requireAdminBusiness();
    const { data, error } = await db.from('menu_items').delete().eq('id', id).eq('business_id', business.id).select('id').maybeSingle();
    inactiveSessionError(error);
    fail(error, 'Could not delete menu item');
    if (!data) throw new ServiceError('NOT_FOUND', 'Menu item was not found in this business.');
  };
  // Only availability changes, so the list switch never overwrites a concurrent dish edit.
  const setMenuItemAvailability = async (id: string, isAvailable: boolean): Promise<MenuItem> => {
    if (typeof id !== 'string' || !id.trim() || typeof isAvailable !== 'boolean') throw new ServiceError('INVALID_MENU_ITEM', 'Choose a dish and whether it is available.');
    const db = requireClient(); const business = await requireAdminBusiness();
    const { data, error } = await db.from('menu_items').update({ available: isAvailable }).eq('id', id).eq('business_id', business.id).select(menuSelect).maybeSingle();
    inactiveSessionError(error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your admin access changed. Sign in again before changing the menu.', error);
    fail(error, 'Could not change availability');
    if (!data) throw new ServiceError('NOT_FOUND', 'Menu item was not found in this business. Reload the menu.');
    return mapMenu(data as MenuRow, slug, photoBase);
  };
  const reorder = async (fn: 'reorder_menu_items' | 'reorder_menu_categories', args: Record<string, unknown>, ids: readonly string[]): Promise<void> => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) throw new ServiceError('INVALID_ORDER', 'List each entry exactly once.');
    const db = requireClient(); await requireAdminBusiness();
    const { error } = await db.rpc(fn, { p_business_slug: slug, ...args });
    if (error?.code === '40001') throw new ServiceError('MENU_CHANGED', 'The menu changed on another device. It has been reloaded; arrange it again.', error);
    inactiveSessionError(error);
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your admin access changed. Sign in again before changing the menu.', error);
    fail(error, 'Could not save the new order');
  };
  const reorderMenuItems = (categoryId: string, itemIds: readonly string[]) => {
    if (typeof categoryId !== 'string' || !categoryId.trim()) throw new ServiceError('INVALID_ORDER', 'Choose a category to arrange.');
    return reorder('reorder_menu_items', { p_category_id: categoryId, p_item_ids: itemIds }, itemIds);
  };
  // dateISO is an India-time calendar day (YYYY-MM-DD); omitted means today.
  const getDailySummary = async (dateISO?: string): Promise<DailySummary> => {
    if (dateISO !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || new Date(`${dateISO}T00:00:00Z`).toISOString().slice(0, 10) !== dateISO)) throw new ServiceError('INVALID_DATE', 'Choose a valid day.');
    const db = requireClient(); await requireAdminBusiness();
    const { data, error } = await db.rpc('daily_summary', { p_business_slug: slug, ...(dateISO ? { p_date: dateISO } : {}) });
    if (error?.code === '42501') throw new ServiceError('ADMIN_REQUIRED', 'Your admin access changed. Sign in again to see the summary.', error);
    fail(error, 'Could not load the day summary');
    const row = data as { date: string; collected_paise: number; delivered_count: number; outstanding_paise: number; outstanding_count: number; placed_count: number; cancelled_count: number; top_dishes: { name: string; quantity: number }[] } | null;
    if (!row || typeof row.date !== 'string') throw new ServiceError('SUMMARY_UNAVAILABLE', 'The day summary was not returned. Try again.');
    return { dateISO: row.date, collectedPaise: Number(row.collected_paise), deliveredCount: Number(row.delivered_count), outstandingPaise: Number(row.outstanding_paise), outstandingCount: Number(row.outstanding_count), placedCount: Number(row.placed_count), cancelledCount: Number(row.cancelled_count), topDishes: Array.isArray(row.top_dishes) ? row.top_dishes.map(dish => ({ name: String(dish.name), quantity: Number(dish.quantity) })) : [] };
  };
  const reorderCategories = (categoryIds: readonly string[]) => reorder('reorder_menu_categories', { p_category_ids: categoryIds }, categoryIds);
  const photoRequest = async (action: 'upload' | 'remove' | 'cleanup', item?: MenuItem, bytes?: ArrayBuffer): Promise<{ cleanupComplete: boolean }> => {
    const db = requireClient();
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an admin account to manage dish photos.');
    if (item && (item.businessId !== slug || !item.id || (item.imageUrl && !item.imageUrl.startsWith(photoBase)))) throw new ServiceError('INVALID_PHOTO', 'Reload this restaurant’s menu before changing its photo.');
    if (action === 'upload' && (!bytes || bytes.byteLength < 1 || bytes.byteLength > 5 * 1024 * 1024)) throw new ServiceError('INVALID_PHOTO', 'Choose a photo up to 5 MB.');
    const { data, error } = await db.auth.getSession(); fail(error, 'Could not restore your session');
    if (!data.session) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to manage dish photos.');
    const response = await fetch(`${url?.replace(/\/+$/, '')}/functions/v1/menu-photos`, {
      method: 'POST', headers: { authorization: `Bearer ${data.session.access_token}`, apikey: key!, 'content-type': 'application/octet-stream', 'x-business-slug': slug, 'x-photo-action': action,
        ...(item ? { 'x-menu-item': item.id, 'x-photo-expected': item.imageUrl?.slice(photoBase.length) ?? '' } : {}) },
      body: bytes, signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok) throw new ServiceError('PHOTO_FAILED', typeof result.message === 'string' ? result.message : 'The photo could not be saved. Reload this dish before retrying.');
    return { cleanupComplete: result.cleanupComplete === true };
  };
  const uploadMenuPhoto = (item: MenuItem, bytes: ArrayBuffer) => photoRequest('upload', item, bytes);
  const removeMenuPhoto = (item: MenuItem) => photoRequest('remove', item);
  const retryMenuPhotoCleanup = () => photoRequest('cleanup');
  const loadOrder = async (id: string): Promise<Order> => {
    const db = requireClient(); const business = await getBusiness();
    const { data, error } = await db.from('orders').select(orderSelect).eq('business_id', business.id).eq('id', id).single();
    fail(error, 'Order was saved, but its details could not be loaded');
    if (!data) throw new ServiceError('INVALID_RESPONSE', 'Order was saved, but its details could not be loaded.');
    return mapOrder(data as OrderRow, slug);
  };
  /** Active automatic offers for the menu and cart. Works signed out; never returns a code or a limit. */
  const listActiveOffers = async (): Promise<ActiveOffer[]> => {
    if (!client) return [];
    const { data, error } = await client.rpc('list_active_offers', { p_business_slug: slug });
    fail(error, 'Could not load offers');
    if (!Array.isArray(data)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid offers.');
    return data.map(activeOffer);
  };
  const assertOfferBusiness = async (businessId: string) => {
    const business = await getBusiness();
    if (typeof businessId !== 'string' || business.id !== businessId) throw new ServiceError('BUSINESS_MISMATCH', 'This offer belongs to a different restaurant.');
  };
  /** Rate-limited code check. Resolves with the offer's terms when the code applies to the signed-in customer; otherwise throws an OfferError. */
  const checkOfferCode = async (businessId: string, code: string): Promise<CheckedOfferCode> => {
    const db = requireClient();
    await assertOfferBusiness(businessId);
    const entered = typeof code === 'string' ? code.trim().toUpperCase() : '';
    if (!entered || entered.length > 64) throw offerError('not_found');
    const { data, error } = await db.rpc('check_offer_code', { p_business_slug: slug, p_code: entered });
    if (error?.code === '42501') throw new ServiceError('AUTH_REQUIRED', 'Sign in to use a code.', error);
    fail(error, 'Could not check the code');
    if (!data || typeof data.applies !== 'boolean') throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid code check.');
    if (!data.applies) throw offerError(data.reason, { retryAfterSeconds: data.retry_after_seconds });
    const offer = activeOffer({ ...data.offer, ends_at: null });
    return { id: offer.id, name: offer.name, kind: offer.kind, value: offer.value, maxDiscountPaise: offer.maxDiscountPaise, minOrderPaise: offer.minOrderPaise, firstOrderOnly: offer.firstOrderOnly };
  };
  /**
   * The server's quote for the cart, with the offer it would apply (a valid code, else the best automatic offer). Pass `pricing`
   * as `PlaceOrderInput.pricing`. A code that does not apply is reported in `offerError`; the cart is then priced without it.
   */
  const quoteOrder = async (lines: readonly CartLine[], code?: string | null): Promise<OrderQuote> => {
    const db = requireClient();
    if (lines.some(line => line.item.businessId !== slug)) throw new ServiceError('BUSINESS_MISMATCH', 'All items must belong to this business.');
    const entered = typeof code === 'string' && code.trim() ? code.trim().toUpperCase() : null;
    // A quote that hangs must not hold the cart forever (#193): abort after the timeout and fail, so the caller can fall back or offer a retry.
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new ServiceError('QUOTE_TIMEOUT', 'Checking your offer took too long.')); }, options.quoteTimeoutMs ?? 8000); });
    let reply;
    try { reply = await Promise.race([db.rpc('quote_order', { p_business_slug: slug, p_items: lines.map(line => ({ menu_item_id: line.item.id, quantity: line.quantity })), p_offer_code: entered }).abortSignal(abort.signal), timedOut]); }
    finally { clearTimeout(timer); }
    const { data, error } = reply;
    if (error?.code === '42501') throw new ServiceError('AUTH_REQUIRED', 'Sign in to get your prices.', error);
    outsideHoursError(error);
    demoRestaurantError(error);
    fail(error, 'Could not price the order');
    if (!data || data.outcome !== 'quoted') throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid quote.');
    const nudge = data.nudge as Record<string, unknown> | null;
    return {
      pricing: validateRevisedPricing(data.pricing, lines),
      offerError: data.offer_error ? offerError(data.offer_error.reason, { shortfallPaise: data.offer_error.shortfall_paise, retryAfterSeconds: data.offer_error.retry_after_seconds }) : null,
      nudge: nudge && typeof nudge.offer_id === 'string' && typeof nudge.name === 'string' && Number.isSafeInteger(nudge.shortfall_paise) && (nudge.kind === 'percent' || nudge.kind === 'flat' || nudge.kind === 'free_delivery')
        ? { offerId: nudge.offer_id, name: nudge.name, kind: nudge.kind, value: typeof nudge.value === 'number' ? nudge.value : null, shortfallPaise: nudge.shortfall_paise as number } : null,
    };
  };
  // ---- Owner offers (#182 slice B). Offers are never deleted: there is no delete method, and DELETE is revoked in the database.
  // Every write below changes exactly ONE offer per statement (a bulk UPDATE could be chosen as a deadlock victim), and retries once on 40P01 or 40001.
  type OfferDb = SupabaseClient;
  /** The aggregate counts non-cancelled orders while retaining the lock for any redemption. */
  const readOfferStats = async (db: OfferDb, businessId: string, offerId?: string) => {
    const stats = new Map<string, { uses: number; given: number; redeemed: number }>();
    const { data, error } = await db.rpc('offer_usage_stats', { p_business_id: businessId, p_offer_id: offerId ?? null });
    fail(error, 'Could not load offer usage');
    if (!Array.isArray(data)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid offer usage.');
    for (const row of data) {
      if (!row || typeof row.offer_id !== 'string' || !Number.isSafeInteger(row.uses) || row.uses < 0 || !Number.isSafeInteger(row.discount_given_paise) || row.discount_given_paise < 0 || row.any_redemption !== true || stats.has(row.offer_id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid offer usage.');
      stats.set(row.offer_id, { uses: row.uses, given: row.discount_given_paise, redeemed: 1 });
    }
    return stats;
  };
  const listOffers = async (): Promise<OwnerOffer[]> => {
    const db = requireClient(), started = generation;
    const business = await requireAdminBusiness();
    const { data, error } = await db.from('offers').select(offerSelect).eq('business_id', business.id).order('created_at', { ascending: false }).order('id');
    fail(error, 'Could not load offers');
    if (!Array.isArray(data)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid offers.');
    // Usage is a nice-to-have: if it cannot be read the offers still list, without counts, and owners can still pause, resume and end them.
    const stats = await readOfferStats(db, business.id).catch(() => 'unknown' as const);
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your offers.');
    const now = new Date();
    return data.map(row => mapOwnerOffer(row, stats === 'unknown' ? stats : stats.get((row as { id: string }).id), now));
  };
  /** Offers applied on one India-time day, from non-cancelled orders' own snapshots (no migration, no live offers table), plus, for today, the active offers not used yet. */
  const getDayOffers = async (dateISO: string): Promise<DayOffers> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO) || new Date(`${dateISO}T00:00:00Z`).toISOString().slice(0, 10) !== dateISO) throw new ServiceError('INVALID_DATE', 'Choose a valid day.');
    const db = requireClient(), started = generation;
    const business = await requireAdminBusiness();
    const start = new Date(Date.parse(`${dateISO}T00:00:00Z`) - 330 * 60000), end = new Date(start.getTime() + 86400000);
    const groups = new Map<string, DayOffer>();
    let orderCount = 0, totalGivenPaise = 0, after: string | null = null, done = false;
    for (let page = 0; page < 50 && !done; page++) {
      let query = db.from('orders').select('id, offer_id, offer_name, offer_code, offer_kind, discount_paise').eq('business_id', business.id).not('offer_id', 'is', null).neq('status', 'cancelled').gte('created_at', start.toISOString()).lt('created_at', end.toISOString());
      if (after) query = query.gt('id', after);
      const { data, error } = await query.order('id').limit(1000);
      fail(error, 'Could not load the day\'s offers');
      if (!Array.isArray(data)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid orders.');
      if (data.length === 0) done = true;
      for (const order of data as { id: string; offer_id: string; offer_name: string; offer_code: string | null; offer_kind: string; discount_paise: number }[]) {
        if (typeof order.id !== 'string' || typeof order.offer_id !== 'string' || typeof order.offer_name !== 'string' || !offerKinds.has(order.offer_kind) || !Number.isSafeInteger(order.discount_paise)) throw new ServiceError('INVALID_RESPONSE', 'The server returned invalid orders.');
        const group = groups.get(order.offer_id) ?? { offerId: order.offer_id, name: order.offer_name, code: order.offer_code ?? null, kind: order.offer_kind as OfferKind, uses: 0, givenPaise: 0 };
        group.uses++; group.givenPaise += order.discount_paise; groups.set(order.offer_id, group); orderCount++; totalGivenPaise += order.discount_paise; after = order.id;
      }
    }
    if (!done) throw new ServiceError('OFFERS_TOO_LARGE', 'There are too many orders to total here.');
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload the day.');
    const used = [...groups.values()].sort((a, b) => b.givenPaise - a.givenPaise || b.uses - a.uses || a.name.localeCompare(b.name));
    let running: DayOffers['running'] = null;
    if (dateISO === new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)) {
      const read = await db.from('offers').select(offerSelect).eq('business_id', business.id).eq('paused', false);
      if (!read.error && Array.isArray(read.data)) {
        const now = new Date();
        try {
          const candidates = read.data.map(row => mapOwnerOffer(row, 'unknown', now)).filter(offer => offer.status === 'active' && !groups.has(offer.id));
          running = [];
          for (const offer of candidates) {
            // Usage was not read with the offers, so an offer with a total limit may be used up: check it, and say so honestly if that cannot be checked.
            let state: 'running' | 'outside_window' | 'unconfirmed' = offerWindowOpen(offer.window, now) ? 'running' : 'outside_window';
            if (offer.totalLimit !== null) {
              const uses = await readOfferStats(db, business.id, offer.id).then(found => found.get(offer.id)?.uses ?? 0, () => null);
              if (uses !== null && uses >= offer.totalLimit) continue;
              if (uses === null && state === 'running') state = 'unconfirmed';
            }
            running.push({ id: offer.id, name: offer.name, code: offer.code, kind: offer.kind, state, window: offer.window });
          }
        } catch { running = null; }
      }
    } else running = [];
    return { dateISO, used, orderCount, totalGivenPaise, running };
  };
  const reloadOffer = async (db: OfferDb, businessId: string, row: unknown): Promise<OwnerOffer> => {
    // The write has already committed: reading usage afterwards is best effort and can never turn it into an error.
    const id = (row as { id?: unknown } | null)?.id;
    const stats = typeof id === 'string' ? await readOfferStats(db, businessId, id).then(found => found.get(id), () => 'unknown' as const) : undefined;
    return mapOwnerOffer(row, stats, new Date());
  };
  const createOffer = async (input: OfferInput): Promise<OwnerOffer> => {
    const valid = validateOffer(input);
    const db = requireClient(), started = generation;
    const business = await requireAdminBusiness();
    const write = () => db.from('offers').insert({ business_id: business.id, ...offerColumns(valid), paused: false }).select(offerSelect).single();
    let result = await write();
    if (offerRetryable(result.error)) result = await write();
    if (result.error) { if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your offers to check what was saved.'); offerWriteError(result.error); }
    // A new offer has no redemptions, so there is nothing to read back.
    return mapOwnerOffer(result.data, undefined, new Date());
  };
  /** One offer, one statement, guarded by the version the owner loaded. No row back means the version moved (stale) or the offer is gone. */
  const patchOffer = async (id: string, expectedVersion: number, columns: Record<string, unknown>): Promise<OwnerOffer> => {
    if (typeof id !== 'string' || !orderIdPattern.test(id)) throw new OfferValidationError({ expectedVersion: offerFieldMessages.expectedVersion });
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= 2147483647) throw new OfferValidationError({ expectedVersion: offerFieldMessages.expectedVersion });
    const db = requireClient(), started = generation;
    const business = await requireAdminBusiness();
    const write = () => db.from('offers').update(columns).eq('id', id).eq('business_id', business.id).eq('version', expectedVersion).select(offerSelect);
    let result = await write();
    if (offerRetryable(result.error)) result = await write();
    if (result.error) { if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Reload your offers to check what was saved.'); offerWriteError(result.error); }
    if (!Array.isArray(result.data)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid offer.');
    if (result.data.length === 0) {
      const { data, error } = await db.from('offers').select('id').eq('id', id).eq('business_id', business.id).maybeSingle();
      fail(error, 'Could not check the offer');
      throw new OwnerOfferError(data ? 'OFFER_STALE' : 'OFFER_MISSING');
    }
    if (result.data.length !== 1) throw new ServiceError('INVALID_RESPONSE', 'The server changed more than one offer.');
    return reloadOffer(db, business.id, result.data[0]);
  };
  /** Change every term (an offer nobody has used) or only the name and end date (always allowed). */
  const updateOffer = async (id: string, expectedVersion: number, patch: OfferInput | OfferLockedPatch): Promise<OwnerOffer> => {
    const valid = validateOfferPatch(patch);
    const full = 'kind' in valid;
    return patchOffer(id, expectedVersion, full ? offerColumns(valid as OfferInput) : { ...('name' in valid ? { name: valid.name } : {}), ...('endsAt' in valid ? { ends_at: valid.endsAt } : {}) });
  };
  const pauseOffer = (id: string, expectedVersion: number) => patchOffer(id, expectedVersion, { paused: true });
  const resumeOffer = (id: string, expectedVersion: number) => patchOffer(id, expectedVersion, { paused: false });
  /** Ends it now by the database's own clock ('now'), so a phone with a wrong clock cannot leave it running. An offer that has not started yet is cleared of its start too, since an end cannot come before a start. */
  const endOffer = async (id: string, expectedVersion: number): Promise<OwnerOffer> => {
    try { return await patchOffer(id, expectedVersion, { ends_at: 'now' }); }
    catch (error) {
      if (error instanceof OfferValidationError && error.fields.endsAt) return patchOffer(id, expectedVersion, { ends_at: 'now', starts_at: null });
      throw error;
    }
  };
  const placeOrder = async (input: PlaceOrderInput): Promise<Order> => {
    const db = requireClient();
    if (input.lines.some(line => line.item.businessId !== slug)) throw new ServiceError('BUSINESS_MISMATCH', 'All items must belong to this business.');
    const saved = input.savedAddress;
    if (!saved || typeof saved.id !== 'string' || !orderIdPattern.test(saved.id) || !Number.isSafeInteger(saved.version) || saved.version < 1) throw new ServiceError('INVALID_ADDRESS', 'Choose a saved address.');
    const fix = input.location && { latitude: input.location.latitude, longitude: input.location.longitude, accuracy: input.location.accuracy, captured_at: input.location.capturedAtISO };
    const p_delivery = { name: input.delivery.name, phone: input.delivery.phone, address_id: saved.id, address_version: saved.version };
    // Retries must send this exact payload: the server's request hash covers delivery and location.
    // The code is sent only when there is one, so a cart without a code calls exactly the contract older clients use.
    const code = typeof input.offerCode === 'string' && input.offerCode.trim() ? { p_offer_code: input.offerCode.trim().toUpperCase() } : {};
    const { data, error } = await db.rpc('place_order', { p_business_slug: slug, p_items: input.lines.map(line => ({ menu_item_id: line.item.id, quantity: line.quantity })), p_delivery, p_location: fix, p_idempotency_key: input.idempotencyKey, p_accepted_pricing: input.pricing, ...code });
    inactiveSessionError(error);
    lifecycleError(error);
    if (error?.code === ADDRESS_CHANGED_SQLSTATE) throw addressChanged(error);
    if (error?.code === 'PT429' && error.details === 'ORDER_RATE_LIMITED') throw new ServiceError('ORDER_RATE_LIMITED', 'You have placed several orders recently. Please wait before placing another order.', error);
    // Outside the area, or the restaurant's area isn't set up: either way nothing was written.
    if (error?.code === '22023' && /delivery unavailable/i.test(error.message)) throw new ServiceError('DELIVERY_UNAVAILABLE', 'We can\'t deliver to this address. Choose another address.', error);
    outsideHoursError(error);
    if (error?.code === NOT_ACCEPTING_ORDERS_SQLSTATE) throw new ServiceError('NOT_ACCEPTING_ORDERS', 'The restaurant is not taking orders right now.', error);
    demoRestaurantError(error);
    fail(error, 'Could not place order');
    if (!data) throw new ServiceError('INVALID_RESPONSE', 'The server did not return an order.');
    if (data.outcome === 'pricing_changed' && !('id' in data)) throw new PricingChangedError(validateRevisedPricing(data.pricing, input.lines));
    // A quoted offer that no longer applies is never dropped silently: nothing was ordered; review the revised quote and retry with a fresh key.
    if (data.outcome === 'offer_changed' && !('id' in data)) {
      // Rate limited is its own code (with the wait); every other reason is OFFER_CHANGED. Either way the key is spent and nothing was ordered.
      throw offerError(data.reason, { changed: data.reason !== 'rate_limited', retryAfterSeconds: data.retry_after_seconds, pricing: validateRevisedPricing(data.pricing, input.lines) });
    }
    if (data.outcome !== 'placed' || typeof data.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid order.');
    const order = await loadOrder(data.id);
    const accepted = input.pricing;
    if ((data.discount_paise ?? 0) !== (accepted.discount_paise ?? 0) || (order.discountPaise ?? 0) !== (accepted.discount_paise ?? 0) || (order.offer?.id ?? null) !== (accepted.offer?.id ?? null) ||
        order.subtotalPaise !== accepted.subtotal_paise || order.deliveryFeePaise !== accepted.delivery_fee_paise || order.totalPaise !== accepted.total_paise || order.lines.length !== accepted.lines.length ||
        accepted.lines.some(line => !order.lines.some(saved => saved.menuItemId === line.menu_item_id && saved.quantity === line.quantity && saved.unitPricePaise === line.unit_price_paise && saved.lineTotalPaise === line.line_total_paise))) {
      throw new ServiceError('INVALID_RESPONSE', 'The returned order does not match the accepted pricing. Retry recovery before placing another order.');
    }
    return order;
  };
  // Saved addresses (#48): the caller's own list, shared by both restaurant apps (RLS),
  // with in-area and distance worked out by the server for this restaurant.
  const listAddresses = async (): Promise<SavedAddress[]> => {
    const { data, error } = await requireClient().rpc('list_addresses', { p_business_slug: slug });
    fail(error, 'Could not load your saved addresses');
    if (!Array.isArray(data)) throw new ServiceError('INVALID_RESPONSE', 'The server did not return your saved addresses.');
    return (data as AddressRow[]).map(mapSavedAddress);
  };
  const addressError = (error: { code?: string; message: string } | null, action: string) => {
    if (!error) return;
    if (error.code === '23514' && /saved address limit reached/i.test(error.message)) throw new ServiceError('ADDRESS_LIMIT', 'You can save up to 20 addresses. Delete one to add another.', error);
    if (error.code === '23514' || error.code === '23502') throw new ServiceError('INVALID_ADDRESS', 'Check the address and try again.', error);
    inactiveSessionError(error); lifecycleError(error);
    // Signed-out callers run as anon, which has no address access at all.
    if (error.code === '42501') throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to save addresses.', error);
    fail(error, action);
  };
  const addressColumns = (draft: AddressDraft) => {
    const valid = validateAddressDraft(draft);
    return { label: valid.label, custom_label: valid.customLabel ?? null, house: valid.house, street_area: valid.streetArea, landmark: valid.landmark ?? null, latitude: valid.latitude, longitude: valid.longitude, location_source: valid.locationSource };
  };
  /** Adds an address, or edits one only if it is still at the version the customer was editing. */
  const saveAddress = async (draft: AddressDraft, current?: { id: string; version: number }): Promise<{ id: string; version: number }> => {
    const db = requireClient(); const columns = addressColumns(draft);
    if (!current) {
      const { data, error } = await db.from('customer_addresses').insert(columns).select('id, version').single();
      addressError(error, 'Could not save the address');
      if (!data || typeof data.id !== 'string' || !Number.isSafeInteger(data.version)) throw new ServiceError('INVALID_RESPONSE', 'The server did not return the saved address.');
      return { id: data.id, version: data.version };
    }
    if (typeof current.id !== 'string' || !orderIdPattern.test(current.id) || !Number.isSafeInteger(current.version) || current.version < 1) throw new ServiceError('INVALID_ADDRESS', 'Choose a saved address.');
    const { data, error } = await db.from('customer_addresses').update(columns).eq('id', current.id).eq('version', current.version).select('id, version').maybeSingle();
    addressError(error, 'Could not save the address');
    // No row: deleted, someone else's, or edited elsewhere since it was opened.
    if (!data) throw addressChanged();
    if (typeof data.id !== 'string' || !Number.isSafeInteger(data.version)) throw new ServiceError('INVALID_RESPONSE', 'The server did not return the saved address.');
    return { id: data.id, version: data.version };
  };
  /** Past orders keep their own copy, so deleting never changes them. Already gone counts as deleted.
   *  No version check: deleting is confirmed by the customer, whatever was edited elsewhere. */
  const deleteAddress = async (id: string): Promise<void> => {
    if (typeof id !== 'string' || !orderIdPattern.test(id)) throw new ServiceError('INVALID_ADDRESS', 'Choose a saved address.');
    const { error } = await requireClient().from('customer_addresses').delete().eq('id', id);
    addressError(error, 'Could not delete the address');
  };
  const transitionOrder = async (orderId: string, status: OrderStatus, expectedVersion: number): Promise<Order> => {
    await loadOrder(orderId); // Reject orders outside the active business before mutating.
    const { data, error } = await requireClient().rpc('transition_order', { p_order_id: orderId, p_status: status, p_expected_version: expectedVersion });
    inactiveSessionError(error);
    fail(error, 'Could not update order');
    if (!data) throw new ServiceError('INVALID_RESPONSE', 'The server did not return an order.');
    if (typeof data.id !== 'string') throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid order.');
    return loadOrder(data.id);
  };
  const subscribeOrders = async (refresh: () => void, onError?: (error: ServiceError) => void): Promise<() => void> => {
    const db = requireClient(); const started = generation;
    const { data: session, error } = await db.auth.getSession(); fail(error, 'Could not restore session');
    if (!session.session) throw new ServiceError('SIGN_IN_REQUIRED', 'Sign in to receive order updates.');
    const business = await getBusiness();
    if (disposed || generation !== started) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Sign in again to receive order updates.');
    const stop = subscribeToOrderChanges(db, business.id, slug, audience, refresh, onError);
    const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe); };
    subscriptions.add(unsubscribe);
    return unsubscribe;
  };
  /** Owners open or close the restaurant for new orders; the backend checks ownership. */
  const setAcceptingOrders = async (accepting: boolean): Promise<boolean> => {
    if (typeof accepting !== 'boolean') throw new ServiceError('INVALID_VALUE', 'Choose whether the restaurant is taking orders.');
    const db = requireClient(), started = generation;
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an admin account to change restaurant status.');
    const initial = await db.auth.getSession(); fail(initial.error, 'Could not restore session');
    const expected = initial.data.session ? sessionIdentity(initial.data.session.access_token) : null;
    if (!expected || initial.data.session?.user.id !== expected.userId) throw new ServiceError('SESSION_CHANGED', 'Sign in again before changing restaurant status.');
    await requireAdminBusiness();
    const current = await db.auth.getSession(); fail(current.error, 'Could not restore session');
    const token = current.data.session?.access_token;
    const identity = token ? sessionIdentity(token) : null;
    if (disposed || generation !== started || !identity || expected.userId !== identity.userId || expected.sessionId !== identity.sessionId || current.data.session?.user.id !== identity.userId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Review restaurant status before trying again.');
    // Pin this request after verification: a later auth change cannot attribute
    // the initiating owner's action to the next account during fetch dispatch.
    const { data, error } = await db.rpc('set_accepting_orders', { p_business_slug: slug, p_accepting: accepting }).setHeader('Authorization', `Bearer ${token}`);
    inactiveSessionError(error);
    fail(error, 'Could not change whether the restaurant is taking orders');
    if (typeof data?.accepting_orders !== 'boolean') throw new ServiceError('INVALID_RESPONSE', 'The server did not confirm the change.');
    return data.accepting_orders;
  };
  /** Public (guest-safe) updates to open/closed and dish availability; kept across sign-in and sign-out. */
  const subscribeBusinessState = async (refresh: () => void, onError?: (error: ServiceError) => void): Promise<() => void> => {
    const db = requireClient(); const business = await getBusiness();
    if (disposed) throw new ServiceError('DISPOSED', 'This service has been disposed.');
    const stop = subscribeToBusinessState(db, business.id, slug, audience, refresh, onError);
    const unsubscribe = () => { stop(); publicSubscriptions.delete(unsubscribe); };
    publicSubscriptions.add(unsubscribe);
    return unsubscribe;
  };
  // Bind the HTTP request to the initiating session, allowing its credentials to refresh.
  const deviceTokenRpc = async (action: 'register_device_token' | 'unregister_device_token', token: string, expectedAccessToken: string): Promise<void> => {
    const db = requireClient();
    if (!token || !expectedAccessToken) throw new ServiceError('INVALID_TOKEN', 'A signed-in session and device token are required.');
    const { data, error } = await db.auth.getSession(); fail(error, 'Could not restore session');
    const expected = sessionIdentity(expectedAccessToken);
    const currentToken = data.session?.access_token;
    const current = currentToken ? sessionIdentity(currentToken) : null;
    if (disposed || !expected || !current || expected.userId !== current.userId || expected.sessionId !== current.sessionId || data.session?.user.id !== current.userId) throw new ServiceError('SESSION_CHANGED', 'Your session changed. Please try again.');
    const response = await fetch(`${url!.replace(/\/+$/, '')}/rest/v1/rpc/${action}`, {
      method: 'POST', headers: { apikey: key!, Authorization: `Bearer ${currentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_business_slug: slug, p_audience: audience, p_token: token }),
    });
    if (!response.ok) throw new ServiceError('TOKEN_UPDATE_FAILED', 'Could not update notification settings. Please try again.');
  };
  const registerDeviceToken = (token: string, sessionAccessToken: string) => deviceTokenRpc('register_device_token', token, sessionAccessToken);
  const unregisterDeviceToken = (token: string, sessionAccessToken: string) => deviceTokenRpc('unregister_device_token', token, sessionAccessToken);
  const dispose = () => { if (disposed) return; disposed = true; clearSubscriptions(); for (const unsubscribe of [...publicSubscriptions]) unsubscribe(); authListener?.unsubscribe(); };
  return { mode: client ? 'backend' as const : 'demo' as const, audience, persistenceAvailable: persistence.isAvailable, dispose, auth, joinBusiness, leaveBusiness, getMyRestaurants, getBusiness, getMenu, getOrders, getOrderHistory, getActiveOrders, getCustomerOrder, getProfile, saveProfile, listNotifications, markNotificationRead, markAllNotificationsRead, getUnreadNotificationCount, isAdmin, getOwnerDisplayName, getOwnerProfile, setOwnerDisplayName, getRestaurantSettings, saveRestaurantSettings, saveOpeningHours, getCategories, saveCategory, deleteCategory, saveMenuItem, deleteMenuItem, setMenuItemAvailability, reorderMenuItems, reorderCategories, getDailySummary, uploadMenuPhoto, removeMenuPhoto, retryMenuPhotoCleanup, placeOrder, listActiveOffers, checkOfferCode, quoteOrder, listOffers, getDayOffers, createOffer, updateOffer, pauseOffer, resumeOffer, endOffer, listAddresses, saveAddress, deleteAddress, transitionOrder, subscribeOrders, setAcceptingOrders, subscribeBusinessState, registerDeviceToken, unregisterDeviceToken, requestAccountDeletion };
}

export type MarketServices = ReturnType<typeof createMarketServices>;

/** Subscribe to invalidations; refresh on each successful connection, including reconnects. */
export function subscribeToOrderChanges(db: SupabaseClient, businessId: string, slug: BusinessSlug, audience: AppAudience, refresh: () => void, onError?: (error: ServiceError) => void): () => void {
  let active = true;
  const channel = db.channel(`orders:${slug}:${audience}:${Math.random()}`).on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `business_id=eq.${businessId}` }, () => { if (active) refresh(); }).subscribe(status => {
    if (!active) return;
    if (status === 'SUBSCRIBED') refresh(); // also re-fetch after a reconnect
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onError?.(new ServiceError('REALTIME_ERROR', 'Order updates disconnected. Refresh to retry.'));
  });
  return () => { active = false; void db.removeChannel(channel); };
}

/** Refresh business state on open/closed or dish changes, and after each (re)connection. */
export function subscribeToBusinessState(db: SupabaseClient, businessId: string, slug: BusinessSlug, audience: AppAudience, refresh: () => void, onError?: (error: ServiceError) => void): () => void {
  let active = true;
  const notify = () => { if (active) refresh(); };
  const channel = db.channel(`business-state:${slug}:${audience}:${Math.random()}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'businesses', filter: `id=eq.${businessId}` }, notify)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'menu_items', filter: `business_id=eq.${businessId}` }, notify)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'menu_items', filter: `business_id=eq.${businessId}` }, notify)
    // Realtime cannot filter deletes (the old row carries only its key), so any deleted dish triggers a refresh.
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'menu_items' }, notify)
    // Category adds, renames and reorders change how customers see the menu (#102).
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu_categories', filter: `business_id=eq.${businessId}` }, notify)
    .subscribe(status => {
      if (!active) return;
      if (status === 'SUBSCRIBED') refresh(); // also re-fetch after a reconnect
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onError?.(new ServiceError('REALTIME_ERROR', 'Menu updates disconnected. Refresh to retry.'));
    });
  return () => { active = false; void db.removeChannel(channel); };
}
