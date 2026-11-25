// Pure helpers for offers in the customer cart (#182 slice C): wording, quote bookkeeping. No JSX, so tests can check them.
import { formatINRFromPaise as money, type CartLine } from '@market/core';
import type { ActiveOffer, OfferKind, OfferNudge, OfferReason, PricingTerms } from '@market/services';

type Terms = { kind: OfferKind; value: number | null; maxDiscountPaise?: number | null; minOrderPaise?: number };
/** "20% off up to Rs 100 on orders above Rs 300". Values for percent are whole percents; flat values are paise. */
export function offerDescription(o: Terms): string {
  const what = o.kind === 'percent' ? `${o.value}% off${o.maxDiscountPaise ? ` up to ${money(o.maxDiscountPaise)}` : ''}` : o.kind === 'flat' ? `${money(o.value ?? 0)} off` : 'Free delivery';
  return o.minOrderPaise ? `${what} on orders above ${money(o.minOrderPaise)}` : what;
}
/** The signed-out banner: the first active automatic offer (the server lists them oldest first), plus how many more there are. */
export function bannerText(offers: readonly ActiveOffer[]): string | null {
  if (!offers.length) return null;
  return offerDescription(offers[0]) + (offers.length > 1 ? ` (+${offers.length - 1} more)` : '');
}
/** "Add Rs 50 more to get 20% off". */
export function nudgeText(n: OfferNudge): string {
  const prize = n.kind === 'percent' ? `${n.value}% off` : n.kind === 'flat' ? `${money(n.value ?? 0)} off` : 'free delivery';
  return `Add ${money(n.shortfallPaise)} more to get ${prize}`;
}
export const retryMinutes = (seconds: number | undefined) => Math.max(1, Math.ceil((seconds ?? 60) / 60));

type Rejection = { reason: OfferReason; shortfallPaise?: number; retryAfterSeconds?: number };
/** Friendly text for a code the server refused (entered, re-quoted or at place time). Server wording is never shown. */
export function offerErrorMessage(e: Rejection): string {
  switch (e.reason) {
    case 'not_found': case 'ended': return 'This code isn\'t valid';
    case 'used_up': return 'This offer has run out';
    case 'rate_limited': return `Too many tries. Try again in ${retryMinutes(e.retryAfterSeconds)} min`;
    case 'min_order': return e.shortfallPaise ? `Add ${money(e.shortfallPaise)} more to use this code` : 'Your order is below the minimum for this code';
    case 'first_order_only': return 'This code is only for your first order here';
    case 'per_customer_limit': return 'You\'ve already used this code';
    case 'paused': return 'This code isn\'t active right now';
    case 'not_started': return 'This code hasn\'t started yet';
    case 'outside_window': return 'This code isn\'t available at this time of day';
    case 'no_benefit': return 'This code wouldn\'t save anything on this order';
    default: return 'This code can\'t be used on this order';
  }
}
const changedReason: Record<OfferReason, string> = {
  not_found: 'that code isn\'t valid', ended: 'the offer has ended', used_up: 'the offer has run out', paused: 'the offer isn\'t active right now', not_started: 'the offer hasn\'t started yet',
  outside_window: 'the offer isn\'t available at this time of day', first_order_only: 'the offer is only for your first order here', per_customer_limit: 'you\'ve already used the offer',
  min_order: 'your order is below the offer\'s minimum', no_benefit: 'the offer wouldn\'t save anything now', rate_limited: 'too many tries', changed: 'the offer\'s terms changed',
};
/** Shown when place_order refuses because the quoted offer no longer applies. Nothing was ordered; the customer must tap Place order again. */
export function offerChangedMessage(e: Rejection, totalPaise: number | null): string {
  if (e.reason === 'rate_limited') return `${offerErrorMessage(e)}. Your total is now ${totalPaise === null ? 'updated' : money(totalPaise)}. Tap Place order to continue.`;
  return `Your offer changed: ${changedReason[e.reason] ?? changedReason.changed}. Your total is now ${totalPaise === null ? 'updated' : money(totalPaise)}. Tap Place order to confirm.`;
}

/** Everything that decides whether a quote is still about this cart (prices and fee included, so a menu refresh re-quotes). */
export function quoteSignature(lines: readonly CartLine[], feePaise: number, minPaise: number): string {
  return JSON.stringify([feePaise, minPaise, lines.map(l => [l.item.id, l.quantity, l.item.pricePaise])]);
}
/** The discount part of a server quote, or null when no offer applies. */
export function quotedOffer(pricing: PricingTerms | null | undefined): Pick<PricingTerms, 'discount_paise' | 'offer'> | null {
  return pricing?.offer && pricing.discount_paise ? { discount_paise: pricing.discount_paise, offer: pricing.offer } : null;
}
/** What the bill shows: the discount, the amount to pay and what the customer saved (the discount; free delivery saves the fee). */
export function billTotals(subtotalPaise: number, feePaise: number, offer: Pick<PricingTerms, 'discount_paise'> | null) {
  const discountPaise = Math.min(offer?.discount_paise ?? 0, subtotalPaise + feePaise);
  return { discountPaise, totalPaise: subtotalPaise + feePaise - discountPaise };
}
/** "Discount (NAME) -Rs X" on the owner's order screen: the offer's name, or its code when there is no name. */
export function discountLabel(offer: { name?: string; code?: string | null } | undefined): string {
  const who = offer?.name?.trim() || offer?.code || '';
  return who ? `Discount (${who})` : 'Discount';
}
export const minus = (paise: number) => `−${money(paise)}`;
