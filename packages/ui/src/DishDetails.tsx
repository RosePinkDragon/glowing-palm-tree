import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, MAX_QUANTITY, type MenuItem } from '@market/core';
import { AccessiblePanel } from './AccessiblePanel';
import { DishPhoto } from './DishPhoto';
import { DietMark } from './DietMark';
import { MarketStatus, MarketText } from './components';
import { chipTarget, useFamilies } from './DishAction';
import { MarketIcon } from './MarketIcons';
import { featuredLabel } from './menu-model';
import { useMarketTheme } from './theme';

export function DishDetails({ item, inCart, locked, onAdd, onClose, orderingAllowed, orderingMessage }: {
  item: MenuItem; inCart: number; locked: boolean; onAdd: (quantity: number) => Promise<void>; onClose: () => void; orderingAllowed: boolean; orderingMessage: string;
}) {
  const { colors, businessId, menuLayout } = useMarketTheme();
  const f = useFamilies();
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const adding = useRef(false);
  const remaining = MAX_QUANTITY - inCart;
  const add = async () => {
    if (adding.current || locked || !orderingAllowed || !item.isAvailable || quantity > remaining) return;
    adding.current = true; setBusy(true); setError('');
    try { await onAdd(quantity); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Your cart could not be saved. Please try again.'); }
    finally { adding.current = false; setBusy(false); }
  };
  const stepOff = (direction: -1 | 1) => busy || locked || (direction < 0 ? quantity <= 1 : quantity >= remaining);
  const edge = menuLayout === 'carta' ? colors.primary : colors.inputBorder;
  const step = (direction: -1 | 1) => <Pressable accessibilityRole="button" accessibilityLabel={direction < 0 ? 'Decrease quantity' : 'Increase quantity'}
    disabled={stepOff(direction)} accessibilityState={{ disabled: stepOff(direction) }}
    onPress={() => setQuantity(value => value + direction)}
    style={({ pressed }) => ({ width: chipTarget, minHeight: 52, justifyContent: 'center', alignItems: 'center', opacity: stepOff(direction) ? 0.5 : pressed ? 0.75 : 1 })}><MarketIcon name={direction < 0 ? 'minus' : 'plus'} color={colors.primary} size={18} /></Pressable>;
  const canAdd = !(busy || locked || quantity > remaining);
  const hero = <View style={{ width: '100%', height: 260 }}>
    <DishPhoto key={item.imageUrl ?? 'placeholder'} item={item} detail flush height={260} />
    {item.isFeatured ? <View style={{ position: 'absolute', left: 16, bottom: 14, borderRadius: 8, backgroundColor: colors.bandAccent, paddingHorizontal: 10, paddingVertical: 5 }}><Text style={{ color: colors.band, letterSpacing: 1.5, textTransform: 'uppercase', ...f.semi(12, 18) }}>{featuredLabel(businessId, 'customer')}</Text></View> : null}
  </View>;
  const eyebrow = menuLayout === 'carta' ? `${item.category}${item.isDemo ? ' · Example' : ''}` : item.isDemo ? 'Example' : '';
  return <AccessiblePanel title={item.name} onClose={() => { if (!busy) onClose(); }} closeDisabled={busy} closeLabel="Close dish details" hero={hero} titleLead={<DietMark diet={item.diet} compact />}
    footer={<>
      {error ? <MarketStatus kind="error" title="Could not add this dish" message={error} /> : null}
      {!orderingAllowed ? <Text role="status" accessibilityLiveRegion="polite" style={{ color: colors.ink, ...f.body(15, 22) }}>{orderingMessage}</Text> : item.isAvailable ? <>
        {inCart ? <MarketText variant="muted">{inCart} already in your cart. {remaining > 0 ? `You can add up to ${remaining} more.` : `You have reached the limit of ${MAX_QUANTITY} for this dish.`}</MarketText> : null}
        {quantity > remaining && remaining > 0 ? <MarketText>Your cart changed. Reduce the quantity before adding.</MarketText> : null}
        {locked ? <MarketText variant="muted">Your cart is paused. Finish recovery or retry your saved cart before adding dishes.</MarketText> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View nativeID="dish-stepper" style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: edge, borderRadius: 12, backgroundColor: colors.surface }}>
            {step(-1)}<Text accessibilityLabel={`Quantity: ${quantity}`} accessibilityLiveRegion="polite" style={{ minWidth: 26, textAlign: 'center', color: colors.ink, ...f.semi(17, 24) }}>{quantity}</Text>{step(1)}
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canAdd }} disabled={!canAdd} onPress={() => void add()}
            style={({ pressed }) => ({ flex: 1, minHeight: 52, borderRadius: 12, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, opacity: !canAdd ? 0.5 : pressed ? 0.85 : 1 })}>
            <Text style={{ color: colors.onPrimary, ...f.semi(16, 22) }}>{busy ? 'Adding…' : `Add · ${formatINRFromPaise(item.pricePaise * quantity)}`}</Text>
          </Pressable>
        </View>
      </> : <MarketText>Currently unavailable</MarketText>}
    </>}>
    {eyebrow ? <MarketText variant="eyebrow">{eyebrow}</MarketText> : null}
    <Text style={{ color: colors.ink, ...f.heading(24, 32) }}>{formatINRFromPaise(item.pricePaise)}</Text>
    <MarketText>{item.description || 'No description provided.'}</MarketText>
  </AccessiblePanel>;
}
