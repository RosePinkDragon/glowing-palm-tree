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
const customTraceNames = ['checkout_submit', 'otp_request', 'otp_verify', 'photo_upload'] as const;
const traceNames = new Set<string>(customTraceNames);
export type TraceName = typeof customTraceNames[number];
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
  try { if (traceNames.has(name)) stop = tracer?.(name); } catch { stop = undefined; }
  try { return await work(); }
  finally { try { stop?.(); } catch { /* ignore */ } }
}

/** Error reports (Sentry). The reporter is installed only while consent is on; reportError does nothing otherwise. */
let reporter: ((error: unknown) => void) | undefined;
export function setErrorReporter(next: ((error: unknown) => void) | undefined) { reporter = next; }
export function reportError(error: unknown) { try { reporter?.(error); } catch { /* reporting must never break the screen */ } }

// Text redaction order matters: URLs first, then emails, phones, then codes.
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
/** Minimal shape of a Sentry event/breadcrumb; the scrubber is generic so it needs no SDK types. */
type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => value !== null && typeof value === 'object' && !Array.isArray(value);
const redactedError = 'Error details removed';
const httpMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const exceptionTypes = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError', 'DOMException', 'AbortError', 'ServiceError', 'OfferError', 'OtpError']);
const breadcrumbCategories = new Set(['console', 'fetch', 'xhr', 'navigation', 'ui.click', 'ui.input', 'sentry.event']);
const eventLevels = new Set(['fatal', 'error', 'warning', 'log', 'info', 'debug']);

function requestSummary(value: Loose): Loose {
  const summary: Loose = {};
  if (typeof value.method === 'string' && httpMethods.has(value.method)) summary.method = value.method;
  if (typeof value.url === 'string') {
    try {
      const url = new URL(value.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') summary.url = url.origin;
    } catch { /* A relative path carries no origin. */ }
  }
  return summary;
}

/** Keep the category and basic HTTP diagnostics without messages or arbitrary payload data. */
export function scrubBreadcrumb<T extends Loose>(breadcrumb: T): T {
  const copy: Loose = {};
  if (typeof breadcrumb.category === 'string' && breadcrumbCategories.has(breadcrumb.category)) copy.category = breadcrumb.category;
  if (typeof breadcrumb.level === 'string' && eventLevels.has(breadcrumb.level)) copy.level = breadcrumb.level;
  if (typeof breadcrumb.timestamp === 'number' && Number.isFinite(breadcrumb.timestamp)) copy.timestamp = breadcrumb.timestamp;
  if (isObject(breadcrumb.data)) {
    const { status_code } = breadcrumb.data;
    const summary = requestSummary(breadcrumb.data);
    if (typeof status_code === 'number' && Number.isInteger(status_code) && status_code >= 0 && status_code <= 599) {
      summary.status_code = status_code;
    }
    if (Object.keys(summary).length) copy.data = summary;
  }
  return copy as T;
}

// Stack strings can come from a thrown value. Preserve only generated Expo bundle paths and numeric positions.
function codeAsset(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const path = new URL(value, 'https://app.invalid').pathname;
    return path.match(/\/_expo\/static\/js\/web\/(?:index|chunk)-[\da-f]{32}\.js$/i)?.[0];
  } catch { return undefined; }
}
function scrubStacktrace(stacktrace: unknown): Loose | undefined {
  if (!isObject(stacktrace) || !Array.isArray(stacktrace.frames)) return undefined;
  const frames = stacktrace.frames.flatMap(frame => {
    if (!isObject(frame)) return [];
    const filename = codeAsset(frame.filename) ?? codeAsset(frame.abs_path);
    if (!filename) return [];
    const copy: Loose = { filename };
    if (typeof frame.lineno === 'number' && Number.isInteger(frame.lineno)) copy.lineno = frame.lineno;
    if (typeof frame.colno === 'number' && Number.isInteger(frame.colno)) copy.colno = frame.colno;
    if (typeof frame.in_app === 'boolean') copy.in_app = frame.in_app;
    return [copy];
  });
  return frames.length ? { frames } : undefined;
}
function scrubException(exception: unknown): Loose | undefined {
  if (!isObject(exception) || !Array.isArray(exception.values)) return undefined;
  const values = exception.values.filter(isObject).map(item => {
    const copy: Loose = { type: typeof item.type === 'string' && exceptionTypes.has(item.type) ? item.type : 'Error', value: redactedError };
    const stacktrace = scrubStacktrace(item.stacktrace);
    if (stacktrace) copy.stacktrace = stacktrace;
    if (isObject(item.mechanism)) {
      const { handled, exception_id, parent_id, is_exception_group } = item.mechanism;
      const mechanism: Loose = { type: 'generic' };
      if (typeof handled === 'boolean') mechanism.handled = handled;
      if (typeof exception_id === 'number' && Number.isInteger(exception_id)) mechanism.exception_id = exception_id;
      if (typeof parent_id === 'number' && Number.isInteger(parent_id)) mechanism.parent_id = parent_id;
      if (typeof is_exception_group === 'boolean') mechanism.is_exception_group = is_exception_group;
      copy.mechanism = mechanism;
    }
    return copy;
  });
  return values.length ? { values } : undefined;
}
/**
 * Free-text messages can contain names or addresses in any language. Replace them before sending,
 * and keep stack locations, release metadata and basic HTTP diagnostics for triage.
 */
export function scrubEvent<T extends Loose>(event: T): T {
  const copy: Loose = {};
  for (const key of ['event_id', 'release', 'environment', 'dist', 'platform']) {
    if (typeof event[key] === 'string') copy[key] = event[key];
  }
  if (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)) copy.timestamp = event.timestamp;
  if (typeof event.level === 'string' && eventLevels.has(event.level)) copy.level = event.level;
  if (isObject(event.sdk) && event.sdk.name === 'sentry.javascript.browser' &&
    typeof event.sdk.version === 'string' && /^\d+\.\d+\.\d+$/.test(event.sdk.version)) {
    copy.sdk = { name: event.sdk.name, version: event.sdk.version };
  }
  if (isObject(event.debug_meta) && Array.isArray(event.debug_meta.images)) {
    const images = event.debug_meta.images.flatMap(image => {
      if (!isObject(image) || image.type !== 'sourcemap' ||
        typeof image.debug_id !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(image.debug_id)) return [];
      const codeFile = codeAsset(image.code_file);
      return codeFile ? [{ type: 'sourcemap', debug_id: image.debug_id, code_file: codeFile }] : [];
    });
    if (images.length) copy.debug_meta = { images };
  }
  if (isObject(event.request)) copy.request = requestSummary(event.request);
  if ('message' in event || 'logentry' in event) copy.message = redactedError;
  const exception = scrubException(event.exception);
  if (exception) copy.exception = exception;
  const stacktrace = scrubStacktrace(event.stacktrace);
  if (stacktrace) copy.stacktrace = stacktrace;
  if (Array.isArray(event.breadcrumbs)) copy.breadcrumbs = event.breadcrumbs.filter(isObject).map(scrubBreadcrumb);
  const trace = isObject(event.contexts) && isObject(event.contexts.trace) ? event.contexts.trace : undefined;
  if (trace) {
    const ids: Loose = {};
    for (const [key, length] of [['trace_id', 32], ['span_id', 16], ['parent_span_id', 16]] as const) {
      const id = trace[key];
      if (typeof id === 'string' && id.length === length && /^[\da-f]+$/i.test(id)) ids[key] = id;
    }
    if (Object.keys(ids).length) copy.contexts = { trace: ids };
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
