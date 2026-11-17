import { ServiceError } from '@market/services';

// Pure model for the owners' "Your name" section (#53). The server constraint (membership_display_name_valid,
// surfaced as INVALID_OWNER_NAME) is the source of truth; this only trims, rejects empty and over-long text early.
export const OWNER_NAME_MAX = 60;
export type NameCheck = { ok: true; name: string } | { ok: false; message: string };
export type SaveProblem = { kind: 'invalid' | 'denied' | 'reload' | 'failed'; message: string };

/** Light client check: trim surrounding spaces, then refuse empty or over 60 characters (code points, as the server counts). */
export function checkOwnerName(raw: string): NameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, message: 'Enter your name.' };
  if ([...name].length > OWNER_NAME_MAX) return { ok: false, message: `Use ${OWNER_NAME_MAX} characters or fewer.` };
  return { ok: true, name };
}

/** Whether Save has something to save: the trimmed text differs from the name already stored. */
export function ownerNameChanged(raw: string, saved: string | null): boolean {
  return raw.trim() !== (saved ?? '');
}

/** Map a service failure to what the owner sees. Only the services' own INVALID_OWNER_NAME copy is shown; anything unknown gets fixed retry text, never a raw error message. */
export function ownerNameProblem(error: unknown): SaveProblem {
  const code = error instanceof ServiceError ? error.code : '';
  if (code === 'INVALID_OWNER_NAME') return { kind: 'invalid', message: error instanceof Error && error.message ? error.message : 'Enter a name of 1 to 60 characters.' };
  if (code === 'ADMIN_REQUIRED') return { kind: 'denied', message: 'You no longer have access to change your name. Sign in again.' };
  if (code === 'SESSION_CHANGED') return { kind: 'reload', message: 'Your account changed. Reload the app, then try again.' };
  return { kind: 'failed', message: 'Could not save your name. Check your connection and try again.' };
}

/** Access and account-change failures lock Save until the app is reloaded; typing must not clear them. */
export const isSaveLock = (problem: SaveProblem | null): boolean => problem?.kind === 'denied' || problem?.kind === 'reload';
