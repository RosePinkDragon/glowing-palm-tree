import type { BusinessSlug, CartLine, DeliveryDetails, LocationFix } from '@market/core';

export interface CheckoutAttempt {
  version: 1;
  businessId: BusinessSlug;
  userId: string;
  idempotencyKey: string;
  lines: CartLine[];
  delivery: DeliveryDetails;
  location: LocationFix;
}

/** Capture the complete request before sending it. A retry must use this snapshot. */
export function freezeAttempt(input: Omit<CheckoutAttempt, 'version'>): CheckoutAttempt {
  return JSON.parse(JSON.stringify({ version: 1, ...input })) as CheckoutAttempt;
}
export function readAttempt(value: string | null, businessId: BusinessSlug): CheckoutAttempt | null {
  if (!value) return null;
  const attempt = JSON.parse(value) as CheckoutAttempt;
  if (attempt.version !== 1 || attempt.businessId !== businessId || !attempt.userId || !attempt.idempotencyKey || !Array.isArray(attempt.lines) || !attempt.delivery || !attempt.location) throw new Error('The saved order attempt could not be read. Contact the restaurant before placing another order.');
  return attempt;
}
export function attemptKey(businessId: BusinessSlug) { return `market:checkout:${businessId}`; }

/** Only an explicit transactional rejection from the order RPC can release a saved attempt. */
export function isDefiniteOrderRejection(error: unknown): boolean {
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
