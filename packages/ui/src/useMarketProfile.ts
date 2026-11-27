import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { createMarketServices } from '@market/services';
import { sameIdentity, type Identity } from './checkout-state';
import { emptyProfileView, type ProfileView } from './profile-model';

type Services = ReturnType<typeof createMarketServices>;
type Session = Awaited<ReturnType<Services['auth']['session']>>;
type Snapshot = ProfileView & { identity: Identity };
const empty = (identity: Identity): Snapshot => ({ ...emptyProfileView, identity });

/**
 * The signed-in customer's profile (#45). One record per account, read when something needs it (the account drawer, Edit profile,
 * checkout) and straight after a sign-in, so the required name step can follow. Every answer is tied to the account that asked:
 * a response that arrives after sign-out or an account switch is dropped, and a new account starts empty.
 */
export function useMarketProfile(services: Services, session: Session, identity: RefObject<Identity>, identityVersion: number, authReady: boolean, customer = true) {
  const request = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => empty(identity.current));
  const latest = useRef(snapshot); latest.current = snapshot;
  const publish = (next: Snapshot) => { latest.current = next; setSnapshot(next); };
  const patch = (started: Identity, change: Partial<ProfileView>) => {
    if (!sameIdentity(started, identity.current)) return;
    const base = sameIdentity(latest.current.identity, started) ? latest.current : empty(started);
    publish({ ...base, ...change });
  };
  const load = useCallback(async (force = false) => {
    const started = identity.current, userId = started.userId;
    if (!userId || !customer || services.mode !== 'backend') return;
    const current = sameIdentity(latest.current.identity, started) ? latest.current : empty(started);
    if (!force && (current.status === 'loading' || current.status === 'ready')) return;
    const id = ++request.current;
    patch(started, { status: 'loading' });
    try {
      const profile = await services.getProfile();
      if (id !== request.current) return;
      patch(started, { status: 'ready', profile: profile ? { fullName: profile.fullName } : null });
    } catch {
      // A failed first read after sign-in means the server never confirmed "no name", so a later Retry must not pop the required step.
      if (id === request.current) patch(started, { status: 'error', fresh: false });
    }
  }, [services, identity, customer]);
  /** Reads the profile unless it is already loaded or loading. */
  const ensure = useCallback(() => load(false), [load]);
  const reload = useCallback(() => load(true), [load]);
  /** Saves the name. Throws the service's error for the screen to show. The result only updates this account's view. */
  const save = useCallback(async (fullName: string) => {
    const started = identity.current;
    ++request.current; // a read that began before this save must not bring back the old name
    try {
      const saved = await services.saveProfile({ fullName });
      patch(started, { status: 'ready', profile: { fullName: saved.fullName } });
      return saved;
    } finally {
      // The save dropped any read in flight (above); if the save failed, that read must not leave the view stuck on 'loading'. Retry is offered instead.
      if (latest.current.status === 'loading' && sameIdentity(latest.current.identity, started)) patch(started, { status: 'error' });
    }
  }, [services, identity]);
  // A sign-in during this run (not a restored session) reads the profile at once, so a missing name can be asked for before the menu.
  const previous = useRef({ ready: false, userId: null as string | null });
  useEffect(() => {
    const userId = session?.user.id ?? null, before = previous.current;
    previous.current = { ready: authReady, userId };
    if (!authReady || !customer || !userId || !before.ready || before.userId === userId) return;
    patch(identity.current, { fresh: true });
    void load(true);
  }, [session?.user.id, authReady, identityVersion, customer]);
  const current = !!session && sameIdentity(snapshot.identity, identity.current);
  const view: ProfileView = current ? snapshot : emptyProfileView;
  return { profile: { ...view, ensure, reload, save } };
}
