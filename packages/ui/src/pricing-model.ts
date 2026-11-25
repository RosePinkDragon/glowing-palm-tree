import type { CartLine } from '@market/core';
import type { PricingTerms } from '@market/services';
import type { CheckoutAttempt, Identity } from './checkout-state.ts';
import { sameIdentity } from './checkout-state.ts';

export interface RevisedQuote { original: CheckoutAttempt; pricing: PricingTerms; identity: Identity; sourceCart: string }
/**
 * The pricing the customer accepts, built from the cart on screen. place_order compares it to its own quote key for key, and since #182 that
 * quote carries `discount_paise` and `offer` whenever an offer applies (an automatic one too). So the server's discount and offer snapshot
 * are passed in as `offer` (from quote_order): without them an eligible cart is always refused as pricing_changed. The lines, fee and
 * subtotal still come from the cart, so a price that moved since the cart was shown still reaches the customer as a revised quote.
 */
export function capturePricing(lines: readonly CartLine[], deliveryFeePaise: number, minOrderPaise: number, offer?: Pick<PricingTerms, 'discount_paise' | 'offer'> | null): PricingTerms {
  const prices = lines.map(({ item, quantity }) => ({ menu_item_id: item.id, quantity, unit_price_paise: item.pricePaise, line_total_paise: item.pricePaise * quantity }));
  const subtotal = prices.reduce((sum, line) => sum + line.line_total_paise, 0);
  const discount = offer?.offer && offer.discount_paise ? Math.min(offer.discount_paise, subtotal + deliveryFeePaise) : 0;
  return { lines: prices, delivery_fee_paise: deliveryFeePaise, min_order_paise: minOrderPaise, subtotal_paise: subtotal, total_paise: subtotal + deliveryFeePaise - discount,
    ...(discount && offer?.offer ? { discount_paise: discount, offer: offer.offer } : {}) };
}
export function visibleQuote(quote: RevisedQuote | null, identity: Identity, authReady: boolean): RevisedQuote | null {
  return authReady && quote && sameIdentity(quote.identity, identity) && quote.original.userId === identity.userId ? quote : null;
}
export function revisedLines(quote: RevisedQuote): CartLine[] {
  return quote.original.lines.map((line, i) => ({ ...line, item: { ...line.item, pricePaise: quote.pricing.lines[i].unit_price_paise } }));
}
