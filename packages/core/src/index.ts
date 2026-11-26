export type AppAudience = 'customer' | 'admin';
export type BusinessSlug = 'ammu-sammu' | 'kokani-dine-inn';

export {
  DomainValidationError,
  dietLabels,
  isDiet,
  MAX_QUANTITY,
  addCartItem,
  canTransitionOrderStatus,
  cartSubtotalPaise,
  formatINRFromPaise,
  orderStatusTransitions,
  removeCartItem,
  setCartItemQuantity,
  FULL_NAME_MESSAGE,
  normalizeFullName,
  validateDeliveryDetails,
  validateLocationFix,
} from './domain.ts';
export { addressLabels, addressLine, formatDistance, addressTitle, isAddressLabel, remoteOrderFlag, remoteOrderThresholdM, isAddressLocationSource, validateAddressDraft } from './address.ts';
export type { AddressDraft, AddressLabel, AddressLocationSource, OrderAddress, SavedAddress } from './address.ts';
export type {
  CartLine,
  DailySummary,
  DeliveryDetails,
  Diet,
  DomainFieldErrors,
  LocationFix,
  MenuItem,
  Order,
  OrderLine,
  OrderStatus,
} from './domain.ts';

export const businesses: Record<BusinessSlug, { name: string; locale: string; currency: string }> = {
  'ammu-sammu': { name: 'Ammu Sammu', locale: 'en-IN', currency: 'INR' },
  'kokani-dine-inn': { name: 'Kokani Dine Inn', locale: 'en-IN', currency: 'INR' },
};
export * from './otp.ts';
export * from './hours.ts';
