import type { PricingTerms } from '@market/services';
import type { BusinessSlug, CartLine, LocationFix } from '@market/core';

/** What the order needs from the customer: contact only. The address comes from the saved address (#48). */
export interface CheckoutDelivery { name: string; phone: string }

/**
 * The complete order request, frozen before sending. Version 2 (#48) orders to a saved address and carries the
 * phone's location only when it was available (`null` otherwise). Any other stored value is discarded as unreadable.
 */
export interface CheckoutAttempt {
  version: 2;
  businessId: BusinessSlug;
  userId: string;
  idempotencyKey: string;
  lines: CartLine[];
  pricing: PricingTerms;
  delivery: CheckoutDelivery;
  savedAddress: { id: string; version: number };
  location: LocationFix | null;
}

/** Capture the complete request before sending it. A retry must use this snapshot. */
export function freezeAttempt(input: Omit<CheckoutAttempt, 'version'>): CheckoutAttempt {
  return JSON.parse(JSON.stringify({ ...input, version: 2 })) as CheckoutAttempt;
}
const unreadable = () => new Error('The saved order attempt could not be read. Contact the restaurant before placing another order.');
const isFix = (value: unknown): value is LocationFix => !!value && typeof value === 'object' && ['latitude', 'longitude', 'accuracy'].every(key => Number.isFinite((value as Record<string, unknown>)[key])) && typeof (value as LocationFix).capturedAtISO === 'string';
/** Throws for anything unreadable, including a malformed or older (version 1) value. */
export function readAttempt(value: string | null, businessId: BusinessSlug): CheckoutAttempt | null {
  if (!value) return null;
  let attempt: CheckoutAttempt;
  try { attempt = JSON.parse(value) as CheckoutAttempt; } catch { throw unreadable(); }
  const common = !!attempt && typeof attempt === 'object' && attempt.businessId === businessId && !!attempt.userId && !!attempt.idempotencyKey && Array.isArray(attempt.lines) && !!attempt.pricing
    && !!attempt.delivery && typeof attempt.delivery.name === 'string' && typeof attempt.delivery.phone === 'string';
  const saved = attempt?.savedAddress;
  const valid = common && attempt.version === 2 && !!saved && typeof saved.id === 'string' && Number.isSafeInteger(saved.version) && saved.version >= 1 && (attempt.location === null || isFix(attempt.location));
  if (!valid) throw unreadable();
  return attempt;
}
/** The request exactly as the service sends it. */
export function orderInput(attempt: CheckoutAttempt) { return attempt; }
export function attemptKey(businessId: BusinessSlug) { return `market:checkout:${businessId}`; }

/** Only an explicit transactional rejection from the order RPC can release a saved attempt. */
export function isDefiniteOrderRejection(error: unknown): boolean {
  // A closed restaurant, a changed address or one outside the area refuse before anything is written, and a retry of an existing order is returned instead.
  if (error instanceof Error && 'code' in error && (error.code === 'NOT_ACCEPTING_ORDERS' || error.code === 'ADDRESS_CHANGED' || error.code === 'DELIVERY_UNAVAILABLE')) return true;
  if (!(error instanceof Error) || !('code' in error) || error.code !== '22023') return false;
  return new Set(['delivery unavailable', 'invalid delivery details', 'invalid items', 'invalid item', 'invalid item quantity or duplicate', 'item unavailable', 'invalid order total']).has(error.message.replace(/^Could not place order: /, '')) && error.message.startsWith('Could not place order: ');
}

export interface Identity { userId: string | null; generation: number }
export function nextIdentity(current: Identity, userId: string | null): Identity {
  return current.userId === userId ? current : { userId, generation: current.generation + 1 };
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return a.userId === b.userId && a.generation === b.generation;
}
