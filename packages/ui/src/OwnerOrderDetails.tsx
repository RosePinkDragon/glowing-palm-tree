import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { addressTitle, formatINRFromPaise, type Order } from '@market/core';
import { MarketButton, MarketLinkButton, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { MarketLine, MarketSection } from './MarketList';
import { MarketPill } from './MarketChips';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { callLink, canCancel, clockTime, filterForStatus, historyLine, historyNewestFirst, mapsUrl, nextAction, orderReference, pinCheckLine, placedLabel, statusLabel } from './admin-model';
import { ownerReference, RemoteOrderFlag, type OwnerOrdersState } from './OwnerOrders';
import { MarketIcon } from './MarketIcons';
import { discountLabel, minus } from './offer-model';
import { useMarketFonts, useMarketTheme } from './theme';

type Tone = 'primary' | 'secondary' | 'danger';
/** 48px-minimum action used by order cards, the details footer and the cancel sheet. */
export function ActionButton({ label, name, tone = 'secondary', grow, disabled, roomy, onPress }: { label: string; name?: string; tone?: Tone; grow?: boolean; disabled?: boolean; roomy?: boolean; onPress: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const fill = tone === 'danger' ? colors.danger : colors.primary;
  const filled = tone !== 'secondary';
  return <Pressable accessibilityRole="button" accessibilityLabel={name ?? label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => ({ flex: grow ? 1 : undefined, minHeight: roomy ? 56 : 48, minWidth: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderWidth: 1, borderColor: filled ? fill : colors.border, backgroundColor: filled ? fill : colors.surface, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={{ color: filled ? colors.onPrimary : colors.ink, fontSize: 15, lineHeight: 22, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{label}</Text>
  </Pressable>;
}

/**
 * Full-screen order details for owners (#101). Reads the order from the shared queue so a reload after a
 * conflict shows the current state. Only orders the owner's business query returned are reachable.
 */
export function OwnerOrderDetails({ queue, orderId, now, onClose }: { queue: OwnerOrdersState; orderId: string; now: number; onClose: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const order = queue.orders.find(candidate => candidate.id === orderId);
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const closeSheet = () => { setConfirming(false); restorePanelFocus(trigger.current); };
  const notices = <>
    <View role="status" aria-live="polite">{queue.success ? <MarketText>{queue.success}</MarketText> : null}</View>
    {queue.notice ? <MarketStatus kind="error" title="Order update notice" message={queue.notice} action={<MarketButton label="Dismiss" variant="secondary" onPress={queue.dismissNotice} />} /> : null}
  </>;
  if (!order) return <AccessiblePanel fullScreen owner title="Order details" onClose={onClose}>
    {queue.loading ? <MarketStatus kind="loading" title="Loading order" />
      : queue.error ? <MarketStatus kind="error" title="Could not load orders" message={queue.error} action={<MarketButton label="Retry" variant="secondary" onPress={() => void queue.reload()} />} />
      : <MarketStatus kind="empty" title="This order is no longer available" message="It may have been removed. Go back to the Orders list." />}
  </AccessiblePanel>;

  const reference = ownerReference(order);
  const busy = queue.busyIds.has(order.id);
  const locked = busy || queue.demo;
  const next = nextAction(order.status);
  const call = callLink(order.delivery.phone);
  const maps = mapsUrl(order.location);
  const pinDistance = pinCheckLine(order);
  const terminal = !next && !canCancel(order.status);
  const run = (status: Order['status']) => void queue.transition(order, status).then(updated => { if (updated) queue.setFilter(filterForStatus(updated.status)); });
  const footer = terminal ? undefined : <View style={{ flexDirection: 'row', gap: 10 }}>
    {canCancel(order.status) ? <ActionButton roomy label="Cancel" name="Cancel order" disabled={locked} onPress={() => { trigger.current = capturePanelFocus(); setConfirming(true); }} /> : null}
    {next ? <ActionButton roomy grow tone="primary" label={busy ? 'Updating…' : next.label} name={next.label} disabled={locked} onPress={() => run(next.status)} /> : null}
  </View>;
  return <AccessiblePanel fullScreen owner title={`Order ${reference}`} subtitle={placedLabel(order.createdAtISO, now)} onClose={onClose} footer={footer}
    headerEnd={<MarketPill tone={order.status === 'cancelled' ? 'danger' : order.status === 'accepted' ? 'info' : 'brand'} label={statusLabel(order.status)} status={`Status: ${statusLabel(order.status)}`} />}>
    {terminal ? <MarketText variant="muted">{order.status === 'cancelled' ? 'This order was cancelled. No further actions.' : 'This order was delivered. No further actions.'}</MarketText> : null}
    {notices}
    <MarketSection>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' }}>{order.delivery.name}</Text>
          <MarketText variant="muted">{order.delivery.phone}</MarketText>
        </View>
        {call ? <View style={{ minWidth: 96 }}><MarketLinkButton tone="primary" icon="phone" label="Call" name={`Call ${order.delivery.name}`} href={call} /></View> : null}
      </View>
      {!call ? <MarketText variant="muted">This phone number can't be dialled. Check it before calling.</MarketText> : null}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}><MarketIcon name="pin" color={colors.muted} nudge={3} /><View style={{ flex: 1, gap: 2 }}>
          {order.address ? <>
            <MarketText variant="muted">{addressTitle(order.address)}</MarketText>
            <MarketText>{order.address.house}</MarketText>
            <MarketText>{order.address.streetArea}</MarketText>
            {order.address.landmark ? <MarketText variant="muted">{`Landmark: ${order.address.landmark}`}</MarketText> : null}
          </> : <MarketText>{order.delivery.addressLine}</MarketText>}
          {pinDistance ? <MarketText variant="muted">{pinDistance}</MarketText> : null}
        </View></View>
        <RemoteOrderFlag order={order} hint />
        {maps ? <MarketLinkButton external icon="map" label="Open in Maps" href={maps} /> : null}
      </View>
    </MarketSection>
    <MarketSection title="Items">
      {order.lines.map((line, index) => <View key={`${line.menuItemId}-${index}`} style={{ gap: 4 }}><MarketLine left={<><Text style={{ fontWeight: '700' }}>{line.quantity}</Text>{` × ${line.name}`}</>} right={formatINRFromPaise(line.lineTotalPaise)} /><DietMark diet={line.diet} /></View>)}
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, borderStyle: 'dashed', paddingTop: 10, gap: 4 }}>
        <MarketLine left="Items" right={formatINRFromPaise(order.subtotalPaise)} />
        <MarketLine left="Delivery" right={formatINRFromPaise(order.deliveryFeePaise)} />
        {order.discountPaise ? <MarketLine left={discountLabel(order.offer)} right={minus(order.discountPaise)} /> : null}
      </View>
      <View style={{ padding: 12, borderRadius: 12, backgroundColor: colors.tint }}><MarketLine bold left="Collect in cash" right={<Text style={{ color: colors.ink, fontSize: 22, lineHeight: 28, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{formatINRFromPaise(order.totalPaise)}</Text>} /></View>
    </MarketSection>
    <MarketSection title="History">
      {historyNewestFirst(order.history).map((entry, index) => <MarketLine key={index} left={historyLine(entry)} right={clockTime(entry.createdAtISO)} />)}
      {!order.history?.length ? <MarketText variant="muted">No history available.</MarketText> : null}
    </MarketSection>
    {confirming ? <AccessiblePanel sheet owner title={`Cancel order ${reference}?`} onClose={closeSheet}>
      <MarketText>{`${order.delivery.name}'s order for ${formatINRFromPaise(order.totalPaise)} will be cancelled, and it will show as cancelled in their app. This can't be undone.`}</MarketText>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
        <MarketIcon name="phone" color={colors.primary} nudge={3} />
        <View style={{ flex: 1 }}><MarketText>A quick call to say why helps, for example if a dish has run out.</MarketText></View>
      </View>
      <ActionButton roomy tone="danger" label={busy ? 'Cancelling…' : 'Cancel the order'} disabled={locked} onPress={() => { setConfirming(false); run('cancelled'); }} />
      <ActionButton roomy label="Keep the order" disabled={busy} onPress={closeSheet} />
    </AccessiblePanel> : null}
  </AccessiblePanel>;
}
