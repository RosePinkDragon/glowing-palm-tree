import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatINRFromPaise, type BusinessSlug, type MenuItem, type Order } from '@market/core';
import { AccessiblePanel } from './AccessiblePanel';
import { MarketButton, MarketStatus, MarketText } from './components';
import { cartKey, CartReviewRequiredError, prepareReorder, readCart } from './cart-state';
import { attemptKey, readAttempt, sameIdentity } from './checkout-state';
import { withCheckoutGuard } from './checkout-guard';
import type { useCustomerCart } from './useCustomerCart';
import { messageOf, type useMarket } from './useMarket';
import { useMarketTheme } from './theme';

export function ReorderNotice({ message }: { message: string }) {
  const node = useRef<ComponentRef<typeof Text>>(null);
  const { colors } = useMarketTheme();
  useEffect(() => {
    let frame: number;
    const focus = () => {
      if (Platform.OS === 'web') {
        const element = node.current as unknown as HTMLElement | null;
        if (element && (element.closest('[aria-hidden="true"]') || document.querySelector('[aria-modal="true"]'))) { frame = requestAnimationFrame(focus); return; }
        element?.focus();
      } else { const handle = findNodeHandle(node.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [message]);
  return <Text ref={node} role="status" accessibilityLiveRegion="polite" {...({ tabIndex: -1 } as object)} style={{ fontSize: 16, lineHeight: 25, color: colors.ink }}>{message}</Text>;
}

type Review = ReturnType<typeof prepareReorder> & { menu: MenuItem[]; revision: number; existing: boolean };
export function ReorderPanel({ businessId, order, market, draft, paused, onClose, onSaved }: {
  businessId: BusinessSlug; order: Order; market: ReturnType<typeof useMarket>; draft: ReturnType<typeof useCustomerCart>;
  paused: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const identity = useRef(market.identity.current);
  const live = useRef({ market, draft, paused }); live.current = { market, draft, paused };
  const active = useRef(true), operation = useRef(0), saving = useRef(false);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState('');
  const check = (ownSave = false) => {
    const now = live.current;
    if (!active.current || !sameIdentity(identity.current, now.market.identity.current) || !now.market.authReady || !identity.current.userId) throw new Error('Your account changed. Nothing was added by this reorder.');
    if (now.market.attempt || !now.market.attemptReady || now.market.storageError) throw new Error('Recover your order awaiting confirmation before reordering. Your saved order has not been changed.');
    if (now.paused || !now.draft.ready || now.draft.cartError || (!ownSave && now.draft.saving)) throw new Error('Wait for your saved cart to be ready, or retry it before reordering.');
    if (now.market.services.mode === 'demo' || now.market.business?.isDemo) throw new Error('Reordering is unavailable for sample menus.');
  };
  // This guard also covers the locked cart mutation, so checkout cannot freeze a
  // submitted snapshot between the persisted-attempt check and the draft write.
  const guarded = <T,>(work: () => Promise<T>) => withCheckoutGuard(businessId, Platform.OS === 'web', async () => {
    check();
    const attempt = readAttempt(await AsyncStorage.getItem(attemptKey(businessId)), businessId);
    check();
    if (attempt) { live.current.market.setAttempt(attempt); throw new Error('Recover your order awaiting confirmation before reordering. Your saved order has not been changed.'); }
    return work();
  });
  const save = async (value: Review, mode: 'add' | 'replace', onlyIfEmpty = false) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      await guarded(() => live.current.draft.importLines(value.lines, mode, { menu: value.menu, expectedRevision: value.revision, onlyIfEmpty, validate: () => check(true) }));
      if (!active.current || !sameIdentity(identity.current, live.current.market.identity.current)) return;
      const skipped = value.skipped.length ? ` Skipped unavailable dishes: ${value.skipped.join(', ')}.` : '';
      onSaved(`Reorder ${mode === 'replace' ? 'replaced your cart' : 'added to your cart'} at current menu prices.${skipped} Review your cart before placing an order.`);
    } catch (e) {
      if (!active.current || !sameIdentity(identity.current, live.current.market.identity.current)) return;
      if (e instanceof CartReviewRequiredError) setStale(true);
      setError(`${messageOf(e)} Nothing was changed by this reorder.`);
    } finally { saving.current = false; if (active.current) setBusy(false); }
  };
  const load = async () => {
    if (saving.current) return;
    const started = ++operation.current;
    setLoading(true); setStale(false); setReview(null); setError('');
    try {
      check();
      const menu = await live.current.market.services.getMenu();
      check();
      if (started !== operation.current) return;
      const prepared = prepareReorder(order, menu, businessId);
      const value = await guarded(async () => {
        const saved = readCart(await AsyncStorage.getItem(cartKey(businessId)), businessId);
        check();
        if (saved && saved.ownerId !== identity.current.userId) throw new Error('Your account changed in another window. Refresh the page before reordering.');
        return { ...prepared, menu, revision: saved?.revision ?? 0, existing: !!saved?.lines.length };
      });
      if (started !== operation.current || !active.current) return;
      setReview(value); setLoading(false);
      if (value.lines.length && !value.existing) await save(value, 'add', true);
    } catch (e) {
      if (started === operation.current && active.current) { setError(`${messageOf(e)} Nothing was changed by this reorder.`); setLoading(false); }
    }
  };
  useEffect(() => {
    active.current = true; void load();
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== cartKey(businessId)) return;
      if (!saving.current) { operation.current++; setLoading(false); setStale(true); setError('Your cart changed in another window. Review it again before choosing Add or Replace. Nothing was changed by this reorder.'); }
    };
    const back = () => { if (!saving.current) { active.current = false; onClose(); } };
    if (Platform.OS === 'web') { window.addEventListener('storage', changed); window.addEventListener('popstate', back); }
    return () => { active.current = false; operation.current++; if (Platform.OS === 'web') { window.removeEventListener('storage', changed); window.removeEventListener('popstate', back); } };
  }, [businessId, order.id]);
  const cancel = () => { if (!saving.current) { active.current = false; operation.current++; onClose(); } };
  return <AccessiblePanel title="Reorder" onClose={cancel}>
    {loading ? <MarketStatus kind="loading" title="Checking the current menu" message="Checking today’s prices and availability before changing your cart." /> : null}
    {review && !stale ? <>
      {review.skipped.length ? <MarketText>Skipped unavailable dishes: {review.skipped.join(', ')}.</MarketText> : null}
      {!review.lines.length ? <MarketStatus kind="empty" title="No dishes available to reorder" message="These dishes are missing from the current menu or unavailable. Your cart has not been changed." /> : <>
        <MarketText variant="muted">Current menu prices · Original quantities</MarketText>
        {review.lines.map(line => <MarketText key={line.item.id}>{line.quantity} × {line.item.name} · {formatINRFromPaise(line.item.pricePaise * line.quantity)}</MarketText>)}
        {review.existing ? <MarketText>Your cart already has dishes. Add these dishes to it, or replace all its dishes with this reorder. Replacing removes everything currently in your cart.</MarketText> : null}
        <View style={{ gap: 10 }}>
          <MarketButton label={busy ? 'Saving reorder…' : 'Add to cart'} disabled={busy || loading} onPress={() => void save(review, 'add', !review.existing)} />
          {review.existing ? <MarketButton label="Replace cart" variant="secondary" disabled={busy || loading} onPress={() => void save(review, 'replace')} /> : null}
        </View>
      </>}
    </> : null}
    {error ? <MarketStatus kind="error" title="Reorder not saved" message={error} /> : null}
    {!loading && !busy && (stale || !review) ? <MarketButton label={stale ? 'Review current cart' : 'Retry reorder'} variant="secondary" onPress={() => void load()} /> : null}
    {live.current.market.attempt ? <MarketButton label="Go to order recovery" variant="secondary" disabled={busy} onPress={() => { cancel(); onSaved('Recover your earlier order before reordering.'); }} /> : null}
    <MarketButton label="Cancel" variant="secondary" disabled={busy} onPress={cancel} />
  </AccessiblePanel>;
}
