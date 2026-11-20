import { useRef, type ComponentRef } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, removeCartItem, setCartItemQuantity, MAX_QUANTITY, type CartLine } from '@market/core';
import { MarketButton, MarketField, MarketStatus } from './components';
import { CheckoutAddressSummary, type CheckoutAddresses } from './CheckoutAddress';
import { DietMark } from './DietMark';
import { MarketIcon } from './MarketIcons';
import { ReorderNotice } from './ReorderPanel';
import { useMarketFonts, useMarketTheme } from './theme';

const money = formatINRFromPaise;

/**
 * The cart and checkout page (customer p. 4): delivery card, delivery details, dishes with steppers,
 * bill summary, cash on delivery and a pinned "To pay / Place order" bar. Presentation only: every
 * decision (locks, ordering allowed, totals, the place-order label) is made by CustomerArea.
 */
export type CartPageProps = {
  demo: boolean; cartMessage: string; ready: boolean; cartError: string; cart: CartLine[];
  locked: boolean; orderingAllowed: boolean; hasUnavailable: boolean;
  subtotalPaise: number; deliveryFeePaise: number; minOrderPaise: number;
  /** #182: what the server's offer takes off, and the offer row (CartOffer) shown above the bill. */
  discountPaise?: number; offerSlot?: React.ReactNode;
  details: { name: string; phone: string }; setDetails: (details: { name: string; phone: string }) => void;
  addrs: CheckoutAddresses; placeLabel: string; placeDisabled: boolean; localError: string;
  change: (fn: (lines: CartLine[]) => CartLine[], adding?: boolean) => void; onPlace: () => void; onBrowse: () => void;
};

function Card({ children, gap = 12 }: { children: React.ReactNode; gap?: number }) {
  const { colors } = useMarketTheme();
  return <View style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap }}>{children}</View>;
}

function Eyebrow({ children }: { children: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Text accessibilityRole="header" aria-level={2} style={{ color: colors.muted, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{children}</Text>;
}

function StepButton({ kind, label, disabled, onPress }: { kind: 'plus' | 'minus'; label: string; disabled: boolean; onPress: () => void }) {
  const { colors } = useMarketTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
    <MarketIcon name={kind} color={colors.primary} size={18} />
  </Pressable>;
}

function CartLineRow({ line, locked, orderingAllowed, demo, change }: { line: CartLine; locked: boolean; orderingAllowed: boolean; demo: boolean } & Pick<CartPageProps, 'change'>) {
  const { colors, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const { item, quantity } = line;
  const gone = !item.isAvailable && !item.isDemo;
  const total = money(item.pricePaise * quantity);
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  return <View role="group" accessibilityLabel={`${item.name}: ${money(item.pricePaise)} × ${quantity} = ${total}`} style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <DietMark diet={item.diet} compact />
      <Text style={{ flex: 1, color: colors.ink, fontSize: statusHeader === 'band' ? 19 : 16, lineHeight: 24, ...(statusHeader === 'band' && fonts.heading ? { fontFamily: fonts.heading } : bold) }}>{item.name}</Text>
      <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24, ...bold }}>{total}</Text>
    </View>
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text style={{ flex: 1, color: colors.muted, fontSize: 14, lineHeight: 20 }}>{gone ? 'Last shown price: ' : ''}{money(item.pricePaise)} each</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 14, backgroundColor: colors.surface }}>
        <StepButton kind="minus" label={`Remove one ${item.name}`} disabled={locked}
          onPress={() => change(lines => { const current = lines.find(value => value.item.id === item.id); return current && current.quantity > 1 ? setCartItemQuantity(lines, item.id, current.quantity - 1) : removeCartItem(lines, item.id); })} />
        <Text role="status" accessibilityLiveRegion="polite" style={{ minWidth: 28, textAlign: 'center', color: colors.ink, fontSize: 16, lineHeight: 24, ...bold }}>{quantity}</Text>
        {orderingAllowed ? <StepButton kind="plus" label={`Add one ${item.name}`} disabled={locked || quantity >= MAX_QUANTITY || (gone && !demo)}
          onPress={() => change(lines => { const current = lines.find(value => value.item.id === item.id); return current ? setCartItemQuantity(lines, item.id, current.quantity + 1) : lines; }, true)} /> : <View style={{ width: 8 }} />}
      </View>
    </View>
    {gone ? <>
      <Text style={{ color: colors.danger, fontSize: 14, lineHeight: 20 }}>This dish is unavailable. Remove it before checkout.</Text>
      <MarketButton label={`Remove unavailable ${item.name}`} variant="secondary" disabled={locked} onPress={() => change(lines => removeCartItem(lines, item.id))} />
    </> : null}
  </View>;
}

function BillRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const style = { color: muted ? colors.muted : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.body ? { fontFamily: fonts.body } : {}) };
  return <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Text style={style}>{label}</Text><Text style={style}>{value}</Text></View>;
}

