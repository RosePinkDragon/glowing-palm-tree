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
export function useDiscardGuard(dirty: boolean, onLeave: () => void): { requestLeave: () => void; confirm: ReactElement | null } {
  const [asking, setAsking] = useState(false);
  const dirtyRef = useRef(dirty), leaveRef = useRef(onLeave), askingRef = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const entry = useRef(false), ignorePop = useRef(false);
  dirtyRef.current = dirty; leaveRef.current = onLeave;

  const ask = useCallback(() => {
    if (askingRef.current) return;
    trigger.current = capturePanelFocus(); askingRef.current = true; setAsking(true);
  }, []);
  const requestLeave = useCallback(() => { if (dirtyRef.current) ask(); else leaveRef.current(); }, [ask]);
  const keep = useCallback(() => {
    askingRef.current = false; setAsking(false); restorePanelFocus(trigger.current);
    // A Back press already used up our history entry; add it again so the next Back asks again.
    if (Platform.OS === 'web' && dirtyRef.current && !entry.current) { window.history.pushState({ discardGuard: true }, ''); entry.current = true; }
  }, []);
  const discard = useCallback(() => { askingRef.current = false; setAsking(false); leaveRef.current(); }, []);

  // Page reload or close (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Browser Back (web): our entry exists only while dirty. Popping it asks; Discard then leaves without another Back.
  useEffect(() => {
    if (Platform.OS !== 'web' || !dirty) return;
    window.history.pushState({ discardGuard: true }, ''); entry.current = true;
    const onPop = () => {
      if (ignorePop.current) { ignorePop.current = false; return; }
      entry.current = false;
      if (dirtyRef.current) ask();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Saved (clean again) or closed: take our entry back out so the next Back behaves as before.
      if (entry.current) { entry.current = false; ignorePop.current = true; window.history.back(); }
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
  return <AccessiblePanel title={discardCopy.title} initialFocusId={keepId} onClose={onKeep}>
    <MarketText>{discardCopy.message}</MarketText>
    <MarketButton nativeID={keepId} label={discardCopy.keep} onPress={onKeep} />
    <MarketButton label={discardCopy.discard} variant="secondary" onPress={onDiscard} />
  </AccessiblePanel>;
}
