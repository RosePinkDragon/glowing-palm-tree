/** The only permitted event names and dimensions. Never accept caller-provided text. */
export type EventName = 'app_open' | 'menu_view' | 'ordering_started' | 'order_completed' | 'notifications_enabled';
export type Brand = 'ammu_sammu' | 'kokani_dine_inn';
export type Audience = 'customer' | 'admin';
export type AnalyticsContext = { brand: Brand; audience: Audience };
export interface AnalyticsPort {
  enable(): Promise<void>;
  disable(): Promise<void>;
  send(name: EventName, context: AnalyticsContext): void;
}
const events = new Set<string>(['app_open', 'menu_view', 'ordering_started', 'order_completed', 'notifications_enabled']);
const brands = new Set<string>(['ammu_sammu', 'kokani_dine_inn']);
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

/** Speed monitoring (Firebase Performance). The only custom traces; names carry no data and traces take no attributes. */
export type TraceName = 'checkout_submit' | 'otp_request' | 'otp_verify' | 'photo_upload';
export interface MonitoringPort {
  /** Loads and starts the SDK. Must not be called before consent. */
  enable(): Promise<void>;
  /** Stops collection. */
  disable(): Promise<void>;
}
type Tracer = (name: TraceName) => () => void;
let tracer: Tracer | undefined;
/** Installed by a monitoring adapter while it is enabled; pass undefined on withdrawal. */
export function setTracer(next: Tracer | undefined) { tracer = next; }
/** Runs `work` inside a named trace when speed monitoring is active; otherwise just runs it. A tracing fault never affects `work`. */
export async function traced<T>(name: TraceName, work: () => Promise<T>): Promise<T> {
  let stop: (() => void) | undefined;
  try { stop = tracer?.(name); } catch { stop = undefined; }
  try { return await work(); }
  finally { try { stop?.(); } catch { /* ignore */ } }
}

/** Error reports (Sentry). The reporter is installed only while consent is on; reportError does nothing otherwise. */
let reporter: ((error: unknown) => void) | undefined;
export function setErrorReporter(next: ((error: unknown) => void) | undefined) { reporter = next; }
export function reportError(error: unknown) { try { reporter?.(error); } catch { /* reporting must never break the screen */ } }

