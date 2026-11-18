import type { BusinessSlug } from '@market/core';

// #52 customer "Leave [restaurant]": pure rules, free of React so they can be unit tested.
export interface LeaveLink { businessSlug: BusinessSlug; businessName: string; generation: string; state: 'active' | 'leave_pending' | 'left' }
export interface LeaveStorage { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
export interface LeaveReceiptLike { state: string; generation: string; requestId: string; localCleanup: { businessSlug: BusinessSlug; generation: string; requestId: string } }

/** Leave is offered only for an active link here while another restaurant is also active. */
export function leaveTarget(links: readonly LeaveLink[] | null, slug: BusinessSlug): { generation: string; otherName: string } | null {
  const here = links?.find(link => link.businessSlug === slug);
  const other = links?.find(link => link.businessSlug !== slug && link.state === 'active');
  return here && here.state === 'active' && other ? { generation: here.generation, otherName: other.businessName } : null;
}

export function leaveRequestKey(slug: BusinessSlug, userId: string) { return `market:leave:${slug}:${encodeURIComponent(userId)}`; }

/** The request ID survives a lost response or app restart; a new relationship generation gets a new ID. */
export async function ensureLeaveRequest(storage: LeaveStorage, slug: BusinessSlug, userId: string, generation: string, newId: () => string): Promise<string> {
  const key = leaveRequestKey(slug, userId);
  try {
    const saved = JSON.parse(await storage.getItem(key) ?? 'null');
    if (saved && saved.version === 1 && saved.generation === generation && typeof saved.requestId === 'string' && saved.requestId) return saved.requestId;
  } catch { /* A corrupt record is replaced; the server idempotency only matters for a request it saw. */ }
  const requestId = newId();
  await storage.setItem(key, JSON.stringify({ version: 1, requestId, generation }));
  return requestId;
}
export const clearLeaveRequest = (storage: LeaveStorage, slug: BusinessSlug, userId: string) => storage.removeItem(leaveRequestKey(slug, userId));

/**
 * A receipt only authorizes wiping this phone when it belongs to the exact request and generation
 * we sent and the server still shows that generation as left. A replayed receipt after a rejoin
 * says `left` too, so the fresh read decides.
 */
export function cleanupDecision(receipt: LeaveReceiptLike, sent: { slug: BusinessSlug; generation: string; requestId: string }, current: LeaveLink | undefined): 'clean' | 'superseded' | 'invalid' {
  if (receipt.state !== 'left' || receipt.generation !== sent.generation || receipt.requestId !== sent.requestId ||
      receipt.localCleanup.businessSlug !== sent.slug || receipt.localCleanup.generation !== sent.generation || receipt.localCleanup.requestId !== sent.requestId) return 'invalid';
  if (current && current.state === 'left' && current.generation === sent.generation) return 'clean';
  return current && current.generation !== sent.generation ? 'superseded' : 'invalid';
}

export interface LeaveFailure { message: string; /** A retry may reuse the same request ID. */ retry: boolean; /** Reload the relationship list. */ refresh: boolean; signIn: boolean }
export const leaveRetryCopy = 'We could not finish leaving just now. Check your connection and try again.';
export function leaveFailure(error: unknown, name: string): LeaveFailure {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const done = (message: string, flags: Partial<LeaveFailure> = {}): LeaveFailure => ({ message, retry: false, refresh: false, signIn: false, ...flags });
  if (code === 'ACTIVE_ORDERS') return done(`You have an order with ${name} that is not delivered or cancelled yet. You can leave once it is.`);
  if (code === 'LAST_BUSINESS') return done(`${name} is the only restaurant on your account, so it can't be left. An account has to stay with at least one restaurant.`);
  if (code === 'BUSINESS_LIFECYCLE_PENDING' || code === 'ACCOUNT_LIFECYCLE_PENDING') return done('Your account is being updated. Try again shortly.', { retry: true });
  if (code === 'STALE_RELATIONSHIP' || code === 'LEAVE_REQUEST_CONFLICT') return done(`Your restaurants changed since this screen loaded. Check them and try again.`, { refresh: true });
  if (code === 'SIGN_IN_REQUIRED' || code === 'SESSION_CHANGED') return done('Sign in again to continue.', { signIn: true });
  return done(leaveRetryCopy, { retry: true });
}
/** Refusals that a retry cannot change: drop the stored request ID so a later attempt is fresh. */
export const leaveRequestIsFinal = (error: unknown) => ['ACTIVE_ORDERS', 'LAST_BUSINESS', 'STALE_RELATIONSHIP', 'LEAVE_REQUEST_CONFLICT'].includes(error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '');

export const leaveEffects = (name: string, otherName: string) => [
  `You'll stop getting updates and notifications from ${name} on this phone.`,
  'Your saved cart here is cleared.',
  'Your past orders and saved addresses stay.',
  `You'll be signed out of this app only. Your account stays for the ${otherName} app.`,
];

/** Checkout of a customer who left: rejoin once, then ask them to place the order again. */
export function checkoutLifecycleCopy(kind: 'join-required' | 'pending', name: string, rejoined?: boolean): string {
  if (kind === 'pending') return 'Your account is being updated. Try placing your order again shortly.';
  return rejoined ? `You're back at ${name}. Your order has not been placed yet. Check it and place it again.` : `We could not rejoin ${name} just now. Check your connection and place your order again to retry.`;
}
