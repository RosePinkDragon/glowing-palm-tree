import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type Order } from '@market/core';
import { MarketLinkButton, MarketText } from './components';
import { MarketLine, MarketSection } from './MarketList';
import { MarketIcon } from './MarketIcons';
import { restorePanelFocus } from './AccessiblePanel';
import { statusCopy, terminalTime, trackingTimeline } from './order-history';
import { useMarketFonts, useMarketTheme } from './theme';

/**
 * Customer order status (#47; customer p. 5 in progress, p. 25 cancelled, p. 26 delivered).
 * Ammu Sammu puts a status pill and headline on the page; Kokani Dine Inn uses a dark band.
 */
export type ReorderAction = (order: Order, restoreFocus: () => void) => void;
export const orderName = (order: Pick<Order, 'id' | 'orderNumber'>) => order.orderNumber ?? order.id.slice(-6);

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

/** Amber status pill in letter-spaced capitals (grey once cancelled), customer p. 5 and 25. */
function StatusPill({ label, cancelled }: { label: string; cancelled: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const text = cancelled ? colors.muted : colors.warning;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 24, borderRadius: 12, backgroundColor: cancelled ? colors.neutralTint : colors.warningTint }}>
    {cancelled ? null : <View aria-hidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warning }} />}
    <Text style={{ color: text, fontSize: 12, lineHeight: 18, letterSpacing: 1.2, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </View>;
}

function StatusHeader({ order, eyebrow, title, detail }: { order: Order; eyebrow: string; title: string; detail: string }) {
  const { colors, statusHeader } = useMarketTheme();
  const fonts = useMarketFonts();
  const band = statusHeader === 'band';
  const heading = (color: string, size: number, align?: 'center') => <Text accessibilityRole="header" aria-level={2}
    style={{ color, fontSize: size, lineHeight: size * 1.2, textAlign: align, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>;
  const body = (color: string, align?: 'center') => <Text style={{ color, fontSize: 15, lineHeight: 22, textAlign: align, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{detail}</Text>;
  const cancelled = order.status === 'cancelled';
  const stage = order.status === 'delivered' || cancelled ? -1 : trackingTimeline(order).findIndex(s => s.state === 'current');
  if (band) return <View role="status" accessibilityLiveRegion="polite" style={{ gap: 8, padding: 20, borderRadius: 22, backgroundColor: cancelled ? colors.bandMuted : colors.band }}>
    <Text style={{ color: cancelled ? colors.bandMutedAccent : colors.bandAccent, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, textTransform: 'uppercase', ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{eyebrow}</Text>
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
    <StatusPill label={eyebrow} cancelled={order.status === 'cancelled'} />
    {heading(colors.ink, 30)}
    {body(colors.muted)}
  </View>;
}

function StageMark({ state, cancelled, neutral }: { state: 'complete' | 'current' | 'pending'; cancelled?: boolean; neutral?: boolean }) {
  const { colors } = useMarketTheme();
  const box = { width: 26, height: 26, borderRadius: 13, alignItems: 'center' as const, justifyContent: 'center' as const };
  if (neutral) return <View aria-hidden style={{ ...box, backgroundColor: colors.muted }}><MarketIcon name="check" color={colors.onPrimary} size={14} /></View>;
  if (cancelled) return <View aria-hidden style={{ ...box, backgroundColor: colors.danger }}><MarketIcon name="close" color={colors.onPrimary} size={14} /></View>;
  if (state === 'complete') return <View aria-hidden style={{ ...box, backgroundColor: colors.primary }}><MarketIcon name="check" color={colors.onPrimary} size={14} /></View>;
  if (state === 'current') return <View aria-hidden style={{ ...box, width: 32, height: 32, borderRadius: 16, marginHorizontal: -3, marginVertical: -3, backgroundColor: colors.tint }}>
    <View style={{ ...box, width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.primary, backgroundColor: colors.surface }}><View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.primary }} /></View>
  </View>;
  return <View aria-hidden style={{ ...box, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface }} />;
}

function StageRow({ label, time, state, last, cancelled, neutral, connector = true }: { label: string; time: string | null; state: 'complete' | 'current' | 'pending'; last: boolean; cancelled?: boolean; neutral?: boolean; connector?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const spoken = `${label}, ${cancelled ? 'cancelled' : state === 'complete' ? 'done' : state === 'current' ? 'now' : 'not yet'}${time ? `, ${time}` : ''}`;
  return <View accessible accessibilityLabel={spoken} role="listitem" style={{ flexDirection: 'row', gap: 14 }}>
    <View style={{ alignItems: 'center', width: 26 }}>
      <StageMark state={state} cancelled={cancelled} neutral={neutral} />
      {!last && connector ? <View aria-hidden style={{ width: 2, flex: 1, minHeight: 18, backgroundColor: state === 'complete' ? colors.primary : colors.border }} /> : null}
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
      <StageRow label="Order placed" time={shortTime(order.createdAtISO)} state="complete" last={false} neutral connector={false} />
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
  const { colors, receiptRule } = useMarketTheme();
  const cancelled = order.status === 'cancelled';
  return <MarketSection>
    {order.lines.map((line, i) => <MarketLine key={`${line.menuItemId}-${i}`} left={`${line.quantity} × ${line.name}`} right={formatINRFromPaise(line.lineTotalPaise)} />)}
    <MarketLine left={<Text style={{ color: colors.muted }}>Delivery</Text>} right={<Text style={{ color: colors.muted, fontSize: 15 }}>{formatINRFromPaise(order.deliveryFeePaise)}</Text>} />
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, borderStyle: receiptRule, paddingTop: 10 }}>
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
  /** undefined while the restaurant is still loading: say nothing about calling yet. */
  order: Order; restaurant: string; phone: string | null | undefined;
  /** offer: show "Get updates" (order in progress, updates off). on: updates are now on. message: app-wide result, shown only after a tap on this screen. */
  updates: { offer: boolean; on: boolean; busy: boolean; turnOn: () => void; message: string };
  onReorder?: ReorderAction;
}) {
  const { colors, statusHeader, voice } = useMarketTheme();
  const trigger = useRef<ComponentRef<typeof Pressable>>(null);
  const restoreFocus = () => {
    if (Platform.OS === 'web') restorePanelFocus(trigger.current as unknown as HTMLElement | null);
    else setTimeout(() => { const handle = findNodeHandle(trigger.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }, 0);
  };
  const updatesStatus = useRef<ComponentRef<typeof View>>(null);
  const tapped = useRef(false);
  const wasBusy = useRef(false);
  // Only a tap on this screen during this visit may show the app-wide updates message.
  const [asked, setAsked] = useState(false);
  const active = order.status !== 'delivered' && order.status !== 'cancelled';
  const { offer, on, busy } = updates;
  // A finished attempt that left the offer showing did not succeed: forget the tap.
  useEffect(() => {
    if (wasBusy.current && !busy && offer) tapped.current = false;
    wasBusy.current = busy;
  }, [busy, offer]);
  // Turning updates on removes the offer (and its focused button): keep focus on the result instead.
  useEffect(() => {
    if (offer || !on || !tapped.current) return;
    tapped.current = false;
    const node = updatesStatus.current as unknown as { focus?: () => void } | null;
    if (Platform.OS === 'web') node?.focus?.();
    else { const handle = findNodeHandle(updatesStatus.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
  }, [offer, on]);
  // A different order is a different visit: forget any earlier tap.
  const orderId = useRef(order.id);
  useEffect(() => {
    if (orderId.current === order.id) return;
    orderId.current = order.id;
    tapped.current = false;
    setAsked(false);
  }, [order.id]);
  const message = asked ? updates.message : '';
  const showCard = active && offer;
  const copy = statusCopy(order, restaurant, statusHeader, indiaParts, formatINRFromPaise(order.totalPaise), voice);
  const call = (label: string, icon: boolean) => phone === undefined ? null : phone ? <MarketLinkButton tone={icon ? 'brand' : 'secondary'} icon={icon ? 'phone' : undefined} compact={!icon} label={label} name={label === 'Call us' ? `Call us, ${restaurant}` : `Call ${restaurant}`} href={phone} />
    : <MarketText variant="muted">Restaurant phone is unavailable. Please try Help & support.</MarketText>;
  const reorder = (label: string) => onReorder ? <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${label} for order ${orderName(order)}`} onPress={() => onReorder(order, restoreFocus)}
    style={({ pressed }) => ({ flex: 1, minHeight: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 })}>
    <Text style={{ color: colors.onPrimary, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{label}</Text>
  </Pressable> : null;
  const address = order.address ? [order.address.house, order.address.streetArea, order.address.landmark].filter(Boolean).join(', ') : order.delivery.addressLine;
  const addressTitle = order.address ? order.address.label === 'other' ? order.address.customLabel ?? 'Other' : order.address.label === 'home' ? 'Home' : 'Work' : null;

  return <View style={{ gap: 16 }}>
    <Text accessibilityRole="header" aria-level={1} style={{ color: colors.ink, fontSize: 22, lineHeight: 29, fontWeight: '700' }}>{`Order ${orderName(order)}`}</Text>
    <StatusHeader order={order} eyebrow={copy.eyebrow} title={copy.title} detail={copy.detail} />
    {order.status !== 'delivered' ? <Timeline order={order} /> : null}
    {/* One wrapper: the tinted card (while offered) and the always-mounted live region share it. While empty it is absolutely positioned, so it takes no slot in the parent's gap. */}
    <View style={showCard ? { gap: 10, padding: 16, borderRadius: 18, backgroundColor: colors.updatesTint } : message ? undefined : { position: 'absolute' }}>
      {showCard ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <MarketIcon name="bell" color={colors.updatesIcon} />
        <View style={{ flex: 1 }}><Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>Get updates on this order</Text><Text style={{ color: colors.muted, fontSize: 14 }}>A notification at every step</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Turn on order updates" accessibilityState={{ disabled: busy }} aria-disabled={busy}
          onPress={() => { if (busy) return; tapped.current = true; setAsked(true); updates.turnOn(); }}
          style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.surface, opacity: busy ? 0.6 : 1 }}>
          <Text style={{ color: colors.primary, fontSize: 15, fontWeight: '700' }}>Turn on</Text>
        </Pressable>
      </View> : null}
      {/* Always mounted so a result is announced; focusable so focus can land here after the offer closes. */}
      <View ref={updatesStatus} role="status" accessibilityLiveRegion="polite" accessible={!!message} {...(Platform.OS === 'web' ? { tabIndex: -1 } as object : {})}>
        {message ? <Text style={{ color: colors.ink, fontSize: 14, lineHeight: 20 }}>{message}</Text> : null}
      </View>
    </View>
    {active ? <MarketSection title="Order details">
      <DetailRow label={voice === 'we' ? 'Dishes' : 'Items'}>{order.lines.map(line => `${line.quantity} × ${line.name}`).join(', ')}</DetailRow>
      <DetailRow label="Deliver to">{addressTitle ? `${addressTitle} · ${address}` : address}</DetailRow>
      <DetailRow label="Payment">{`${formatINRFromPaise(order.totalPaise)} cash on delivery`}</DetailRow>
    </MarketSection> : <Lines order={order} />}
    {order.status === 'delivered' ? <MarketSection><View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <MarketIcon name="pin" color={colors.primary} nudge={2} />
      <View style={{ flex: 1, gap: 2 }}>{addressTitle ? <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '700' }}>{addressTitle}</Text> : null}<Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>{address}</Text></View>
    </View></MarketSection> : null}
    {active ? call(`Call ${restaurant}`, true) : null}
    {order.status === 'cancelled' ? <>
      <MarketText variant="muted">Want to know why? The restaurant can tell you.</MarketText>
      <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}><View style={{ flex: 1, minWidth: 140 }}>{call(voice === 'we' ? 'Call us' : `Call ${restaurant}`, false)}</View>{onReorder ? <View style={{ flex: 1, minWidth: 140, flexDirection: 'row' }}>{reorder('Order again')}</View> : null}</View>
    </> : null}
    {order.status === 'delivered' ? <View style={{ flexDirection: 'row' }}>{reorder('Order this again')}</View> : null}
  </View>;
}
