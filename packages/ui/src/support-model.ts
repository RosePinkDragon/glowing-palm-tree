import type { BusinessSlug, Order } from '@market/core';

type Question = { id: string; question: string; answer: string };
type LegalSection = { heading: string; text: string };
export type SupportConfig = { questions: Question[]; privacy: LegalSection[]; terms: LegalSection[] };

// Interim copy. Contact numbers are never stored here: they come from the restaurant's business data (see businessContactLinks).
const draft = (restaurant: string): SupportConfig => ({
  questions: [
    { id: 'delivery', question: 'Which delivery address is used?', answer: 'Your delivery addresses are saved and shared across both restaurants. The cart picks the first eligible address, and you can change it at checkout.' },
    { id: 'payment', question: 'How can I pay?', answer: 'Current orders use cash on delivery. Check the total, including the delivery fee, in your cart before placing your order.' },
    { id: 'cancel', question: 'Can I cancel or change my order?', answer: 'Contact the restaurant as soon as possible to ask about a cancellation or change. This app does not currently offer customer cancellation or editing after an order is placed. A change is not confirmed until the restaurant agrees.' },
    { id: 'unavailable', question: 'What if a dish is unavailable?', answer: 'Unavailable dishes cannot be ordered. Remove them from your cart and choose another dish. Reorder skips dishes that are no longer available and shows what was skipped before you place a new order.' },
    { id: 'code', question: 'Why have I not received a login code?', answer: 'Sign in with your mobile number; we send a 6-digit code on WhatsApp that works for 10 minutes.' },
    { id: 'coupon', question: 'How do I use a coupon?', answer: 'Enter coupon codes in the cart.' },
    { id: 'delete', question: 'How do I delete my account?', answer: 'Account deletion is not yet available in the app. When verified restaurant contact details are available here, contact the restaurant to ask about your account and personal information. Signing out does not delete your account.' },
  ],
  privacy: [
    { heading: 'Draft privacy policy', text: `This is placeholder privacy text for ${restaurant}, pending owner and legal review before deployment. It is not a final privacy policy.` },
    { heading: 'Information used by the app', text: 'The app uses account information, order contents, delivery contact details and the delivery location you submit to provide ordering and delivery. Optional notification and usage preferences are available in Account settings.' },
    { heading: 'Questions and requests', text: 'The owner must publish verified contact details, retention periods, service-provider details and the process for privacy and deletion requests before deployment. Account deletion is not currently available in the app.' },
  ],
  terms: [
    { heading: 'Draft terms', text: `These are placeholder terms for ${restaurant}, pending owner and legal review before deployment. They are not final terms of service.` },
    { heading: 'Ordering and payment', text: 'Review dishes, delivery availability, prices and delivery charges before submitting an order. Current orders use cash on delivery. Contact the restaurant about requested changes or cancellations; the app does not confirm them automatically.' },
    { heading: 'Details to be completed', text: 'The owner must provide verified business and contact details and final cancellation, refund, complaint and service terms before deployment.' },
  ],
});
export const supportConfig: Record<BusinessSlug, SupportConfig> = {
  'ammu-sammu': draft('Ammu Sammu'),
  'kokani-dine-inn': draft('Kokani Dine Inn'),
};

/** Accept Indian national, trunk-prefixed or +91/91 formats; never interpolate raw input into a URL. */
export function indianPhone(value: string, mobileOnly = false): string | null {
  const text = value.trim();
  if (!text || !/^\+?[\d\s().-]+$/.test(text)) return null;
  let number = text.replace(/[\s().-]/g, '');
  if (number.startsWith('+91')) number = number.slice(3);
  else if (number.startsWith('+')) return null;
  else if (number.length === 12 && number.startsWith('91')) number = number.slice(2);
  else if (number.length === 11 && number.startsWith('0')) number = number.slice(1);
  return (mobileOnly ? /^[6-9]\d{9}$/ : /^[1-9]\d{9}$/).test(number) ? `91${number}` : null;
}
export function supportLinks(config: { phone: string; whatsapp: string }) {
  const phone = indianPhone(config.phone), whatsapp = indianPhone(config.whatsapp, true);
  return { call: phone ? `tel:+${phone}` : null, whatsapp: whatsapp ? `https://wa.me/${whatsapp}` : null };
}
/** Call and WhatsApp links from the current restaurant's own business data; absent or invalid numbers yield null. */
export function businessContactLinks(business: { contactPhone?: string | null; whatsappPhone?: string | null } | null | undefined) {
  return supportLinks({ phone: business?.contactPhone ?? '', whatsapp: business?.whatsappPhone ?? '' });
}
/**
 * #202 "Prefer Call?" on the customer menu. Built from the restaurant's own configured numbers (same source as Help & support).
 * Hidden (null) for sample/demo businesses and when there is no valid call number, so there is never a dead or placeholder button.
 * Shown whether the restaurant is open or closed: calling is useful either way. WhatsApp is offered only with a valid mobile number
 * and carries no prefilled text or personal data.
 */
export function preferCall(business: { contactPhone?: string | null; whatsappPhone?: string | null } | null | undefined, restaurant: string, demo = false) {
  if (demo) return null;
  const links = businessContactLinks(business);
  if (!links.call) return null;
  return {
    heading: 'Prefer Call?',
    call: { label: 'Call', name: `Call ${restaurant}`, href: links.call },
    whatsapp: links.whatsapp ? { label: 'WhatsApp', name: `WhatsApp ${restaurant}`, href: links.whatsapp } : null,
  };
}
export const isSupportOrder = (order: Order) => ['placed', 'accepted', 'preparing', 'out_for_delivery'].includes(order.status);
export function selectedSupportOrder(orders: readonly Order[], selectedId: string | null): Order | null {
  return orders.find(order => order.id === selectedId && isSupportOrder(order)) ?? orders.find(isSupportOrder) ?? null;
}
