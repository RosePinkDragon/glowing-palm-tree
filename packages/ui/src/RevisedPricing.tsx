import { useEffect, useRef, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Text, View } from 'react-native';
import { formatINRFromPaise as money } from '@market/core';
import { MarketButton, MarketCard, MarketText } from './components';
import type { RevisedQuote } from './pricing-model';
import { useMarketTheme } from './theme';

export function RevisedPricing({ quote, busy, accept, edit }: { quote: RevisedQuote; busy: boolean; accept: () => void; edit: () => void }) {
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const { colors } = useMarketTheme();
  useEffect(() => {
    if (Platform.OS === 'web') (heading.current as unknown as HTMLElement | null)?.focus();
    else { const handle = findNodeHandle(heading.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  }, [quote]);
  const old = quote.original.pricing, next = quote.pricing;
  const belowMinimum = next.subtotal_paise < next.min_order_paise;
  return <MarketCard><Text ref={heading} accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ color: colors.ink, fontSize: 22, lineHeight: 29, fontWeight: '700' }}>Review revised order</Text><MarketText>No order was placed. Please review each change before accepting.</MarketText>
    {quote.original.lines.map((line, i) => <View key={line.item.id}><MarketText>{line.quantity} × {line.item.name}</MarketText><MarketText>Unit price: {money(old.lines[i].unit_price_paise)} → {money(next.lines[i].unit_price_paise)}</MarketText><MarketText>Line total: {money(old.lines[i].line_total_paise)} → {money(next.lines[i].line_total_paise)}</MarketText></View>)}
    <MarketText>Delivery fee: {money(old.delivery_fee_paise)} → {money(next.delivery_fee_paise)}</MarketText><MarketText>Minimum order: {money(old.min_order_paise)} → {money(next.min_order_paise)}</MarketText><MarketText>Subtotal: {money(old.subtotal_paise)} → {money(next.subtotal_paise)}</MarketText><MarketText>Total: {money(old.total_paise)} → {money(next.total_paise)}</MarketText>
    {belowMinimum ? <MarketText>The revised subtotal is below the minimum order. Edit your cart before ordering.</MarketText> : null}
    <MarketButton label="Accept revised total and place order" disabled={busy || belowMinimum} onPress={accept} /><MarketButton label="Edit cart" variant="secondary" disabled={busy} onPress={edit} />
  </MarketCard>;
}
