import { useRef, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type Order } from '@market/core';
import { MarketLinkButton, MarketText } from './components';
import { MarketLine, MarketSection } from './MarketList';
import { MarketPill } from './MarketChips';
import { MarketIcon } from './MarketIcons';
import { restorePanelFocus } from './AccessiblePanel';
import { statusCopy, terminalTime, trackingTimeline } from './order-history';
import { useMarketFonts, useMarketTheme } from './theme';

/**
 * Customer order status (#47; customer p. 5 in progress, p. 25 cancelled, p. 26 delivered).
 * Ammu Sammu puts a status pill and headline on the page; Kokani Dine Inn uses a dark band.
 */
export type ReorderAction = (order: Order, restoreFocus: () => void) => void;
export const orderName = (order: Order) => order.orderNumber ?? order.id.slice(-6);

const indiaParts = (iso: string) => {
  const date = new Date(iso);
  const day = (d: Date) => d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  return {
    time: date.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).toLowerCase(),
    date: date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }),
    today: day(date) === day(new Date()),
  };
};
/** "12:40 pm" today, otherwise "28 Oct, 8:05 pm". */
export const shortTime = (iso: string) => { const p = indiaParts(iso); return p.today ? p.time : `${p.date}, ${p.time}`; };

function StatusHeader({ order, eyebrow, title, detail }: { order: Order; eyebrow: string; title: string; detail: string }) {
  const { colors, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const band = statusHeader === 'band';
  const heading = (color: string, size: number, align?: 'center') => <Text accessibilityRole="header" aria-level={1}
    style={{ color, fontSize: size, lineHeight: size * 1.2, textAlign: align, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>;
  const body = (color: string, align?: 'center') => <Text style={{ color, fontSize: 15, lineHeight: 22, textAlign: align, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{detail}</Text>;
  const stage = trackingTimeline(order).findIndex(s => s.state === 'current');
  if (band) return <View role="status" accessibilityLiveRegion="polite" style={{ gap: 8, padding: 20, borderRadius: 22, backgroundColor: colors.primary }}>
    <Text style={{ color: colors.bandAccent, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{eyebrow}</Text>
    {heading(colors.onPrimary, 30)}
    {body(colors.onPrimary)}
    {stage >= 0 ? <View aria-hidden style={{ flexDirection: 'row', gap: 6, marginTop: 8 }}>
      {[0, 1, 2, 3, 4].map(i => <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= stage ? colors.bandAccent : 'rgba(255,255,255,0.25)' }} />)}
    </View> : null}
  </View>;
  if (order.status === 'delivered') return <View role="status" accessibilityLiveRegion="polite" style={{ gap: 10, alignItems: 'center', paddingVertical: 8 }}>
    <View aria-hidden style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.positiveTint }}><MarketIcon name="check" color={colors.positive} size={30} /></View>
    {heading(colors.ink, 30, 'center')}
    {body(colors.muted, 'center')}
  </View>;
  return <View role="status" accessibilityLiveRegion="polite" style={{ gap: 10, alignItems: 'flex-start' }}>
    <MarketPill label={eyebrow} tone={order.status === 'cancelled' ? 'neutral' : 'brand'} dot={order.status !== 'cancelled'} />
    {heading(colors.ink, 30)}
    {body(colors.muted)}
  </View>;
}

function StageMark({ state, cancelled }: { state: 'complete' | 'current' | 'pending'; cancelled?: boolean }) {
  const { colors } = useMarketTheme();
  const box = { width: 26, height: 26, borderRadius: 13, alignItems: 'center' as const, justifyContent: 'center' as const };
  if (cancelled) return <View aria-hidden style={{ ...box, backgroundColor: colors.danger }}><MarketIcon name="close" color={colors.onPrimary} size={14} /></View>;
  if (state === 'complete') return <View aria-hidden style={{ ...box, backgroundColor: colors.primary }}><MarketIcon name="check" color={colors.onPrimary} size={14} /></View>;
  if (state === 'current') return <View aria-hidden style={{ ...box, borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.tint }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }} /></View>;
  return <View aria-hidden style={{ ...box, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface }} />;
}

function StageRow({ label, time, state, last, cancelled }: { label: string; time: string | null; state: 'complete' | 'current' | 'pending'; last: boolean; cancelled?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const spoken = `${label}, ${cancelled ? 'cancelled' : state === 'complete' ? 'done' : state === 'current' ? 'now' : 'not yet'}${time ? `, ${time}` : ''}`;
  return <View accessible accessibilityLabel={spoken} role="listitem" style={{ flexDirection: 'row', gap: 14 }}>
    <View style={{ alignItems: 'center', width: 26 }}>
      <StageMark state={state} cancelled={cancelled} />
      {!last ? <View aria-hidden style={{ width: 2, flex: 1, minHeight: 18, backgroundColor: state === 'complete' ? colors.primary : colors.border }} /> : null}
    </View>
    <View style={{ flex: 1, paddingBottom: last ? 0 : 16, gap: 2 }}>
      <Text style={{ color: state === 'pending' ? colors.muted : colors.ink, fontSize: 16, lineHeight: 22, ...(state !== 'pending' && fonts.bodyBold ? { fontFamily: fonts.bodyBold } : state !== 'pending' ? { fontWeight: '700' as const } : fonts.body ? { fontFamily: fonts.body } : {}) }}>{label}</Text>
      {time ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{time}</Text> : null}
    </View>
  </View>;
}

function Timeline({ order }: { order: Order }) {
  if (order.status === 'cancelled') {
    const ended = terminalTime(order);
    return <MarketSection><View role="list">
      <StageRow label="Order placed" time={shortTime(order.createdAtISO)} state="complete" last={false} />
      <StageRow label="Cancelled by the restaurant" time={ended ? shortTime(ended) : null} state="complete" cancelled last />
    </View></MarketSection>;
  }
  const stages = trackingTimeline(order);
  return <MarketSection><View role="list">
    {stages.map((stage, index) => <StageRow key={stage.status} label={stage.state === 'complete' && stage.status === 'preparing' ? 'Prepared' : stage.label}
      time={stage.time ? shortTime(stage.time) : stage.state === 'current' ? 'Now' : null} state={stage.state === 'stopped' ? 'pending' : stage.state} last={index === stages.length - 1} />)}
  </View></MarketSection>;
}

function Lines({ order }: { order: Order }) {
  const { colors } = useMarketTheme();
  const cancelled = order.status === 'cancelled';
  return <MarketSection>
    {order.lines.map((line, i) => <MarketLine key={`${line.menuItemId}-${i}`} left={`${line.quantity} × ${line.name}`} right={formatINRFromPaise(line.lineTotalPaise)} />)}
    <MarketLine left={<Text style={{ color: colors.muted }}>Delivery</Text>} right={<Text style={{ color: colors.muted, fontSize: 15 }}>{formatINRFromPaise(order.deliveryFeePaise)}</Text>} />
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 }}>
      <MarketLine bold left={cancelled ? 'Total' : 'Paid in cash'} right={<Text style={{ color: cancelled ? colors.muted : colors.ink, fontSize: 17, fontWeight: '700', textDecorationLine: cancelled ? 'line-through' : 'none' }}>{formatINRFromPaise(order.totalPaise)}</Text>} />
    </View>
  </MarketSection>;
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  const { colors } = useMarketTheme();
  return <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16 }}>
    <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>{label}</Text>
    <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22, flex: 1, textAlign: 'right' }}>{children}</Text>
  </View>;
}

