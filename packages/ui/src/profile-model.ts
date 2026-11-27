// Decisions and copy for the customer profile (#45), kept free of React so tests can check them. The profile is one record per
// account, shared by both restaurant apps; the verified phone is never part of it (it comes from sign-in).
import { FULL_NAME_MESSAGE, normalizeFullName } from '@market/core';
import { accountPendingCopy } from './account-deletion-model.ts';
import { mobileFieldValue } from './recipient-model.ts';

export type ProfileStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface ProfileView {
  status: ProfileStatus;
  /** The saved profile; null with status `ready` means the account has no name yet. */
  profile: { fullName: string } | null;
  /** The account signed in during this run, so the name step may be shown (a cold start never interrupts with it). */
  fresh: boolean;
}
export const emptyProfileView: ProfileView = { status: 'idle', profile: null, fresh: false };

/** Required name step: only right after sign-in, only once the server has said there is no name, never on a failed read. */
export const needsNameStep = (view: ProfileView) => view.fresh && view.status === 'ready' && view.profile === null;

export type ProfileFailure = 'name' | 'sign-in' | 'retry';
/** Friendly copy for a failed profile read or save. Never echoes server text; `focus` says where the customer should look. */
export function profileFailure(error: unknown): { message: string; kind: ProfileFailure } {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
  if (code === 'PROFILE_INVALID_NAME') return { message: FULL_NAME_MESSAGE, kind: 'name' };
  if (code === 'SIGN_IN_REQUIRED') return { message: 'Your sign-in has ended. Sign in again, then save your name.', kind: 'sign-in' };
  if (code === 'ACCOUNT_LIFECYCLE_PENDING') return { message: accountPendingCopy, kind: 'retry' };
  if (code === 'SESSION_CHANGED') return { message: 'Your account changed. Check your details and try again.', kind: 'retry' };
  if (code === 'DEMO_MODE' || code === 'CUSTOMER_REQUIRED') return { message: 'Your profile is not available in this app.', kind: 'retry' };
  return { message: 'Could not reach your profile. Check your connection and try again.', kind: 'retry' };
}

/** Field validation shared by the Edit profile screen and the name step: the same trimmed 1 to 120 rule as the service and database. */
export function validateProfileName(value: string): { name: string; error: string } {
  const { name, valid } = normalizeFullName(value);
  return { name, error: valid ? '' : FULL_NAME_MESSAGE };
}

/** Up to two initials for the avatar ring, one per word, as the drawer has always shown. */
export const initialsOf = (fullName: string) => fullName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();

/** The verified number as the design shows it ("+91 98765 43210"), or the stored text when it is not an Indian mobile. */
export function verifiedPhoneDisplay(phone: string | null | undefined): string {
  const local = mobileFieldValue(phone);
  if (local) return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
  return phone?.trim() ?? '';
}
