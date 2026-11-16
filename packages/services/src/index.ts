import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import { businesses, isDiet, type Diet, type AppAudience, type BusinessSlug, type CartLine, type DailySummary, type DeliveryDetails, type LocationFix, type MenuItem, type Order, type OrderStatus } from '@market/core';
import { storage } from './storage';

export type { SupportedStorage } from '@supabase/supabase-js';
export interface PublicConfig { url?: string; anonKey?: string }
export interface Business { contactPhone?: string | null; id: string; slug: BusinessSlug; name: string; deliveryFeePaise: number; minOrderPaise: number; isDemo: boolean; orderingEnabled: boolean; acceptingOrders: boolean }
export interface MenuCategory { id: string; businessId: BusinessSlug; name: string; sortOrder: number }
export interface SaveCategoryInput { id?: string; name: string; sortOrder: number }
export interface SaveMenuItemInput { diet: Diet | null; id?: string; name: string; description: string; categoryId: string; pricePaise: number; isAvailable: boolean; isDemo: boolean; isFeatured: boolean; sortOrder: number }
export interface PricingTerms {
  lines: { menu_item_id: string; quantity: number; unit_price_paise: number; line_total_paise: number }[];
  delivery_fee_paise: number; min_order_paise: number; subtotal_paise: number; total_paise: number;
}
export interface PlaceOrderInput { pricing: PricingTerms; lines: readonly CartLine[]; delivery: DeliveryDetails; location: LocationFix; idempotencyKey: string }
/** Preserve the database timestamp verbatim: JavaScript dates lose microseconds. */
export interface OrderCursor { createdAtISO: string; id: string }
export interface OrderPageOptions { cursor?: OrderCursor | null; limit?: number }
export interface OrderPage { orders: Order[]; nextCursor: OrderCursor | null }
export interface ServiceOptions { businessSlug: BusinessSlug; audience: AppAudience; config?: PublicConfig; storage?: SupportedStorage }

export class ServiceError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) { super(message); this.name = 'ServiceError'; this.code = code; this.cause = cause; }
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

/** SQLSTATE raised by place_order when the restaurant is closed for new orders (#58). */
const NOT_ACCEPTING_ORDERS_SQLSTATE = 'PT409';

