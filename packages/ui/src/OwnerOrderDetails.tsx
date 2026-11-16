import { useRef, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type Order } from '@market/core';
import { MarketButton, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { MarketLine, MarketSection } from './MarketList';
import { MarketPill } from './MarketChips';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { callLink, canCancel, clockTime, filterForStatus, historyLine, historyNewestFirst, mapsUrl, nextAction, orderReference, placedLabel, statusLabel } from './admin-model';
import type { OwnerOrdersState } from './OwnerOrders';
import Svg, { Path } from 'react-native-svg';
import { useMarketFonts, useMarketTheme } from './theme';

// Phone handset outline for the cancel hint (decorative).
const phonePath = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z';

type Tone = 'primary' | 'secondary' | 'danger';
/** 48px-minimum action used by order cards, the details footer and the cancel sheet. */
export function ActionButton({ label, name, tone = 'secondary', grow, disabled, onPress }: { label: string; name?: string; tone?: Tone; grow?: boolean; disabled?: boolean; onPress: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const fill = tone === 'danger' ? colors.danger : colors.primary;
  const filled = tone !== 'secondary';
  return <Pressable accessibilityRole="button" accessibilityLabel={name ?? label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flex: grow ? 1 : undefined, minHeight: 48, minWidth: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: filled ? fill : colors.border, backgroundColor: filled ? fill : colors.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={{ color: filled ? colors.onPrimary : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </Pressable>;
}

/** A link styled as a 48px button. Web gets a real anchor (tel:/https:); native opens the URL through Linking. */
function LinkButton({ label, name, href, tone = 'secondary', external }: { label: string; name?: string; href: string; tone?: 'primary' | 'secondary'; external?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [failed, setFailed] = useState(false);
  const primary = tone === 'primary';
  const web = Platform.OS === 'web';
  return <View style={{ gap: 4 }}>
    <Text accessibilityRole="link" accessibilityLabel={name ?? label} {...(web ? ({ href, ...(external ? { hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {}) } as object) : { onPress: () => { setFailed(false); Linking.openURL(href).catch(() => setFailed(true)); } })}
      style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 20, paddingVertical: 13, textAlign: 'center', borderRadius: 14, borderWidth: 1, borderColor: primary ? colors.primary : colors.border, backgroundColor: primary ? colors.primary : colors.surface, overflow: 'hidden', color: primary ? colors.onPrimary : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{label}</Text>
    {failed ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 13 }}>Could not open this link on this device.</Text> : null}
  </View>;
}

/**
 * Full-screen order details for owners (#101). Reads the order from the shared queue so a reload after a
 * conflict shows the current state. Only orders the owner's business query returned are reachable.
 */
export function OwnerOrderDetails({ queue, orderId, now, onClose }: { queue: OwnerOrdersState; orderId: string; now: number; onClose: () => void }) {
  const { colors } = useMarketTheme();
  const order = queue.orders.find(candidate => candidate.id === orderId);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const closeSheet = () => { setConfirming(false); restorePanelFocus(trigger.current); };
  const notices = <>
    <View role="status" aria-live="polite">{queue.success ? <MarketText>{queue.success}</MarketText> : null}</View>
    {queue.notice ? <MarketStatus kind="error" title="Order update notice" message={queue.notice} action={<MarketButton label="Dismiss" variant="secondary" onPress={queue.dismissNotice} />} /> : null}
  </>;
  if (!order) return <AccessiblePanel fullScreen title="Order details" onClose={onClose}>
    {queue.loading ? <MarketStatus kind="loading" title="Loading order" />
      : queue.error ? <MarketStatus kind="error" title="Could not load orders" message={queue.error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void queue.reload()} />} />
      : <MarketStatus kind="empty" title="This order is no longer available" message="It may have been removed. Go back to the Orders list." />}
  </AccessiblePanel>;

  const reference = orderReference(order.id);
  const busy = queue.busyIds.has(order.id);
  const locked = busy || queue.demo;
  const next = nextAction(order.status);
  const call = callLink(order.delivery.phone);
  const maps = mapsUrl(order.location);
  const terminal = !next && !canCancel(order.status);
  const run = (status: Order['status']) => void queue.transition(order, status).then(updated => { if (updated) queue.setFilter(filterForStatus(updated.status)); });
  const footer = terminal ? undefined : <View style={{ flexDirection: 'row', gap: 10 }}>
    {canCancel(order.status) ? <ActionButton label="Cancel" name="Cancel order" disabled={locked} onPress={() => { trigger.current = capturePanelFocus(); setConfirming(true); }} /> : null}
    {next ? <ActionButton grow tone="primary" label={busy ? 'Updating…' : next.label} name={next.label} disabled={locked} onPress={() => run(next.status)} /> : null}
  </View>;
  return <AccessiblePanel fullScreen title={`Order ${reference}`} onClose={onClose} footer={footer}>
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <MarketPill tone={order.status === 'cancelled' ? 'danger' : 'brand'} label={statusLabel(order.status)} status={`Status: ${statusLabel(order.status)}`} />
        <MarketText variant="muted">{placedLabel(order.createdAtISO, now)}</MarketText>
      </View>
      {terminal ? <MarketText variant="muted">{order.status === 'cancelled' ? 'This order was cancelled. No further actions.' : 'This order was delivered. No further actions.'}</MarketText> : null}
    </View>
    {notices}
    <MarketSection>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' }}>{order.delivery.name}</Text>
          <MarketText variant="muted">{order.delivery.phone}</MarketText>
        </View>
        {call ? <View style={{ minWidth: 96 }}><LinkButton tone="primary" label="Call" name={`Call ${order.delivery.name}`} href={call} /></View> : null}
      </View>
      {!call ? <MarketText variant="muted">This phone number can't be dialled. Check it before calling.</MarketText> : null}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 10 }}>
        <MarketText>{order.delivery.addressLine}</MarketText>
        {maps ? <LinkButton external label="Open in Maps" href={maps} /> : null}
      </View>
    </MarketSection>
    <MarketSection title="Items">
      {order.lines.map((line, index) => <View key={`${line.menuItemId}-${index}`} style={{ gap: 4 }}><MarketLine left={`${line.quantity} × ${line.name}`} right={formatINRFromPaise(line.lineTotalPaise)} /><DietMark diet={line.diet} /></View>)}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, borderStyle: 'dashed', paddingTop: 10, gap: 4 }}>
        <MarketLine left="Items" right={formatINRFromPaise(order.subtotalPaise)} />
        <MarketLine left="Delivery" right={formatINRFromPaise(order.deliveryFeePaise)} />
      </View>
      <View style={{ padding: 12, borderRadius: 12, backgroundColor: colors.tint }}><MarketLine bold left="Collect in cash" right={formatINRFromPaise(order.totalPaise)} /></View>
    </MarketSection>
    <MarketSection title="History">
      {historyNewestFirst(order.history).map((entry, index) => <MarketLine key={index} left={historyLine(entry)} right={clockTime(entry.createdAtISO)} />)}
      {!order.history?.length ? <MarketText variant="muted">No history available.</MarketText> : null}
    </MarketSection>
    {confirming ? <AccessiblePanel sheet title={`Cancel order ${reference}?`} onClose={closeSheet}>
      <MarketText>{`${order.delivery.name}'s order for ${formatINRFromPaise(order.totalPaise)} will be cancelled, and it will show as cancelled in their app. This can't be undone.`}</MarketText>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
        <Svg aria-hidden accessible={false} importantForAccessibility="no" width={18} height={18} viewBox="0 0 24 24" style={{ marginTop: 3 }}><Path d={phonePath} fill="none" stroke={colors.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></Svg>
        <View style={{ flex: 1 }}><MarketText>A quick call to say why helps, for example if a dish has run out.</MarketText></View>
      </View>
      <ActionButton tone="danger" label={busy ? 'Cancelling…' : 'Cancel the order'} disabled={locked} onPress={() => { setConfirming(false); run('cancelled'); }} />
      <ActionButton label="Keep the order" disabled={busy} onPress={closeSheet} />
    </AccessiblePanel> : null}
  </AccessiblePanel>;
}
