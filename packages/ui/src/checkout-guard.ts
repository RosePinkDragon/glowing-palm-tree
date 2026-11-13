import type { BusinessSlug } from '@market/core';
import { attemptKey, readAttempt, type CheckoutAttempt } from './checkout-state.ts';

type Locks = { request<T>(name: string, options: { ifAvailable: true }, callback: (lock: object | null) => Promise<T>): Promise<T> };
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
const nativeLocks = new Set<string>();

/** Never queue an old checkout action behind a previous one. */
export async function withCheckoutGuard<T>(businessId: BusinessSlug, web: boolean, work: () => Promise<T>, providedLocks?: Locks): Promise<T> {
  const key = attemptKey(businessId);
  if (web) {
    const locks = providedLocks ?? (typeof navigator !== 'undefined' ? navigator.locks as unknown as Locks : undefined);
    if (!locks) throw new Error('Safe checkout is unavailable in this browser. Please use a browser that supports secure checkout.');
    return locks.request(key, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Another window is checking an order. Please wait and try again.');
      return work();
    });
  }
  if (nativeLocks.has(key)) throw new Error('Another order is being checked. Please wait and try again.');
  nativeLocks.add(key);
  try { return await work(); } finally { nativeLocks.delete(key); }
}

/** Call only while holding the guard; existing attempts must never be overwritten. */
export async function prepareAttempt(storage: Storage, businessId: BusinessSlug, create: () => CheckoutAttempt) {
  const existing = readAttempt(await storage.getItem(attemptKey(businessId)), businessId);
  if (existing) return { attempt: existing, existing: true };
  const attempt = create();
  await storage.setItem(attemptKey(businessId), JSON.stringify(attempt));
  return { attempt, existing: false };
}
