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

/** The remembered own name, kept on this device per signed-in account until the shared profile exists (#45). */
// Trade-off (#187): this key is not cleared on sign-out. It is per user, so the same person gets their name back; another account never reads it.
export const ownNameKey = (userId: string) => `market:own-name:${encodeURIComponent(userId)}`;
/** A stored value as a name, or null when it is missing, unreadable or not a usable name. */
export function parseOwnName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { name?: unknown } | null;
    const name = value && typeof value === 'object' && typeof value.name === 'string' ? value.name.trim() : '';
    return name && name.length <= 120 ? name : null;
  } catch { return null; }
}
export const serializeOwnName = (name: string) => JSON.stringify({ name: name.trim() });
