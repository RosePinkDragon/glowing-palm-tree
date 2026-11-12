import { createClient, type SupabaseClient, type SupportedStorage } from '@supabase/supabase-js';
import { businesses, type AppAudience, type BusinessSlug, type CartLine, type DeliveryDetails, type LocationFix, type MenuItem, type Order, type OrderStatus } from '@market/core';
import { storage } from './storage';

export type { SupportedStorage } from '@supabase/supabase-js';
export interface PublicConfig { url?: string; anonKey?: string }
export interface Business { id: string; slug: BusinessSlug; name: string; deliveryFeePaise: number; minOrderPaise: number; isDemo: boolean; orderingEnabled: boolean }
export interface PlaceOrderInput { lines: readonly CartLine[]; delivery: DeliveryDetails; location: LocationFix; idempotencyKey: string }
export interface ServiceOptions { businessSlug: BusinessSlug; audience: AppAudience; config?: PublicConfig; storage?: SupportedStorage }

export class ServiceError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) { super(message); this.name = 'ServiceError'; this.code = code; this.cause = cause; }
}

function fail(error: { message: string; code?: string } | null, action: string): void {
  if (error) throw new ServiceError(error.code ?? 'BACKEND_ERROR', `${action}: ${error.message}`, error);
}

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
      if (available) try { await backing.removeItem(key); } catch { available = false; }
    },
  };
  return { adapter, isAvailable: () => available };
}

// The direct property reads allow Expo to inline only public environment variables.
function publicConfig(): PublicConfig {
  return { url: process.env.EXPO_PUBLIC_SUPABASE_URL, anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY };
}

type MenuRow = { id: string; name: string; description: string | null; category: string; price_paise: number; available: boolean; is_demo: boolean; image_url: string | null };
type OrderRow = { id: string; status: OrderStatus; version: number; subtotal_paise: number; delivery_fee_paise: number; total_paise: number; customer_name: string; customer_phone: string; delivery_address_line: string; created_at: string; order_items: { menu_item_id: string; name: string; quantity: number; unit_price_paise: number; line_total_paise: number }[]; order_status_history?: { status: OrderStatus; created_at: string }[] };
export function mapMenu(row: MenuRow, slug: BusinessSlug): MenuItem {
  return { id: row.id, businessId: slug, name: row.name, description: row.description ?? '', category: row.category, pricePaise: row.price_paise, isAvailable: row.available, isDemo: row.is_demo, ...(row.image_url ? { imageUrl: row.image_url } : {}) };
}
export function mapOrder(row: OrderRow, slug: BusinessSlug): Order {
  return { id: row.id, businessId: slug, status: row.status, version: row.version, subtotalPaise: row.subtotal_paise, deliveryFeePaise: row.delivery_fee_paise, totalPaise: row.total_paise, delivery: { name: row.customer_name, phone: row.customer_phone, addressLine: row.delivery_address_line }, createdAtISO: row.created_at, lines: row.order_items.map(item => ({ menuItemId: item.menu_item_id, name: item.name, quantity: item.quantity, unitPricePaise: item.unit_price_paise, lineTotalPaise: item.line_total_paise })), ...(row.order_status_history ? { history: row.order_status_history.map(item => ({ status: item.status, createdAtISO: item.created_at })).sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO)) } : {}) };
}
const orderSelect = '*, order_items(*), order_status_history(*)';

