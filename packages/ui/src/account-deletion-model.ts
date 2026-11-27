// Copy and decisions for "Delete my account" in the customer apps (#51, slice 2b), kept free of React so tests can check them.
// The database closes the account at once and a trusted finisher removes the login later, so no text here says the account is
// "deleted" as a finished fact: it says it is being deleted.
import { classifyFailure } from './states-model.ts';

/**
 * PLACEHOLDER, FOR LAWYER REVIEW (#195, DPDP Rules 2025 rule 8(3)). How long the restaurants keep the name, number and address on past orders.
 * It must match customer_lifecycle_private.retention_settings (365 days today); changing the period is a change here and in that one setting.
 * Written to read after "for": "... for up to 1 year."
 */
export const ORDER_RECORD_RETENTION_COPY = 'up to 1 year';

export interface DeleteAccountCopy { title: string; intro: string; points: { heading: string; text: string }[]; irreversible: string; confirm: string; keep: string; busy: string }
/** The warning shown before anything is sent. Wording of the points is owner/lawyer editable text; names are the two restaurants. */
export function deleteAccountCopy(thisName: string, otherName: string): DeleteAccountCopy {
  return {
    title: 'Delete your account?',
    intro: `This removes your account from both the ${thisName} and ${otherName} apps. It can't be undone.`,
    points: [
      { heading: 'Deleted right away', text: 'Your name, saved addresses and notifications. You are signed out on every phone.' },
      { heading: 'Kept for the restaurants', text: `Your past orders stay with the restaurants, with your name, number and address, for ${ORDER_RECORD_RETENTION_COPY}. After that those details are removed.` },
      { heading: 'Active orders must finish first', text: 'If an order is still being prepared or delivered, you can delete your account once it is delivered or cancelled.' },
    ],
    irreversible: "Deleting your account can't be undone.",
    confirm: 'Delete my account',
    keep: 'Keep my account',
    busy: 'Deleting…',
  };
}
export const deleteAccountEntry = { label: 'Delete my account', hint: 'Removes it from both apps' };

export const deletedNotice = {
  title: 'Your account is being deleted',
  message: "We've closed your account and removed your name, saved addresses and notifications. Your sign-in is being removed, and you have been signed out on this phone. You don't need to do anything else.",
  signOutFailed: "We couldn't sign you out on this phone. Open the account menu and choose Log out.",
  close: 'Back to menu',
};
/** Shown instead of a generic error when a signed-in account is already being deleted (ACCOUNT_LIFECYCLE_PENDING from any call). */
export const accountPendingCopy = 'This account is being deleted, so it can no longer be changed.';

export type DeletionFailureKind = 'active-order' | 'only-owner' | 'sign-in' | 'offline' | 'retry' | 'already-pending';
export interface DeletionFailure { kind: DeletionFailureKind; title: string; message: string; /** The same request may be sent again. */ retry: boolean }
const codeOf = (error: unknown) => typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';

/** Friendly copy for each way the request can fail. Server text is never shown. `already-pending` is not an error for the person: the screen treats it as done. */
export function deletionFailure(error: unknown): DeletionFailure {
  const code = codeOf(error);
  if (code === 'ACCOUNT_HAS_ACTIVE_ORDER') return { kind: 'active-order', title: "Your order isn't finished yet", message: 'You can delete your account once your order is delivered or cancelled. Nothing has been deleted.', retry: false };
  if (code === 'ONLY_OWNER') return { kind: 'only-owner', title: 'Add another owner first', message: "This account is the only owner of a restaurant, so it can't be deleted yet. Add another owner in the owners' app, then try again. Nothing has been deleted.", retry: false };
  if (code === 'ACCOUNT_LIFECYCLE_PENDING') return { kind: 'already-pending', title: deletedNotice.title, message: deletedNotice.message, retry: false };
  if (code === 'SIGN_IN_REQUIRED' || code === 'SESSION_CHANGED') return { kind: 'sign-in', title: 'Sign in again', message: 'Your sign-in has ended. Sign in again, then delete your account. Nothing has been deleted.', retry: false };
  if (classifyFailure(error) === 'offline') return { kind: 'offline', title: "You're offline", message: 'Connect to the internet and try again. It is safe to repeat.', retry: true };
  return { kind: 'retry', title: "We couldn't delete your account", message: 'Something went wrong on our side. Please try again. It is safe to repeat.', retry: true };
}

export interface KeyStorage { removeItem(key: string): Promise<void> }
/** Removes this phone's saved data for the account. A key that cannot be removed (blocked or full storage) never stops the rest or the sign-out; the failures are returned. */
export async function clearLocalKeys(storage: KeyStorage, keys: readonly string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const key of new Set(keys)) { try { await storage.removeItem(key); } catch { failed.push(key); } }
  return failed;
}