export function OrderStatusView({ order, restaurant, phone, updates, onReorder }: {
  order: Order; restaurant: string; phone: string | null;
  /** Shown only while the order is in progress and order updates are off. */
  updates?: { busy: boolean; turnOn: () => void; message?: string };
  onReorder?: ReorderAction;
}) {
  const { colors, statusHeader } = useMarketTheme();
  const trigger = useRef<ComponentRef<typeof Pressable>>(null);
  const restoreFocus = () => {
    if (Platform.OS === 'web') restorePanelFocus(trigger.current as unknown as HTMLElement | null);
    else setTimeout(() => { const handle = findNodeHandle(trigger.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }, 0);
  };
  const copy = statusCopy(order, restaurant, statusHeader, indiaParts, formatINRFromPaise(order.totalPaise));
  const active = order.status !== 'delivered' && order.status !== 'cancelled';
  const call = (label: string, primary = false) => phone ? <MarketLinkButton tone={primary ? 'primary' : 'secondary'} icon="phone" label={label} name={`Call ${restaurant}`} href={phone} />
    : <MarketText variant="muted">Restaurant phone is unavailable. Please try Help & support.</MarketText>;
  const reorder = (label: string) => onReorder ? <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${label} for order ${orderName(order)}`} onPress={() => onReorder(order, restoreFocus)}
    style={({ pressed }) => ({ flex: 1, minHeight: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 })}>
    <Text style={{ color: colors.onPrimary, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{label}</Text>
  </Pressable> : null;
  const address = order.address ? [order.address.house, order.address.streetArea, order.address.landmark].filter(Boolean).join(', ') : order.delivery.addressLine;
  const addressTitle = order.address ? order.address.label === 'other' ? order.address.customLabel ?? 'Other' : order.address.label === 'home' ? 'Home' : 'Work' : null;

  return <View style={{ gap: 16 }}>
    <MarketText variant="heading">{`Order ${orderName(order)}`}</MarketText>
    <StatusHeader order={order} eyebrow={copy.eyebrow} title={copy.title} detail={copy.detail} />
    {order.status !== 'delivered' ? <Timeline order={order} /> : null}
    {active && updates ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 18, backgroundColor: colors.tint }}>
      <MarketIcon name="bell" color={colors.primary} />
      <View style={{ flex: 1 }}><Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>Get updates on this order</Text><Text style={{ color: colors.muted, fontSize: 14 }}>A notification at every step</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Turn on order updates" disabled={updates.busy} onPress={updates.turnOn}
        style={{ minHeight: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.surface, opacity: updates.busy ? 0.6 : 1 }}>
        <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700' }}>Turn on</Text>
      </Pressable>
    </View> : null}
    {updates?.message ? <View role="status" accessibilityLiveRegion="polite"><MarketText>{updates.message}</MarketText></View> : null}
    {active ? <MarketSection title="Order details">
      <DetailRow label="Items">{order.lines.map(line => `${line.quantity} × ${line.name}`).join(', ')}</DetailRow>
      <DetailRow label="Deliver to">{addressTitle ? `${addressTitle} · ${address}` : address}</DetailRow>
      <DetailRow label="Payment">{`${formatINRFromPaise(order.totalPaise)} cash on delivery`}</DetailRow>
    </MarketSection> : <Lines order={order} />}
    {order.status === 'delivered' ? <MarketSection><View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <MarketIcon name="pin" color={colors.primary} nudge={2} />
      <View style={{ flex: 1, gap: 2 }}>{addressTitle ? <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>{addressTitle}</Text> : null}<Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>{address}</Text></View>
    </View></MarketSection> : null}
    {active ? call(`Call ${restaurant}`) : null}
    {order.status === 'cancelled' ? <>
      <MarketText variant="muted">Want to know why? The restaurant can tell you.</MarketText>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}><View style={{ flex: 1, minWidth: 150 }}>{call(`Call ${restaurant}`)}</View>{onReorder ? <View style={{ flex: 1, minWidth: 150, flexDirection: 'row' }}>{reorder('Order again')}</View> : null}</View>
    </> : null}
    {order.status === 'delivered' ? <View style={{ flexDirection: 'row' }}>{reorder('Order this again')}</View> : null}
  </View>;
}