// Redaction for anything that leaves the device in an error report or breadcrumb. Order matters: URLs first, then emails, phones, then codes.
// Every pattern is bounded or anchored to a token start so a long string cannot cause quadratic work.
const urlLikeHead = /^[("']*\/|(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\//i;
const emailLike = /[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){1,8}/gi;
// Digits glued to letters or other digits are hashes, ids or versions, not codes or phone numbers.
const indianPhone = /(?<![0-9A-Za-z])(?:\+\s?91[\s-]?|91[\s-]?|0)?\d{5}[\s-]?\d{5}(?![0-9A-Za-z])/g;
const codeLike = /(?<![0-9A-Za-z])\d{4,8}(?![0-9A-Za-z])/g;
/**
 * Removes the query string and fragment from any scheme:// URL and from /paths, whole or embedded in text. Touches nothing else.
 * Works token by token (split on whitespace) so cost stays linear in the length of the input.
 */
export function stripUrlQuery(value: string): string {
  return value.replace(/\S+/g, token => {
    const at = token.search(/[?#]/);
    if (at < 0 || !urlLikeHead.test(token.slice(0, at))) return token;
    return token.slice(0, at) + token.slice(at).replace(/[?#][^"'<>)]*/g, '');
  });
}
/** Removes query strings and fragments from URLs, and redacts emails, Indian phone numbers (10 digits, +91 forms) and standalone 4 to 8 digit codes. */
export function scrubText(value: string): string {
  return stripUrlQuery(value).replace(emailLike, '[email]').replace(indianPhone, '[phone]').replace(codeLike, '[code]');
}
function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => scrubValue(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = scrubValue(item, depth + 1);
  return result;
}
/** Minimal shape of a Sentry event/breadcrumb; the scrubber is generic so it needs no SDK types. */
type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Breadcrumbs: only the free-text message and data can carry user input; type, category, level and timestamp pass through. */
export function scrubBreadcrumb<T extends Loose>(breadcrumb: T): T {
  const copy: Loose = { ...breadcrumb };
  if ('message' in copy) copy.message = scrubValue(copy.message, 0);
  if ('data' in copy) copy.data = scrubValue(copy.data, 0);
  return copy as T;
}
function scrubFrame(frame: unknown): unknown {
  if (!isObject(frame)) return frame;
  const copy: Loose = { ...frame };
  for (const key of ['filename', 'abs_path']) if (typeof copy[key] === 'string') copy[key] = stripUrlQuery(copy[key] as string);
  if ('vars' in copy) copy.vars = scrubValue(copy.vars, 0);
  return copy;
}
function scrubException(exception: unknown): unknown {
  if (!isObject(exception) || !Array.isArray(exception.values)) return exception;
  return {
    ...exception,
    values: exception.values.map(item => {
      if (!isObject(item)) return item;
      const copy: Loose = { ...item };
      if ('value' in copy) copy.value = scrubValue(copy.value, 0);
      if (isObject(copy.stacktrace) && Array.isArray(copy.stacktrace.frames)) copy.stacktrace = { ...copy.stacktrace, frames: copy.stacktrace.frames.map(scrubFrame) };
      return copy;
    })
  };
}
/**
 * Drops identity and request payload fields entirely, then scrubs only the fields a user can influence:
 * message, logentry, exception values, breadcrumbs, request url, extra, tags and non-trace contexts.
 * Structural fields (event_id, release, environment, dist, sdk, timestamp, platform, trace data, debug_meta, stack frames) are never rewritten,
 * apart from the query and fragment of frame file names.
 */
export function scrubEvent<T extends Loose>(event: T): T {
  const copy: Loose = { ...event };
  delete copy.user; delete copy.server_name;
  if (isObject(copy.request)) {
    const { url, method } = copy.request;
    copy.request = { ...(typeof url === 'string' ? { url: stripUrlQuery(url) } : {}), ...(typeof method === 'string' ? { method } : {}) };
  } else delete copy.request;
  if ('message' in copy) copy.message = scrubValue(copy.message, 0);
  if ('logentry' in copy) copy.logentry = scrubValue(copy.logentry, 0);
  if ('exception' in copy) copy.exception = scrubException(copy.exception);
  if (Array.isArray(copy.breadcrumbs)) copy.breadcrumbs = copy.breadcrumbs.map(item => isObject(item) ? scrubBreadcrumb(item) : item);
  if ('extra' in copy) copy.extra = scrubValue(copy.extra, 0);
  if ('tags' in copy) copy.tags = scrubValue(copy.tags, 0);
  if (isObject(copy.contexts)) {
    const contexts: Loose = {};
    for (const [key, item] of Object.entries(copy.contexts)) contexts[key] = key === 'trace' ? item : scrubValue(item, 0);
    copy.contexts = contexts;
  }
  return copy as T;
}

/** Same consent rules as createAnalytics for ports that send nothing themselves. Never rejects: a monitoring fault must not block the app. */
export function createMonitoring(ports: MonitoringPort[]) {
  let consent = false;
  let version = 0;
  const queues = ports.map(() => Promise.resolve());
  return {
    setConsent(granted: boolean): Promise<void> {
      consent = granted === true;
      const current = ++version;
      ports.forEach((port, index) => {
        queues[index] = queues[index].then(async () => {
          try {
            if (consent && current === version) {
              await port.enable();
              if (!consent || current !== version) await port.disable();
            } else if (!consent) await port.disable();
          } catch { /* unconfigured or unsupported: stay off */ }
        });
      });
      return Promise.all(queues).then(() => {});
    }
  };
}

/** Fires each event (optionally per key, such as an order id) at most once. A call that was not sent (no consent yet) may be retried. */
export function createEventOnce(track: (name: EventName) => Promise<boolean>) {
  const state = new Map<string, 'pending' | 'sent'>();
  return {
    async fire(name: EventName, key = ''): Promise<void> {
      const id = `${name}:${key}`;
      if (state.has(id)) return;
      state.set(id, 'pending');
      let sent = false;
      try { sent = await track(name); } catch { sent = false; }
      if (sent) state.set(id, 'sent'); else state.delete(id);
    }
  };
}

export type Availability = { status: 'ready' } | { status: 'unsupported' | 'unconfigured' | 'denied' | 'error'; reason: string };
export type TokenResult = { status: 'ready'; token: string } | Exclude<Availability, { status: 'ready' }>;
export interface MessagingPort {
  /** Called only from an explicit user gesture. */
  requestToken(): Promise<TokenResult>;
  /** Restore only if browser permission was already granted; never prompt. */
  resumeToken(): Promise<TokenResult>;
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
  function start(userId: string, prompt: boolean): Promise<Availability> {
    if (!userId) return Promise.resolve({ status: 'error', reason: 'Sign in before enabling notifications.' });
    const current = ++epoch;
    // Start synchronously to preserve the explicit click gesture.
    const tokenResult = prompt ? port.requestToken() : port.resumeToken();
    return run(async () => {
      const result = await tokenResult;
      if (current !== epoch) return { status: 'error', reason: 'Notification request was superseded.' };
      if (result.status !== 'ready') return result;
      if (!result.token) return { status: 'error', reason: 'No notification token was returned.' };
      if (owned && (owned.userId !== userId || owned.token !== result.token)) await clear();
      if (current !== epoch) return { status: 'error', reason: 'Notification request was superseded.' };
      // Always rebind on resume: the same user can have a new auth session.
      await backend.register(userId, result.token);
      owned = { userId, token: result.token };
      if (current !== epoch) { await clear(); return { status: 'error', reason: 'Notification request was superseded.' }; }
      return { status: 'ready' };
    });
  }
  return {
    /** Invoke directly in response to an authenticated user's notification opt-in. */
    enable(userId: string): Promise<Availability> { return start(userId, true); },
    /** Rebind an opted-in user and current auth session without requesting permission. */
    resume(userId: string): Promise<Availability> { return start(userId, false); },
    /** Immediately invalidate in-flight work before auth changes. */
    invalidate(): void { ++epoch; },
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
    async resumeToken() { return { status: 'unsupported', reason: 'Notifications are not available on this device.' }; },
    async deleteToken() {},
    onHint() { return () => {}; }
  };
}
