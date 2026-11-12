/** The only permitted event names and dimensions. Never accept caller-provided text. */
export type EventName = 'app_open' | 'menu_view' | 'ordering_started' | 'order_completed' | 'notifications_enabled';
export type Brand = 'ammu_sammu' | 'konkan_fine_dine';
export type Audience = 'customer' | 'admin';
export type AnalyticsContext = { brand: Brand; audience: Audience };
export interface AnalyticsPort {
  enable(): Promise<void>;
  disable(): Promise<void>;
  send(name: EventName, context: AnalyticsContext): void;
}
const events = new Set<string>(['app_open', 'menu_view', 'ordering_started', 'order_completed', 'notifications_enabled']);
const brands = new Set<string>(['ammu_sammu', 'konkan_fine_dine']);
const audiences = new Set<string>(['customer', 'admin']);

/** No SDK is initialized until setConsent(true). Calls are serialized across withdrawal. */
export function createAnalytics(port: AnalyticsPort, context: AnalyticsContext) {
  if (!brands.has(context.brand) || !audiences.has(context.audience)) throw new Error('Invalid analytics context');
  // Copy only allowlisted dimensions: extra properties from untyped callers are discarded.
  const safeContext = { brand: context.brand, audience: context.audience };
  let consent = false;
  let version = 0;
  let queue = Promise.resolve();
  return {
    setConsent(granted: boolean): Promise<void> {
      consent = granted === true;
      const current = ++version;
      queue = queue.catch(() => {}).then(async () => {
        if (granted === true && consent && current === version) {
          await port.enable();
          if (!consent || current !== version) await port.disable();
        } else if (granted !== true) await port.disable();
      });
      return queue;
    },
    async track(name: EventName): Promise<boolean> {
      if (!consent || !events.has(name)) return false;
      const current = version;
      await queue;
      if (!consent || current !== version) return false;
      port.send(name, safeContext);
      return true;
    }
  };
}

export type Availability = { status: 'ready' } | { status: 'unsupported' | 'unconfigured' | 'denied' | 'error'; reason: string };
export type TokenResult = { status: 'ready'; token: string } | Exclude<Availability, { status: 'ready' }>;
export interface MessagingPort {
  /** Called only from an explicit user gesture. */
  requestToken(): Promise<TokenResult>;
  deleteToken(): Promise<void>;
  onHint(refresh: () => void): () => void;
}
export interface TokenBackend {
  register(userId: string, token: string): Promise<void>;
  remove(userId: string, token: string): Promise<void>;
}

/** Backend operations must enforce authenticated ownership; do not treat userId as proof. */
export function createMessaging(port: MessagingPort, backend: TokenBackend) {
  let owned: { userId: string; token: string } | undefined;
  let queue = Promise.resolve();
  let epoch = 0;
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => {}).then(work);
    queue = result.then(() => {}, () => {});
    return result;
  };
  async function clear() {
    if (!owned) return;
    // Retain ownership on failure so logout/rotation can be retried.
    await backend.remove(owned.userId, owned.token);
    owned = undefined;
  }
  return {
    /** Invoke directly in response to an authenticated user's notification opt-in. */
    async enable(userId: string): Promise<Availability> {
      if (!userId) return { status: 'error', reason: 'Sign in before enabling notifications.' };
      const current = ++epoch;
      // Call synchronously before any await, preserving browser gesture requirements.
      const tokenResult = port.requestToken();
      return run(async () => {
        const result = await tokenResult;
        if (current !== epoch) return { status: 'error', reason: 'Notification request was superseded.' };
        if (result.status !== 'ready') return result;
        if (!result.token) return { status: 'error', reason: 'No notification token was returned.' };
        if (owned && (owned.userId !== userId || owned.token !== result.token)) await clear();
        if (!owned) {
          await backend.register(userId, result.token);
          owned = { userId, token: result.token };
        }
        return { status: 'ready' };
      });
    },
    /** Call before signing out or switching accounts, while backend authentication remains valid. */
    disable(): Promise<void> {
      ++epoch;
      return run(async () => { await clear(); await port.deleteToken(); });
    },
    onHint(refresh: () => void): () => void { return port.onHint(refresh); }
  };
}

/** Native needs a development build and a verified provider integration, not Expo Go. */
export function unavailableNativeMessaging(): MessagingPort {
  return {
    async requestToken() { return { status: 'unsupported', reason: 'Native push requires a configured development build and provider integration.' }; },
    async deleteToken() {},
    onHint() { return () => {}; }
  };
}
