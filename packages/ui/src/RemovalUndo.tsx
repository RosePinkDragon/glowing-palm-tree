import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { chipTarget, useFamilies } from './DishAction';
import type { Removal } from './removal-model';
import { useMarketTheme } from './theme';

/** How long Undo stays: long enough to notice and reach it, and it never expires under keyboard focus. */
export const UNDO_MS = 8000;
/**
 * The last removed dish, offered for Undo until the timer ends, another removal replaces it, or `scope` changes
 * (a different restaurant, account or a placed order never gets a dish back). Paused while the notice has focus.
 */
export function useRemovalUndo(scope: string) {
  const [state, setState] = useState<{ removal: Removal; scope: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [paused, setPaused] = useState(false);
  const pending = state && state.scope === scope ? state.removal : null;
  // The same sentence twice in a row is not re-announced, so each one alternates a trailing no-break space.
  const say = useCallback((text: string) => setAnnouncement(previous => text + (previous.endsWith('\u00a0') ? '' : '\u00a0')), []);
  const dismiss = useCallback(() => { setState(null); setPaused(false); setAnnouncement(''); }, []);
  useEffect(() => {
    if (!announcement || pending) return;
    const timer = setTimeout(() => setAnnouncement(''), 5000); // a confirmation does not linger for the next removal
    return () => clearTimeout(timer);
  }, [announcement, pending]);
  useEffect(() => { if (state && state.scope !== scope) dismiss(); }, [state, scope, dismiss]);
  useEffect(() => {
    if (!pending || paused) return;
    const timer = setTimeout(dismiss, UNDO_MS);
    return () => clearTimeout(timer);
  }, [pending, paused, dismiss]);
  const offer = useCallback((removal: Removal) => { setState({ removal, scope }); say(`Removed ${removal.line.item.name} from your cart. Undo is available.`); }, [scope, say]);
  return { pending, offer, dismiss, announce: say, announcement, setPaused };
}

/** Polite live region, always mounted so the announcement is heard wherever the visible notice appears. */
export function RemovalAnnouncer({ text }: { text: string }) {
  return <View role="status" accessibilityLiveRegion="polite" aria-atomic style={{ position: 'absolute', width: 1, height: 1, margin: -1, overflow: 'hidden', pointerEvents: 'none' }}>{text ? <Text>{text}</Text> : null}</View>;
}

/** "Removed [dish]" with an Undo button. Inline, so it never sits over the checkout button. */
export function RemovalUndoBar({ removal, disabled, onUndo, onPause }: { removal: Removal; disabled: boolean; onUndo: () => void; onPause: (paused: boolean) => void }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const name = removal.line.item.name;
  return <View onFocus={() => onPause(true)} onBlur={() => onPause(false)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }}>
    <Text style={{ flex: 1, paddingVertical: 8, color: colors.ink, ...f.semi(14, 20) }}>Removed {name}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Undo removing ${name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={onUndo}
      style={({ pressed }) => ({ minHeight: chipTarget, minWidth: chipTarget, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}>
      <Text accessible={false} style={{ color: colors.primary, ...f.semi(15, 22) }}>Undo</Text>
    </Pressable>
  </View>;
}

/** After Undo the notice (and the focus on it) is gone: put focus on the restored dish's stepper, or a stable control if it is not on screen yet. */
export function focusRestored(name: string) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const shown = (node: Element) => !node.closest('[aria-hidden="true"]') && node.getClientRects().length > 0 && !(node as HTMLElement).hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true';
  const find = (match: (label: string) => boolean) => [...document.querySelectorAll<HTMLElement>('[aria-label]')].find(node => match(node.getAttribute('aria-label') ?? '') && shown(node));
  let tries = 0;
  const attempt = () => {
    const target = find(label => label === `Add one ${name}`) ?? find(label => label === `Remove one ${name}`) ?? (tries >= 20 ? find(label => /^Cart\b/.test(label)) : undefined);
    if (target) target.focus();
    else if (tries++ < 20) setTimeout(attempt, 50);
  };
  attempt();
}
