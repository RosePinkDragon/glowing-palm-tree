import type { BusinessSlug } from './index.ts';

export type OrderStatus =
  | 'placed'
  | 'accepted'
  | 'preparing'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

export const orderStatusTransitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  placed: ['accepted', 'cancelled'],
  accepted: ['preparing', 'cancelled'],
  preparing: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return orderStatusTransitions[from].includes(to);
}

export type Diet = 'veg' | 'non_veg' | 'egg';

export const dietLabels: Readonly<Record<Diet, string>> = {
  veg: 'Vegetarian', non_veg: 'Non-vegetarian', egg: 'Contains egg',
};

export function isDiet(value: unknown): value is Diet {
  return value === 'veg' || value === 'non_veg' || value === 'egg';
}

export interface MenuItem {
  id: string;
  businessId: BusinessSlug;
  name: string;
  description: string;
  category: string;
  /** Unclassified dishes have no mark. */
  diet?: Diet | null;
  pricePaise: number;
  isAvailable: boolean;
  isDemo: boolean;
  imageUrl?: string;
}

export interface CartLine {
  item: MenuItem;
  quantity: number;
}

export interface DeliveryDetails {
  name: string;
  phone: string;
  addressLine: string;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAtISO: string;
}

export type LocationPermissionState = 'granted' | 'denied' | 'undetermined';

export interface OrderLine {
  /** Trusted snapshot at order placement; never read from the current menu. */
  diet?: Diet | null;
  menuItemId: string;
  name: string;
  quantity: number;
  unitPricePaise: number;
  lineTotalPaise: number;
}

export interface Order {
  id: string;
  businessId: BusinessSlug;
  version: number;
  status: OrderStatus;
  lines: OrderLine[];
  subtotalPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  delivery: DeliveryDetails;
  createdAtISO: string;
  history?: { status: OrderStatus; createdAtISO: string }[];
}

export type DomainFieldErrors = Record<string, string>;

export class DomainValidationError extends Error {
  readonly code: string;
  readonly fields: DomainFieldErrors;

  constructor(code: string, message: string, fields: DomainFieldErrors = {}) {
    super(message);
    this.name = 'DomainValidationError';
    this.code = code;
    this.fields = fields;
  }
}

const MAX_QUANTITY = 10;
const MAX_CART_LINES = 20;

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new DomainValidationError('INVALID_QUANTITY', 'Quantity must be a whole number from 1 to 10.', {
      quantity: 'Enter a whole number from 1 to 10.',
    });
  }
}

function assertItem(item: MenuItem): void {
  if (!Number.isSafeInteger(item.pricePaise) || item.pricePaise < 0) {
    throw new DomainValidationError('INVALID_PRICE', 'Menu price must be a non-negative safe integer in paise.', {
      pricePaise: 'This menu item has an invalid price.',
    });
  }
}

export function addCartItem(cart: readonly CartLine[], item: MenuItem, quantity = 1): CartLine[] {
  assertItem(item);
  assertQuantity(quantity);
  if (cart.length && cart.some((line) => line.item.businessId !== item.businessId)) {
    throw new DomainValidationError('CART_BUSINESS_MISMATCH', 'A cart can contain items from one business only.', {
      businessId: 'Clear the cart before ordering from another business.',
    });
  }
  const existingIndex = cart.findIndex((line) => line.item.id === item.id);
  if (existingIndex >= 0) {
    const nextQuantity = cart[existingIndex].quantity + quantity;
    assertQuantity(nextQuantity);
    const next = [...cart];
    next[existingIndex] = { item, quantity: nextQuantity };
    return next;
  }
  if (cart.length >= MAX_CART_LINES) {
    throw new DomainValidationError('CART_LINE_LIMIT', 'A cart can contain at most 20 distinct items.', {
      items: 'Remove an item before adding another.',
    });
  }
  return [...cart, { item, quantity }];
}

export function setCartItemQuantity(cart: readonly CartLine[], itemId: string, quantity: number): CartLine[] {
  assertQuantity(quantity);
  const index = cart.findIndex((line) => line.item.id === itemId);
  if (index < 0) return [...cart];
  const next = [...cart];
  next[index] = { ...next[index], quantity };
  return next;
}

export function removeCartItem(cart: readonly CartLine[], itemId: string): CartLine[] {
  return cart.filter((line) => line.item.id !== itemId);
}

export function cartSubtotalPaise(cart: readonly CartLine[]): number {
  let subtotal = 0;
  for (const { item, quantity } of cart) {
    assertItem(item);
    assertQuantity(quantity);
    const lineTotal = item.pricePaise * quantity;
    if (!Number.isSafeInteger(lineTotal) || !Number.isSafeInteger(subtotal + lineTotal)) {
      throw new DomainValidationError('PRICE_OVERFLOW', 'Cart subtotal exceeds the safe integer range.', {
        subtotal: 'Unable to calculate this cart total.',
      });
    }
    subtotal += lineTotal;
  }
  return subtotal;
}

export function formatINRFromPaise(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new DomainValidationError('INVALID_AMOUNT', 'Amount must be a non-negative safe integer in paise.', {
      amount: 'This amount cannot be displayed.',
    });
  }
  const rupees = Math.floor(paise / 100);
  const paiseRemainder = String(paise % 100).padStart(2, '0');
  const formattedRupees = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(rupees);
  return `${formattedRupees}.${paiseRemainder}`;
}

export function validateDeliveryDetails(input: DeliveryDetails): DeliveryDetails {
  const name = input.name.trim();
  const addressLine = input.addressLine.trim();
  const digits = input.phone.replace(/\s/g, '').replace(/^\+91/, '');
  const fields: DomainFieldErrors = {};
  if (name.length < 2 || name.length > 80) fields.name = 'Enter a name from 2 to 80 characters.';
  if (!/^\+?\d+$/.test(input.phone.replace(/\s/g, '')) || !/^[6-9]\d{9}$/.test(digits)) {
    fields.phone = 'Enter a valid 10-digit Indian mobile number.';
  }
  if (addressLine.length < 10 || addressLine.length > 300) fields.addressLine = 'Enter an address from 10 to 300 characters.';
  if (Object.keys(fields).length) {
    throw new DomainValidationError('INVALID_DELIVERY_DETAILS', 'Check the delivery details.', fields);
  }
  return { name, phone: `+91${digits}`, addressLine };
}

export function validateLocationFix(fix: LocationFix, now = Date.now()): LocationFix {
  const fields: DomainFieldErrors = {};
  if (!Number.isFinite(fix.latitude) || fix.latitude < -90 || fix.latitude > 90) fields.latitude = 'Location latitude is invalid.';
  if (!Number.isFinite(fix.longitude) || fix.longitude < -180 || fix.longitude > 180) fields.longitude = 'Location longitude is invalid.';
  if (!Number.isFinite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > 100) fields.accuracy = 'Location accuracy must be 100 metres or better.';
  const capturedAt = Date.parse(fix.capturedAtISO);
  if (!Number.isFinite(capturedAt)) fields.capturedAtISO = 'Location timestamp is invalid.';
  else if (capturedAt > now + 30_000) fields.capturedAtISO = 'Location timestamp is in the future.';
  else if (now - capturedAt > 5 * 60_000) fields.capturedAtISO = 'Location is older than 5 minutes. Refresh it.';
  if (Object.keys(fields).length) {
    throw new DomainValidationError('INVALID_LOCATION_FIX', 'A recent, accurate location is required.', fields);
  }
  return fix;
}
