import { useEffect, useRef, type RefObject } from 'react';
import { Pressable, Text, View } from 'react-native';
import { MAX_QUANTITY, type CartLine, type MenuItem } from '@market/core';
import { MarketIcon } from './MarketIcons';
import { useMarketFonts, useMarketTheme } from './theme';

export const chipTarget = 44;
const maxCart = MAX_QUANTITY;
export type Controls = { orderingAllowed: boolean; demo: boolean; locked: boolean; quantity: (item: MenuItem) => number; onAdd: (item: MenuItem) => void; onRemove: (item: MenuItem) => void; onOpen: (item: MenuItem) => void; viewportRevision: number };
type Focusable = { focus?: () => void } | null;

export function useFamilies() {
  const fonts = useMarketFonts();
  const semi = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) });
  const heading = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) });
  const body = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  return { semi, heading, body };
}

/** "+ Add" until the dish is in the cart, then a -/quantity/+ stepper. Focus follows the control that replaced the one pressed. */
export function DishAction({ item, controls, wide = false, onDark = false }: { item: MenuItem; controls: Controls; wide?: boolean; /** On the dark band the controls are gold with dark text, so they keep their edge and contrast. */ onDark?: boolean }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const { orderingAllowed, demo, locked, onAdd, onRemove } = controls;
  const quantity = controls.quantity(item);
  const example = demo || item.isDemo;
  const fill = onDark ? colors.bandAccent : colors.primary, onFill = onDark ? colors.band : colors.onPrimary;
  const wantFocus = useRef<{ target: 'plus' | 'add'; until: number } | null>(null);
  const plus = useRef<Focusable>(null), add = useRef<Focusable>(null);
  const request = (target: 'plus' | 'add') => { wantFocus.current = { target, until: Date.now() + 2500 }; };
  useEffect(() => {
    const want = wantFocus.current;
    if (!want || want.until < Date.now()) return;
    // The controls are disabled while the cart is being saved; focus once they are usable again.
    if (locked) return;
    if (want.target === 'plus' && quantity > 0) { plus.current?.focus?.(); wantFocus.current = null; }
    else if (want.target === 'add' && quantity === 0) { add.current?.focus?.(); wantFocus.current = null; }
  }, [quantity, locked]);
  if (!item.isAvailable && !example) return <View style={{ minHeight: chipTarget, borderRadius: 12, backgroundColor: colors.neutralTint, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }}><Text style={{ color: colors.muted, ...f.semi(14, 20) }}>Currently unavailable</Text></View>;
  if (quantity === 0) {
    if (!orderingAllowed) return null;
    return <Pressable ref={add as never} accessibilityRole="button" accessibilityLabel={example ? 'Add example to cart' : 'Add to cart'} accessibilityState={{ disabled: locked }} disabled={locked}
      onPress={() => { request('plus'); onAdd(item); }}
      style={({ pressed }) => ({ minHeight: chipTarget, minWidth: wide ? 112 : undefined, borderRadius: 12, borderWidth: 1.5, borderColor: onDark ? colors.bandAccent : colors.primary, backgroundColor: onDark ? colors.bandAccent : wide ? colors.primary : colors.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, opacity: locked ? 0.5 : pressed ? 0.8 : 1 })}>
      <Text accessible={false} style={{ color: onDark ? colors.band : wide ? colors.onPrimary : colors.primary, ...f.semi(15, 22) }}>+ Add</Text>
    </Pressable>;
  }
  const button = (label: string, icon: 'plus' | 'minus', disabled: boolean, onPress: () => void, ref?: RefObject<Focusable>) => <Pressable ref={ref as never} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ width: chipTarget, minHeight: chipTarget, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}><MarketIcon name={icon} color={onFill} size={18} /></Pressable>;
  return <View accessibilityRole="group" accessibilityLabel={`${item.name} quantity`} style={{ minHeight: chipTarget, borderRadius: 12, backgroundColor: fill, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minWidth: wide ? 132 : undefined }}>
    {button(`Remove one ${item.name}`, 'minus', locked, () => { if (quantity === 1) request('add'); onRemove(item); })}
    <Text accessibilityLabel={`${quantity} in cart`} accessibilityLiveRegion="polite" style={{ color: onFill, minWidth: 24, textAlign: 'center', ...f.semi(16, 22) }}>{quantity}</Text>
    {button(`Add one ${item.name}`, 'plus', locked || !orderingAllowed || quantity >= maxCart, () => onAdd(item), plus)}
  </View>;
}


/** Cart lines by dish id, and the controls bundle every dish action reads. */
export function menuControls(cart: readonly CartLine[], rest: Omit<Controls, 'quantity'>): Controls {
  const quantities = new Map(cart.map(line => [line.item.id, line.quantity]));
  return { ...rest, quantity: item => quantities.get(item.id) ?? 0 };
}
