import { useCallback, useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { OpeningHours } from '@market/core';
import { hoursSignature, hoursState, msUntilBoundary, refusalMs, type HoursState } from './hours-model';

/**
 * Is the restaurant within its opening hours right now (#253)? The answer is always computed from the clock (isOpenNow) at render time, so it
 * can never stick: a timer set to the next opening or closing instant (not a poll), and a fresh look whenever the app is shown again, re-render it.
 * `refuse` records the server's "outside hours" refusal (the device clock may be off); it holds for those same hours for a short while, then the
 * clock decides again, so reloading the restaurant cannot clear it into a retry loop, and a wrong clock cannot block ordering for the whole day.
 */
export function useOpeningHours(business: { openingHours?: OpeningHours | null } | null | undefined): HoursState & { refuse: (label: string | null) => void } {
  const [, setTick] = useState(0);
  const [refusal, setRefusal] = useState<{ signature: string; at: number; label: string | null } | null>(null);
  const signature = hoursSignature(business);
  const now = Date.now();
  const live = refusal && refusal.signature === signature && now - refusal.at >= 0 && now - refusal.at < refusalMs ? refusal : null;
  const hours = business?.openingHours ?? null, opens = hours?.opensAt, closes = hours?.closesAt;
  useEffect(() => {
    const wait = [msUntilBoundary(opens && closes ? { openingHours: { opensAt: opens, closesAt: closes } } : null, Date.now()), live ? Math.max(refusal!.at + refusalMs - Date.now(), 250) : null].filter((value): value is number => value !== null);
    if (!wait.length) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.min(...wait));
    return () => clearTimeout(timer);
  });
  useEffect(() => {
    const look = () => setTick(value => value + 1);
    if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof window !== 'undefined') {
      const visible = () => { if (!document.hidden) look(); };
      document.addEventListener('visibilitychange', visible); window.addEventListener('focus', look);
      return () => { document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', look); };
    }
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') look(); });
    return () => subscription.remove();
  }, []);
  const refuse = useCallback((label: string | null) => setRefusal({ signature, at: Date.now(), label }), [signature]);
  return { ...hoursState(business, now, live), refuse };
}