export function createMarketServices(options: ServiceOptions) {
  const { businessSlug: slug, audience } = options;
  const config = options.config ?? publicConfig();
  const url = config.url?.trim();
  const key = config.anonKey?.trim();
  if (Boolean(url) !== Boolean(key)) throw new ServiceError('INVALID_CONFIG', 'Set both EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY, or neither for demo browsing.');
  if (key && !isPublicKey(key)) throw new ServiceError('INVALID_CONFIG', 'Use a Supabase publishable key or legacy anon key for the client.');
  const persistence = safeStorage(options.storage ?? storage);
  const client: SupabaseClient | null = url && key ? createClient(url, key, { auth: { storage: persistence.adapter, storageKey: sessionStorageKey(url, slug, audience), persistSession: true, autoRefreshToken: true, detectSessionInUrl: typeof window !== 'undefined' } }) : null;
  let disposed = false;
  let generation = 0;
  let sessionUserId: string | undefined;
  const subscriptions = new Set<() => void>();
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
    if (!client) return { id: slug, slug, name: businesses[slug].name, deliveryFeePaise: 0, minOrderPaise: 0, isDemo: true, orderingEnabled: false };
    const { data, error } = await client.from('businesses').select('id, slug, name, delivery_fee_paise, min_order_paise, is_demo, ordering_enabled').eq('slug', slug).single();
    fail(error, 'Could not load business');
    if (!data) throw new ServiceError('NOT_FOUND', 'Business not found.');
    return { id: data.id, slug, name: data.name, deliveryFeePaise: data.delivery_fee_paise, minOrderPaise: data.min_order_paise, isDemo: data.is_demo, orderingEnabled: data.ordering_enabled };
  };
  const getMenu = async (): Promise<MenuItem[]> => {
    if (!client) return [{ id: `sample-${slug}`, businessId: slug, name: 'Sample dish', description: 'Sample menu item for browsing only.', category: 'Samples', pricePaise: 0, isAvailable: false, isDemo: true }];
    const business = await getBusiness();
    const { data, error } = await client.from('menu_items').select('*').eq('business_id', business.id).order('name');
    fail(error, 'Could not load menu');
    return (data ?? []).map(row => mapMenu(row as MenuRow, slug));
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
  const auth = {
    async session() { const { data, error } = await requireClient().auth.getSession(); fail(error, 'Could not restore session'); return data.session; },
    async signIn(email: string, password: string) { const { data, error } = await requireClient().auth.signInWithPassword({ email, password }); fail(error, 'Could not sign in'); return data; },
    async signUp(email: string, password: string, emailRedirectTo?: string) { const { data, error } = await requireClient().auth.signUp({ email, password, options: { emailRedirectTo } }); fail(error, 'Could not sign up'); return { ...data, confirmationRequired: !data.session }; },
    async resetPassword(email: string, redirectTo?: string) { const { error } = await requireClient().auth.resetPasswordForEmail(email, { redirectTo }); fail(error, 'Could not send password reset'); },
    async exchangeCodeForSession(code: string) { const { data, error } = await requireClient().auth.exchangeCodeForSession(code); fail(error, 'Could not complete the email link'); return data.session; },
    async setSession(accessToken: string, refreshToken: string) { const { data, error } = await requireClient().auth.setSession({ access_token: accessToken, refresh_token: refreshToken }); fail(error, 'Could not complete the email link'); return data.session; },
    async updatePassword(password: string) { const { data, error } = await requireClient().auth.updateUser({ password }); fail(error, 'Could not update password'); return data.user; },
    async signOut() { const db = requireClient(); clearSubscriptions(); const { error } = await db.auth.signOut(); fail(error, 'Could not sign out'); },
    onChange(callback: Parameters<SupabaseClient['auth']['onAuthStateChange']>[0]) { const { data } = requireClient().auth.onAuthStateChange(callback); return () => data.subscription.unsubscribe(); },
  };
  const isAdmin = async (): Promise<boolean> => {
    const db = requireClient(); const business = await getBusiness();
    const { data: user, error: userError } = await db.auth.getUser(); fail(userError, 'Could not verify your account');
    if (!user.user) return false;
    const { data, error } = await db.from('business_memberships').select('role').eq('business_id', business.id).eq('user_id', user.user.id).eq('role', 'admin').maybeSingle();
    fail(error, 'Could not verify admin membership'); return !!data;
  };
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
    const { data, error } = await db.rpc('place_order', { p_business_slug: slug, p_items: input.lines.map(line => ({ menu_item_id: line.item.id, quantity: line.quantity })), p_delivery: { name: input.delivery.name, phone: input.delivery.phone, address_line: input.delivery.addressLine }, p_location: { latitude: input.location.latitude, longitude: input.location.longitude, accuracy: input.location.accuracy, captured_at: input.location.capturedAtISO }, p_idempotency_key: input.idempotencyKey });
    fail(error, 'Could not place order');
    if (!data) throw new ServiceError('INVALID_RESPONSE', 'The server did not return an order.');
    if (typeof data.id !== 'string') throw new ServiceError('INVALID_RESPONSE', 'The server returned an invalid order.');
    return loadOrder(data.id);
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
  const dispose = () => { if (disposed) return; disposed = true; clearSubscriptions(); authListener?.unsubscribe(); };
  return { mode: client ? 'backend' as const : 'demo' as const, persistenceAvailable: persistence.isAvailable, dispose, auth, getBusiness, getMenu, getOrders, isAdmin, checkDeliveryEligibility, placeOrder, transitionOrder, subscribeOrders };
}

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
