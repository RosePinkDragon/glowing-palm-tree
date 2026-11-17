import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import { businesses, isAddressLabel, isAddressLocationSource, isDiet, validateAddressDraft, type AddressDraft, type OrderAddress, type SavedAddress, type Diet, type AppAudience, type BusinessSlug, type CartLine, type DailySummary, type LocationFix, type MenuItem, type Order, type OrderStatus } from '@market/core';
import { storage } from './storage';

export type { SupportedStorage } from '@supabase/supabase-js';
export interface PublicConfig { url?: string; anonKey?: string }
export interface Business { contactPhone?: string | null; whatsappPhone?: string | null; settingsVersion?: number; id: string; slug: BusinessSlug; name: string; deliveryFeePaise: number; minOrderPaise: number; isDemo: boolean; orderingEnabled: boolean; acceptingOrders: boolean }
export interface RestaurantSettings { contactPhone: string | null; whatsappPhone: string | null; deliveryFeePaise: number; minOrderPaise: number; version: number }
export interface OwnerProfile { displayName: string; readonly phone: string | null }
/** Delivery-area status from the business row (the polygon is never fetched): a verified radius, another verified source, or not verified. */
export type DeliveryAreaStatus = { kind: 'radius'; radiusM: number } | { kind: 'verified' } | { kind: 'unverified' };
/** What the owner's Restaurant details screen reads: the editable settings plus developer-controlled facts shown read-only. */
export interface RestaurantSettingsView extends RestaurantSettings { orderPrefix: string; deliveryArea: DeliveryAreaStatus }
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
export interface PricingTerms {
  lines: { menu_item_id: string; quantity: number; unit_price_paise: number; line_total_paise: number }[];
  delivery_fee_paise: number; min_order_paise: number; subtotal_paise: number; total_paise: number;
}
/**
 * An order goes to a saved address (#48): the server checks that address's pin and snapshots the
 * reviewed version. location (the phone, optional) only measures how far away the customer is.
 */
export interface PlaceOrderInput { pricing: PricingTerms; lines: readonly CartLine[]; delivery: { name: string; phone: string }; location: LocationFix | null; idempotencyKey: string; savedAddress: { id: string; version: number } }
/** Preserve the database timestamp verbatim: JavaScript dates lose microseconds. */
export interface OrderCursor { createdAtISO: string; id: string }
export interface OrderPageOptions { cursor?: OrderCursor | null; limit?: number }
export interface OrderPage { orders: Order[]; nextCursor: OrderCursor | null }
export interface CustomerNotification {
  id: string; businessId: BusinessSlug; orderId: string; eventStatus: OrderStatus;
  title: string; body: string; readAtISO: string | null; createdAtISO: string;
}
export interface NotificationPageOptions { cursor?: OrderCursor | null; limit?: number }
export interface NotificationPage { notifications: CustomerNotification[]; nextCursor: OrderCursor | null }
export interface ServiceOptions { businessSlug: BusinessSlug; audience: AppAudience; config?: PublicConfig; storage?: SupportedStorage }

export interface CustomerBusinessRelationship {
  customerId: string;
  businessId: string;
  generation: string;
  joinedAtISO: string;
  state: 'active';
}

export class ServiceError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) { super(message); this.name = 'ServiceError'; this.code = code; this.cause = cause; }
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
  return { ...settings, orderPrefix: row.order_prefix, deliveryArea };
}

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
  if (q.subtotal_paise !== subtotal || q.total_paise !== subtotal + q.delivery_fee_paise) return invalid();
  // Copy just the validated contract, never trust arbitrary metadata in the response.
  return { lines: q.lines.map(a => ({ menu_item_id: a.menu_item_id, quantity: a.quantity, unit_price_paise: a.unit_price_paise, line_total_paise: a.line_total_paise })), delivery_fee_paise: q.delivery_fee_paise, min_order_paise: q.min_order_paise, subtotal_paise: q.subtotal_paise, total_paise: q.total_paise };
}

