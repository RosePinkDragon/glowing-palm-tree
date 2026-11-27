import { normalizeFullName } from '@market/core';

// Who an order is for (#187): the account holder ("Me") or "Someone else". Pure state transitions, so the rules are unit-tested
// without React. The hook in useCustomerCart owns the identity guards; this file owns what the fields hold.

export interface Contact { name: string; phone: string }
export type RecipientMode = 'me' | 'other';
export const emptyContact: Contact = { name: '', phone: '' };

export interface RecipientState {
  mode: RecipientMode;
  /** The account holder's details. Prefilled, never touched by the recipient's. */
  own: Contact;
  /** The other person's details. Empty by default, never stored, never copied into `own`. */
  other: Contact;
  /** Own fields the customer (or a restored order attempt) has set, even to empty: a late prefill must not overwrite them. */
  typed: { name: boolean; phone: boolean };
}
export const emptyRecipient: RecipientState = { mode: 'me', own: emptyContact, other: emptyContact, typed: { name: false, phone: false } };

/**
 * A phone number as the Mobile field shows it: ten digits, no +91. Accepts what the field accepts (spaces, +91) and the way
 * Supabase stores a verified phone (91 and ten digits, no plus). Anything that is not a valid Indian mobile gives ''.
 */
export function mobileFieldValue(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/[\s+()-]/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(local) ? local : '';
}

/** What an order is sent with: the active person's details. */
export const activeContact = (state: RecipientState): Contact => state.mode === 'me' ? state.own : state.other;

/** Edit the fields of whoever is selected. Own fields that change are marked typed. */
export function editActive(state: RecipientState, next: Contact): RecipientState {
  if (state.mode === 'other') return { ...state, other: next };
  return { ...state, own: next, typed: { name: state.typed.name || next.name !== state.own.name, phone: state.typed.phone || next.phone !== state.own.phone } };
}

/** Switching never changes either person's details, so switching back shows the account holder's again. */
export const chooseMode = (state: RecipientState, mode: RecipientMode): RecipientState => state.mode === mode ? state : { ...state, mode };

/** Fill the account holder's untouched fields: the remembered own name and the verified login phone. The recipient's fields are never filled. */
export function prefillOwn(state: RecipientState, rememberedName: string | null, verifiedPhone: string | null | undefined): RecipientState {
  const name = !state.typed.name && rememberedName ? rememberedName : state.own.name;
  const phone = !state.typed.phone && mobileFieldValue(verifiedPhone) ? mobileFieldValue(verifiedPhone) : state.own.phone;
  return name === state.own.name && phone === state.own.phone ? state : { ...state, own: { name, phone } };
}

/**
 * Show a saved order attempt's delivery details again (a declined order, or editing a revised quote). Those are exactly what was
 * sent: if they are the account holder's, "Me" shows them; otherwise "Someone else" does, and the account holder's own details are left alone.
 */
// Trade-off (#187): with a matching phone and no own name known yet, details restore as "Me" even if they were for someone else who shares
// that number. What was sent is shown unchanged; only the label can differ.
export function restoreDelivery(state: RecipientState, delivery: Contact): RecipientState {
  const shown = { name: delivery.name, phone: mobileFieldValue(delivery.phone) || delivery.phone };
  const isOwn = shown.phone === state.own.phone && (!state.own.name || shown.name === state.own.name);
  if (isOwn) return { ...state, mode: 'me', own: shown, typed: { name: true, phone: true } };
  return { ...state, mode: 'other', other: shown };
}

/**
 * The key an older version used to remember the customer's own name on this device. Nothing writes it any more (#45): the shared
 * profile replaced it. It is only read to move that name into the profile (see planOwnName), and removed once it is no longer needed.
 */
export const ownNameKey = (userId: string) => `market:own-name:${encodeURIComponent(userId)}`;
/** A stored value as a name, or null when it is missing, unreadable or not a usable name (trimmed, 1 to 120 characters). */
export function parseOwnName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { name?: unknown } | null;
    const { name, valid } = normalizeFullName(value && typeof value === 'object' ? value.name : '');
    return valid ? name : null;
  } catch { return null; }
}

/** What the profile read said. `ready` with `name: null` is the server confirming there is no name; `idle`, `loading` and `error` confirm nothing. */
export interface ProfileRead { status: 'idle' | 'loading' | 'ready' | 'error'; name: string | null }

/**
 * Where the "Me" name comes from, and what to do with the old device key (#45). The profile wins; the device key is only ever used
 * when the server CONFIRMED there is no name (an unavailable or failing read never counts, so nothing is guessed or migrated then).
 *  - profile has a name: prefill it; the old key is obsolete, remove it.
 *  - confirmed none, usable old name: prefill it and keep the key until the name is saved to the profile (after a successful order).
 *  - confirmed none, key present but unusable: nothing to migrate, remove it.
 *  - anything else (not read yet, loading, error): no name, leave the key alone.
 * `stored` is the raw key value, or null when absent.
 */
export function planOwnName(read: ProfileRead, stored: string | null): { prefill: string | null; removeKey: boolean } {
  if (read.status !== 'ready') return { prefill: null, removeKey: false };
  if (read.name) return { prefill: read.name, removeKey: stored !== null };
  const legacy = parseOwnName(stored);
  return { prefill: legacy, removeKey: stored !== null && legacy === null };
}

/**
 * After a successful order: the name to save to the profile, or null. Only an order placed as "Me", only when the profile read
 * CONFIRMED no name (never when unavailable, so a failed read cannot overwrite a name that exists), and only a usable name.
 * The order is already placed, so this is best effort and nothing about it may reach the customer.
 */
export function nameToSaveAfterOrder(asMe: boolean, read: ProfileRead, orderedName: string): string | null {
  if (!asMe || read.status !== 'ready' || read.name) return null;
  const { name, valid } = normalizeFullName(orderedName);
  return valid ? name : null;
}
