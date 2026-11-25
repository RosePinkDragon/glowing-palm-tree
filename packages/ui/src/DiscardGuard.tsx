import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { BackHandler, Platform } from 'react-native';
import { MarketButton, MarketText } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { discardCopy } from './discard-model';

const keepId = 'discard-keep-editing';

/**
 * Confirm before abandoning unsaved edits (#200). `requestLeave()` runs `onLeave` at once for a clean form and otherwise
 * asks first; render `confirm` once in the screen. While `dirty` it also covers what the app can intercept: web page
 * reload or close (`beforeunload`), the browser Back button (one history entry is added only while dirty, so a Back
 * press asks instead of leaving) and the Android hardware Back button. iOS swipe-back cannot be intercepted here;
 * each screen's own Back/close control is covered everywhere.
 */
export function useDiscardGuard(dirty: boolean, onLeave: () => void, locked = false): { requestLeave: () => void; confirm: ReactElement | null } {
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty), leaveRef = useRef(onLeave), askingRef = useRef(false), lockedRef = useRef(locked);
  const trigger = useRef<HTMLElement | null>(null);
  const entry = useRef(false), unwinding = useRef<Promise<void> | null>(null);
  dirtyRef.current = dirty; leaveRef.current = onLeave; lockedRef.current = locked;

  // While a save is in flight every leave request is ignored, like the screens' disabled close buttons.
  const ask = useCallback(() => {
    if (askingRef.current || lockedRef.current) return;
    trigger.current = capturePanelFocus(); askingRef.current = true; setAsking(true);
  }, []);
  const requestLeave = useCallback(() => { if (lockedRef.current) return; if (dirtyRef.current) ask(); else leaveRef.current(); }, [ask]);
  const keep = useCallback(() => { askingRef.current = false; setAsking(false); restorePanelFocus(trigger.current); }, []);
  const discard = useCallback(() => { askingRef.current = false; setAsking(false); leaveRef.current(); }, []);

  // Page reload or close (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Browser Back (web): our history entry exists only while dirty. A Back press pops it; we ask, and put the entry
  // back whenever the form stays (Keep editing, a second Back while asking, or a save in flight), so the next Back asks again.
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    let cancelled = false;
    const push = () => { window.history.pushState({ discardGuard: true }, ''); entry.current = true; };
    const onPop = () => {
      entry.current = false;
      if (!dirtyRef.current) return;
      if (askingRef.current || lockedRef.current) { push(); return; }
      ask(); push();
    };
    const start = () => { if (cancelled) return; push(); window.addEventListener('popstate', onPop); };
    // A previous entry may still be unwinding (clean then dirty again at once): wait for it so the two never interleave.
    if (unwinding.current) void unwinding.current.then(start); else start();
    return () => {
      cancelled = true;
      window.removeEventListener('popstate', onPop);
      // Saved (clean again) or closed: take our entry back out so the next Back behaves as before. That pop is swallowed
      // in the capture phase so other popstate listeners (account drawer, reorder) do not treat it as a user Back.
      if (entry.current && window.history.state?.discardGuard) {
        entry.current = false;
        const done = new Promise<void>(resolve => {
          const swallow = (event: Event) => { event.stopImmediatePropagation(); finish(); };
          const finish = () => { window.removeEventListener('popstate', swallow, true); clearTimeout(timer); if (unwinding.current === done) unwinding.current = null; resolve(); };
          const timer = setTimeout(finish, 1000);
          window.addEventListener('popstate', swallow, true);
        });
        unwinding.current = done; window.history.back();
      } else entry.current = false;
    };
  }, [dirty, ask]);

  // Android hardware Back.
  useEffect(() => {
    if (Platform.OS === 'web' || !dirty) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { ask(); return true; });
    return () => subscription.remove();
  }, [dirty, ask]);

  return { requestLeave, confirm: asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null };
}

/** The confirmation. Keep editing is the safe default: it takes focus first, and Escape and the Android back button also choose it. */
function DiscardConfirm({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  // The modal's own mount handling can move focus to the heading after we set it (slower machines, nested modals):
  // take it, then re-assert after a frame, 250 ms and 700 ms, but only if focus has fallen back to the heading or page.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const take = () => document.getElementById(keepId)?.focus();
    const strayed = () => { const active = document.activeElement; return !active || active === document.body || active.getAttribute('role') === 'heading'; };
    take();
    const frame = requestAnimationFrame(() => { if (strayed()) take(); });
    const later = [250, 700].map(delay => setTimeout(() => { if (strayed()) take(); }, delay));
    return () => { cancelAnimationFrame(frame); later.forEach(clearTimeout); };
  }, []);
  return <AccessiblePanel title={discardCopy.title} initialFocusId={keepId} onClose={onKeep}>
    <MarketText>{discardCopy.message}</MarketText>
    <MarketButton nativeID={keepId} label={discardCopy.keep} onPress={onKeep} />
    <MarketButton label={discardCopy.discard} variant="secondary" onPress={onDiscard} />
  </AccessiblePanel>;
}