export function CartPage(p: CartPageProps) {
  const { colors, name, voice, receiptRule, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const count = p.cart.reduce((n, line) => n + line.quantity, 0);
  const noun = voice === 'we' ? (count === 1 ? 'dish' : 'dishes') : (count === 1 ? 'item' : 'items');
  const discount = p.discountPaise ?? 0;
  const total = p.subtotalPaise + p.deliveryFeePaise - discount;
  const band = statusHeader === 'band';
  const empty = p.cart.length === 0;
  const bar = useRef<ComponentRef<typeof View>>(null);
  // The pinned bar can cover a control that takes focus (tabbing); scroll the nearest scrolling ancestor so it stays above the bar.
  const keepAboveBar = (event: { target: unknown }) => {
    if (Platform.OS !== 'web') return;
    const target = event.target as HTMLElement | null, pinned = bar.current as unknown as HTMLElement | null;
    if (!target?.getBoundingClientRect || !pinned?.getBoundingClientRect || pinned.contains(target) || !target.matches(':focus-visible')) return; // pointer focus must not scroll: it would move the control under the press
    const gap = target.getBoundingClientRect().bottom - pinned.getBoundingClientRect().top + 16;
    if (gap <= 0) return;
    let parent = target.parentElement;
    while (parent && !(parent.scrollHeight > parent.clientHeight && /(auto|scroll)/.test(getComputedStyle(parent).overflowY))) parent = parent.parentElement;
    (parent ?? document.scrollingElement)?.scrollBy({ top: gap });
  };
  const stick = Platform.OS === 'web' ? ({ position: 'sticky', bottom: 12, zIndex: 2 } as object) : {};
  return <View onFocus={keepAboveBar} style={{ gap: 16, width: '100%', maxWidth: 640, alignSelf: 'center' }}>
    <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>{p.demo ? 'Sample cart' : empty ? name : `${name} · ${count} ${noun}`}</Text>
    {p.cartMessage ? <ReorderNotice message={p.cartMessage} /> : null}
    {p.demo ? <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>Example items and prices are for browsing only. Checkout is unavailable.</Text> : null}
    {!p.ready && !p.cartError ? <MarketStatus kind="loading" title="Loading your cart and menu" /> : empty ? <MarketStatus kind="empty" title="Your cart is empty" message="Explore the menu to get started." /> : <>
      <CheckoutAddressSummary ctrl={p.addrs} />
      <Card>
        <Eyebrow>Delivery details</Eyebrow>
        <MarketField label="Name" value={p.details.name} editable={!p.locked} onChangeText={value => p.setDetails({ ...p.details, name: value })} />
        <MarketField label="Mobile number" value={p.details.phone} editable={!p.locked} keyboardType="phone-pad" onChangeText={value => p.setDetails({ ...p.details, phone: value })} />
      </Card>
      <Card gap={14}>
        <Eyebrow>{voice === 'we' ? 'Dishes' : 'Your items'}</Eyebrow>
        {p.cart.map((line, index) => <View key={line.item.id} style={{ borderTopWidth: index ? 1 : 0, borderTopColor: colors.border, paddingTop: index ? 14 : 0 }}>
          <CartLineRow line={line} locked={p.locked} orderingAllowed={p.orderingAllowed} demo={p.demo} change={p.change} />
        </View>)}
        <Pressable accessibilityRole="button" accessibilityLabel={voice === 'we' ? 'Add more dishes' : 'Add more items'} onPress={p.onBrowse} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
          <MarketIcon name="plus" color={colors.primary} size={16} />
          <Text style={{ color: colors.primary, fontSize: 15, ...bold }}>{voice === 'we' ? 'Add more dishes' : 'Add more items'}</Text>
        </Pressable>
      </Card>
      {p.offerSlot}
      <Card gap={8}>
        <Eyebrow>{band ? 'Bill' : 'Bill summary'}</Eyebrow>
        <BillRow label={p.hasUnavailable ? (voice === 'we' ? 'Dishes (available only)' : 'Item total (available only)') : voice === 'we' ? 'Dishes' : 'Item total'} value={money(p.subtotalPaise)} />
        <BillRow label="Delivery fee" value={money(p.deliveryFeePaise)} />
        {discount > 0 ? <BillRow label="Discount" value={`\u2212${money(discount)}`} /> : null}
        {p.minOrderPaise > 0 ? <BillRow muted label="Minimum order" value={money(p.minOrderPaise)} /> : null}
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, borderStyle: receiptRule, paddingTop: 12, marginTop: 4, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Text style={{ color: colors.ink, fontSize: 16, ...bold }}>To pay</Text>
          <Text style={{ color: colors.ink, fontSize: band ? 24 : 20, lineHeight: 30, ...(band && fonts.heading ? { fontFamily: fonts.heading } : bold) }}>{money(total)}</Text>
        </View>
        {discount > 0 ? <Text style={{ color: colors.primary, fontSize: 14, lineHeight: 20, ...bold }}>{`You saved ${money(discount)}`}</Text> : null}
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>This is the final amount. You pay it in cash when the food arrives. Any price changes need your OK before you order.</Text>
      </Card>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View aria-hidden style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: band ? colors.updatesTint : colors.tint }}><MarketIcon name="cash" color={band ? colors.updatesIcon : colors.primary} size={22} /></View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 22, ...bold }}>Cash on delivery</Text>
            <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{voice === 'we' ? 'Pay the rider when your order arrives' : 'Pay the rider when your food arrives'}</Text>
          </View>
          <View aria-hidden style={{ width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary }}><MarketIcon name="check" color={colors.onPrimary} size={14} /></View>
        </View>
      </Card>
      {p.localError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{p.localError}</Text> : null}
      {p.orderingAllowed ? <View ref={bar} style={{ ...stick, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface }}>
        <View style={{ paddingLeft: 4 }}>
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 16 }}>To pay</Text>
          <Text style={{ color: colors.ink, fontSize: 18, lineHeight: 24, ...bold }}>{money(total)}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: p.placeDisabled }} disabled={p.placeDisabled} onPress={p.onPlace}
          style={({ pressed }) => ({ flex: 1, minHeight: 52, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primary, opacity: p.placeDisabled ? 0.5 : pressed ? 0.85 : 1 })}>
          <Text style={{ color: colors.onPrimary, fontSize: 16, lineHeight: 22, ...bold }}>{p.placeLabel}</Text>
        </Pressable>
      </View> : null}
    </>}
  </View>;
}
