export type AppAudience = 'customer' | 'admin';
export type BusinessSlug = 'ammu-sammu' | 'kokani-dine-inn';

export {
  DomainValidationError,
  addCartItem,
  canTransitionOrderStatus,
  cartSubtotalPaise,
  formatINRFromPaise,
  orderStatusTransitions,
  removeCartItem,
  setCartItemQuantity,
  validateDeliveryDetails,
  validateLocationFix,
} from './domain.ts';
export type {
  CartLine,
  DeliveryDetails,
  DomainFieldErrors,
  LocationFix,
  LocationPermissionState,
  MenuItem,
  Order,
  OrderLine,
  OrderStatus,
} from './domain.ts';

export const businesses: Record<BusinessSlug, { name: string; locale: string; currency: string }> = {
  'ammu-sammu': { name: 'Ammu Sammu', locale: 'en-IN', currency: 'INR' },
  'kokani-dine-inn': { name: 'Kokani Dine Inn', locale: 'en-IN', currency: 'INR' },
};