/** The storage key is isolated by backend, business and audience. */
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
type OrderRow = { order_number?: string | null; id: string; status: OrderStatus; version: number; subtotal_paise: number; delivery_fee_paise: number; total_paise: number; customer_name: string; customer_phone: string; delivery_address_line: string; latitude?: number | null; longitude?: number | null; created_at: string; order_items: { diet: Diet | null; menu_item_id: string; name: string; quantity: number; unit_price_paise: number; line_total_paise: number }[]; order_status_history?: HistoryRow[] };
// Owner reads embed the snapshot; RLS returns null for anyone but that restaurant's owners.
type HistoryRow = { status: OrderStatus; created_at: string; order_status_actors?: { actor_name: string } | { actor_name: string }[] | null };
const actorName = (row: HistoryRow) => { const actor = Array.isArray(row.order_status_actors) ? row.order_status_actors[0] : row.order_status_actors; return typeof actor?.actor_name === 'string' ? { actorName: actor.actor_name } : {}; };
export function mapMenu(row: MenuRow, slug: BusinessSlug, storageBase = ''): MenuItem {
  return { id: row.id, businessId: slug, name: row.name, description: row.description ?? '', category: row.menu_categories.name, categoryId: row.category_id, categorySortOrder: row.menu_categories.sort_order, diet: row.diet, pricePaise: row.price_paise, isAvailable: row.available, isDemo: row.is_demo, isFeatured: row.is_featured, sortOrder: row.sort_order, ...(row.image_url ? { imageUrl: storageBase + row.image_url } : {}) };
}
export function mapOrder(row: OrderRow, slug: BusinessSlug): Order {
  return { id: row.id, ...(row.order_number ? { orderNumber: row.order_number } : {}), businessId: slug, status: row.status, version: row.version, subtotalPaise: row.subtotal_paise, deliveryFeePaise: row.delivery_fee_paise, totalPaise: row.total_paise, delivery: { name: row.customer_name, phone: row.customer_phone, addressLine: row.delivery_address_line }, createdAtISO: row.created_at, ...(typeof row.latitude === 'number' && typeof row.longitude === 'number' ? { location: { latitude: row.latitude, longitude: row.longitude } } : {}), lines: row.order_items.map(item => ({ menuItemId: item.menu_item_id, diet: item.diet, name: item.name, quantity: item.quantity, unitPricePaise: item.unit_price_paise, lineTotalPaise: item.line_total_paise })), ...(row.order_status_history ? { history: row.order_status_history.map(item => ({ status: item.status, createdAtISO: item.created_at, ...actorName(item) })).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO)) } : {}) };
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
    const { data, error } = await client.from('businesses').select('id, slug, name, delivery_fee_paise, min_order_paise, is_demo, ordering_enabled, accepting_orders, contact_phone').eq('slug', slug).single();
    fail(error, 'Could not load business');
    if (!data) throw new ServiceError('NOT_FOUND', 'Business not found.');
    return { contactPhone: data.contact_phone ?? null, id: data.id, slug, name: data.name, deliveryFeePaise: data.delivery_fee_paise, minOrderPaise: data.min_order_paise, isDemo: data.is_demo, orderingEnabled: data.ordering_enabled, acceptingOrders: data.accepting_orders === true };
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
  const requireAdminBusiness = async (): Promise<Business> => {
    if (audience !== 'admin') throw new ServiceError('ADMIN_REQUIRED', 'Use an admin account to manage the menu.');
    const business = await getBusiness();
    if (!await isAdmin()) throw new ServiceError('ADMIN_REQUIRED', 'Admin membership is required to manage the menu.');
    return business;
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
  const checkDeliveryEligibility = async (location: LocationFix): Promise<boolean> => {
    const { data, error } = await requireClient().rpc('check_delivery_eligibility', { p_business_slug: slug, p_location: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy, captured_at: location.capturedAtISO } });
    fail(error, 'Could not check delivery eligibility');
    if (typeof data?.eligible !== 'boolean') throw new ServiceError('INVALID_RESPONSE', 'The server did not return delivery eligibility.');
    return data.eligible;
  };
  const placeOrder = async (input: PlaceOrderInput): Promise<Order> => {
    const db = requireClient();
    if (input.lines.some(line => line.item.businessId !== slug)) throw new ServiceError('BUSINESS_MISMATCH', 'All items must belong to this business.');
    const { data, error } = await db.rpc('place_order', { p_business_slug: slug, p_items: input.lines.map(line => ({ menu_item_id: line.item.id, quantity: line.quantity })), p_delivery: { name: input.delivery.name, phone: input.delivery.phone, address_line: input.delivery.addressLine }, p_location: { latitude: input.location.latitude, longitude: input.location.longitude, accuracy: input.location.accuracy, captured_at: input.location.capturedAtISO }, p_idempotency_key: input.idempotencyKey, p_accepted_pricing: input.pricing });
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
  return { mode: client ? 'backend' as const : 'demo' as const, persistenceAvailable: persistence.isAvailable, dispose, auth, getBusiness, getMenu, getOrders, getOrderHistory, getActiveOrders, getCustomerOrder, isAdmin, getOwnerDisplayName, getCategories, saveCategory, deleteCategory, saveMenuItem, deleteMenuItem, setMenuItemAvailability, reorderMenuItems, reorderCategories, getDailySummary, uploadMenuPhoto, removeMenuPhoto, retryMenuPhotoCleanup, checkDeliveryEligibility, placeOrder, transitionOrder, subscribeOrders, setAcceptingOrders, subscribeBusinessState, registerDeviceToken, unregisterDeviceToken };
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