function fail(error: { message: string; code?: string } | null, action: string): void {
  if (error) throw new ServiceError(error.code ?? 'BACKEND_ERROR', `${action}: ${error.message}`, error);
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

/** The storage key is isolated by backend, business and audience. */
// Lifecycle conflicts have distinct details; unrelated PT409 errors retain their existing mapping.
function lifecycleError(error: { code?: string; details?: string | null } | null): void {
  if (error?.code === 'PT403' && error.details === 'BUSINESS_JOIN_REQUIRED') throw new ServiceError('BUSINESS_JOIN_REQUIRED', 'Join this restaurant before placing an order.', error);
  if (error?.code === 'PT409' && error.details === 'BUSINESS_LIFECYCLE_PENDING') throw new ServiceError('BUSINESS_LIFECYCLE_PENDING', 'Your restaurant relationship is being updated. Retry when it finishes.', error);
  if (error?.code === 'PT409' && error.details === 'ACCOUNT_LIFECYCLE_PENDING') throw new ServiceError('ACCOUNT_LIFECYCLE_PENDING', 'Your account is being updated. Retry when it finishes.', error);
}

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
type OrderRow = { order_number?: string | null; id: string; status: OrderStatus; version: number; subtotal_paise: number; delivery_fee_paise: number; total_paise: number; customer_name: string; customer_phone: string; delivery_address_line: string; latitude?: number | null; longitude?: number | null; created_at: string; address_label?: string | null; address_custom_label?: string | null; address_house?: string | null; address_street_area?: string | null; address_landmark?: string | null; address_location_source?: string | null; saved_address_id?: string | null; placed_from_distance_m?: number | null; kitchen_distance_m?: number | null; order_items: { diet: Diet | null; menu_item_id: string; name: string; quantity: number; unit_price_paise: number; line_total_paise: number }[]; order_status_history?: HistoryRow[] };
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
export function mapOrder(row: OrderRow, slug: BusinessSlug): Order {
  return { id: row.id, ...(row.order_number ? { orderNumber: row.order_number } : {}), businessId: slug, status: row.status, version: row.version, subtotalPaise: row.subtotal_paise, deliveryFeePaise: row.delivery_fee_paise, totalPaise: row.total_paise, delivery: { name: row.customer_name, phone: row.customer_phone, addressLine: row.delivery_address_line }, createdAtISO: row.created_at, ...(typeof row.latitude === 'number' && typeof row.longitude === 'number' ? { location: { latitude: row.latitude, longitude: row.longitude } } : {}), lines: row.order_items.map(item => ({ menuItemId: item.menu_item_id, diet: item.diet, name: item.name, quantity: item.quantity, unitPricePaise: item.unit_price_paise, lineTotalPaise: item.line_total_paise })), ...orderAddress(row), ...(row.order_status_history ? { history: row.order_status_history.map(item => ({ status: item.status, createdAtISO: item.created_at, ...actorName(item) })).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO)) } : {}) };
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
    if (!client) return { id: slug, slug, name: businesses[slug].name, deliveryFeePaise: 0, minOrderPaise: 0, isDemo: true, orderingEnabled: false, acceptingOrders: false };
    const { data, error } = await client.from('businesses').select('id, slug, name, delivery_fee_paise, min_order_paise, is_demo, ordering_enabled, accepting_orders, contact_phone, whatsapp_phone, settings_version').eq('slug', slug).single();
    fail(error, 'Could not load business');
    if (!data) throw new ServiceError('NOT_FOUND', 'Business not found.');
    return { contactPhone: data.contact_phone ?? null, whatsappPhone: data.whatsapp_phone ?? null, settingsVersion: data.settings_version, id: data.id, slug, name: data.name, deliveryFeePaise: data.delivery_fee_paise, minOrderPaise: data.min_order_paise, isDemo: data.is_demo, orderingEnabled: data.ordering_enabled, acceptingOrders: data.accepting_orders === true };
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
    scope.ensureCurrent(); failNotification(error);
    if (typeof data !== 'boolean') throw invalidNotificationResponse();
    return data;
  };
  const notificationCount = async (rpc: 'mark_all_customer_notifications_read' | 'customer_notification_unread_count'): Promise<number> => {
    const scope = await customerNotificationScope();
    const { data, error } = await scope.db.rpc(rpc, { p_business_slug: slug });
    scope.ensureCurrent(); failNotification(error);
    if (!Number.isSafeInteger(data) || data < 0 || data > 2147483647) throw invalidNotificationResponse();
    return data;
  };
  const markAllNotificationsRead = () => notificationCount('mark_all_customer_notifications_read');
  const getUnreadNotificationCount = () => notificationCount('customer_notification_unread_count');
  // Join is explicit: login/screen integration calls this before enabling checkout. Never
  // auto-join from a placement retry, which could undo a completed leave in another tab.
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
  const auth = {
    async session() { const { data, error } = await requireClient().auth.getSession(); fail(error, 'Could not restore session'); return data.session; },
    async signIn(email: string, password: string) { const { data, error } = await requireClient().auth.signInWithPassword({ email, password }); fail(error, 'Could not sign in'); return data; },
    async signUp(email: string, password: string, emailRedirectTo?: string) { const { data, error } = await requireClient().auth.signUp({ email, password, options: { emailRedirectTo } }); fail(error, 'Could not sign up'); return { ...data, confirmationRequired: !data.session }; },
    async resetPassword(email: string, redirectTo?: string) { const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo }); fail(error, 'Could not send password reset'); },
    async exchangeCodeForSession(code: string) { const { data, error } = await requireClient().auth.exchangeCodeForSession(code); fail(error, 'Could not complete the email link'); return data.session; },
    async setSession(accessToken: string, refreshToken: string) { const { data, error } = await requireClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken }); fail(error, 'Could not complete the email link'); return data.session; },
    async updatePassword(password: string) { const { data, error } = await requireClient().auth.updateUser({ password }); fail(error, 'Could not update password'); return data.user; },
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
    const { data, error } = await db.from('businesses').select('contact_phone, whatsapp_phone, delivery_fee_paise, min_order_paise, settings_version, order_prefix, service_area_source, service_area_version, service_area_verified_at').eq('id', business.id).single();
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
    if (error?.code === '23503') throw new ServiceError('CATEGORY_MISSING', 'This category is no longer available. Reload the menu and choose a category.', error);
    fail(error, 'Could not save menu item');
    if (!data) throw new ServiceError('NOT_FOUND', 'Menu item was not found in this business.');
    return mapMenu(data as MenuRow, slug, photoBase);
  };
  const deleteMenuItem = async (id: string): Promise<void> => {
    if (typeof id !== 'string' || !id.trim()) throw new ServiceError('INVALID_MENU_ITEM', 'Choose a menu item to delete.');
    const db = requireClient(); const business = await requireAdminBusiness();
    const { data, error } = await db.from('menu_items').delete().eq('id', id).eq('business_id', business.id).select('id').maybeSingle();
    fail(error, 'Could not delete menu item');
    if (!data) throw new ServiceError('NOT_FOUND', 'Menu item was not found in this business.');
  };
  // Only availability changes, so the list switch never overwrites a concurrent dish edit.
  const setMenuItemAvailability = async (id: string, isAvailable: boolean): Promise<MenuItem> => {
    if (typeof id !== 'string' || !id.trim() || typeof isAvailable !== 'boolean') throw new ServiceError('INVALID_MENU_ITEM', 'Choose a dish and whether it is available.');
    const db = requireClient(); const business = await requireAdminBusiness();
    const { data, error } = await db.from('menu_items').update({ available: isAvailable }).eq('id', id).eq('business_id', business.id).select(menuSelect).maybeSingle();
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
  const placeOrder = async (input: PlaceOrderInput): Promise<Order> => {
    const db = requireClient();
    if (input.lines.some(line => line.item.businessId !== slug)) throw new ServiceError('BUSINESS_MISMATCH', 'All items must belong to this business.');
    const saved = input.savedAddress;
    if (!saved || typeof saved.id !== 'string' || !orderIdPattern.test(saved.id) || !Number.isSafeInteger(saved.version) || saved.version < 1) throw new ServiceError('INVALID_ADDRESS', 'Choose a saved address.');
    const fix = input.location && { latitude: input.location.latitude, longitude: input.location.longitude, accuracy: input.location.accuracy, captured_at: input.location.capturedAtISO };
    const p_delivery = { name: input.delivery.name, phone: input.delivery.phone, address_id: saved.id, address_version: saved.version };
    // Retries must send this exact payload: the server's request hash covers delivery and location.
    const { data, error } = await db.rpc('place_order', { p_business_slug: slug, p_items: input.lines.map(line => ({ menu_item_id: line.item.id, quantity: line.quantity })), p_delivery, p_location: fix, p_idempotency_key: input.idempotencyKey, p_accepted_pricing: input.pricing });
    lifecycleError(error);
    if (error?.code === ADDRESS_CHANGED_SQLSTATE) throw addressChanged(error);
    // Outside the area, or the restaurant's area isn't set up: either way nothing was written.
    if (error?.code === '22023' && /delivery unavailable/i.test(error.message)) throw new ServiceError('DELIVERY_UNAVAILABLE', 'We can\'t deliver to this address. Choose another address.', error);
    if (error?.code === NOT_ACCEPTING_ORDERS_SQLSTATE) throw new ServiceError('NOT_ACCEPTING_ORDERS', 'The restaurant is not taking orders right now.', error);
    fail(error, 'Could not place order');
    if (!data) throw new ServiceError('INVALID_RESPONSE', 'The server did not return an order.');
    if (data.outcome === 'pricing_changed' && !('id' in data)) throw new PricingChangedError(validateRevisedPricing(data.pricing, input.lines));
    if (data.outcome !== 'placed' || typeof data.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.id)) throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid order.');
    const order = await loadOrder(data.id);
    const accepted = input.pricing;
    if (order.subtotalPaise !== accepted.subtotal_paise || order.deliveryFeePaise !== accepted.delivery_fee_paise || order.totalPaise !== accepted.total_paise || order.lines.length !== accepted.lines.length ||
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
  return { mode: client ? 'backend' as const : 'demo' as const, persistenceAvailable: persistence.isAvailable, dispose, auth, joinBusiness, getBusiness, getMenu, getOrders, getOrderHistory, getActiveOrders, getCustomerOrder, listNotifications, markNotificationRead, markAllNotificationsRead, getUnreadNotificationCount, isAdmin, getOwnerDisplayName, getOwnerProfile, setOwnerDisplayName, getRestaurantSettings, saveRestaurantSettings, getCategories, saveCategory, deleteCategory, saveMenuItem, deleteMenuItem, setMenuItemAvailability, reorderMenuItems, reorderCategories, getDailySummary, uploadMenuPhoto, removeMenuPhoto, retryMenuPhotoCleanup, placeOrder, listAddresses, saveAddress, deleteAddress, transitionOrder, subscribeOrders, setAcceptingOrders, subscribeBusinessState, registerDeviceToken, unregisterDeviceToken };
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
