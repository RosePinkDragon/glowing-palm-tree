import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type MenuItem } from '@market/core';
import { AccessiblePanel } from './AccessiblePanel';
import { DishPhoto } from './DishPhoto';
import { DietMark } from './DietMark';
import { MarketButton, MarketStatus, MarketText } from './components';
import { featuredLabel } from './menu-model';
import { useMarketTheme } from './theme';

export function DishDetails({ item, inCart, locked, onAdd, onClose }: {
  item: MenuItem; inCart: number; locked: boolean; onAdd: (quantity: number) => Promise<void>; onClose: () => void;
}) {
  const { colors, businessId } = useMarketTheme();
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const adding = useRef(false);
  const remaining = 10 - inCart;
  const add = async () => {
    if (adding.current || locked || !item.isAvailable || quantity > remaining) return;
    adding.current = true; setBusy(true); setError('');
    try { await onAdd(quantity); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Your cart could not be saved. Please try again.'); }
    finally { adding.current = false; setBusy(false); }
  };
  const step = (direction: -1 | 1) => <Pressable accessibilityRole="button" accessibilityLabel={direction < 0 ? 'Decrease quantity' : 'Increase quantity'}
    disabled={busy || locked || (direction < 0 ? quantity <= 1 : quantity >= remaining)}
    accessibilityState={{ disabled: busy || locked || (direction < 0 ? quantity <= 1 : quantity >= remaining) }}
    onPress={() => setQuantity(value => value + direction)}
    style={{ minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.inputBorder, opacity: busy || locked || (direction < 0 ? quantity <= 1 : quantity >= remaining) ? 0.5 : 1 }}><Text style={{ color: colors.primary, fontSize: 24 }}>{direction < 0 ? '−' : '+'}</Text></Pressable>;
  return <AccessiblePanel title={item.name} onClose={() => { if (!busy) onClose(); }}>
    <DishPhoto key={item.imageUrl ?? 'placeholder'} item={item} detail />
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}><DietMark diet={item.diet} />{item.isFeatured ? <MarketText variant="eyebrow">{featuredLabel(businessId, 'customer')}</MarketText> : null}</View>
    <MarketText variant="eyebrow">{item.category}{item.isDemo ? ' · Example' : ''}</MarketText>
    <MarketText variant="heading">{formatINRFromPaise(item.pricePaise)}</MarketText>
    <MarketText>{item.description || 'No description provided.'}</MarketText>
    {item.isAvailable ? <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>{step(-1)}<Text accessibilityLabel={`Quantity: ${quantity}`} accessibilityLiveRegion="polite" style={{ fontSize: 18, color: colors.ink, fontWeight: '700' }}>{quantity}</Text>{step(1)}</View>
      {inCart ? <MarketText variant="muted">{inCart} already in your cart. {remaining > 0 ? `You can add up to ${remaining} more.` : 'You have reached the limit of 10 for this dish.'}</MarketText> : null}
      {quantity > remaining && remaining > 0 ? <MarketText>Your cart changed. Reduce the quantity before adding.</MarketText> : null}
      {locked ? <MarketText variant="muted">Your cart is paused. Finish recovery or retry your saved cart before adding dishes.</MarketText> : null}
      <MarketButton label={busy ? 'Adding…' : `Add · ${formatINRFromPaise(item.pricePaise * quantity)}`} disabled={busy || locked || quantity > remaining} onPress={() => void add()} />
    </> : <MarketText>Currently unavailable</MarketText>}
    {error ? <MarketStatus kind="error" title="Could not add this dish" message={error} /> : null}
    <MarketButton label="Close dish details" variant="secondary" disabled={busy} onPress={onClose} />
  </AccessiblePanel>;
}
