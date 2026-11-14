import type { CartLine } from '@market/core';
import type { PricingTerms } from '@market/services';
import type { CheckoutAttempt, Identity } from './checkout-state.ts';
import { sameIdentity } from './checkout-state.ts';

export interface RevisedQuote { original: CheckoutAttempt; pricing: PricingTerms; identity: Identity; sourceCart: string }
export function capturePricing(lines: readonly CartLine[], deliveryFeePaise: number, minOrderPaise: number): PricingTerms {
  const prices = lines.map(({ item, quantity }) => ({ menu_item_id: item.id, quantity, unit_price_paise: item.pricePaise, line_total_paise: item.pricePaise * quantity }));
  const subtotal = prices.reduce((sum, line) => sum + line.line_total_paise, 0);
  return { lines: prices, delivery_fee_paise: deliveryFeePaise, min_order_paise: minOrderPaise, subtotal_paise: subtotal, total_paise: subtotal + deliveryFeePaise };
}
export function visibleQuote(quote: RevisedQuote | null, identity: Identity, authReady: boolean): RevisedQuote | null {
  return authReady && quote && sameIdentity(quote.identity, identity) && quote.original.userId === identity.userId ? quote : null;
}
export function revisedLines(quote: RevisedQuote): CartLine[] {
  return quote.original.lines.map((line, i) => ({ ...line, item: { ...line.item, pricePaise: quote.pricing.lines[i].unit_price_paise } }));
}
