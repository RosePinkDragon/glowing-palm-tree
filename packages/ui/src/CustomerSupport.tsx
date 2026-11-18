import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Linking, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type BusinessSlug, type Order } from '@market/core';
import { useIsFocused } from '@react-navigation/native';
import type { useMarket } from './useMarket';
import { MarketButton, MarketStatus, MarketText } from './components';
import { brandPlace } from './CustomerBrand';
import { MarketIcon } from './MarketIcons';
import { useFamilies } from './DishAction';
import { useMarketTheme } from './theme';
import { supportConfig, supportLinks } from './support-model';
import { useSupportOrders } from './useSupportOrders';
import { orderName } from './CustomerOrderStatus';
import { sameIdentity, type Identity } from './checkout-state';

/** `hidden`: Help's visible title is the screen header; this stays as the focus target and the page's h1 for assistive technology. */
const srOnly = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 } as const;
function SupportHeading({ children, hidden = false }: { children: string; hidden?: boolean }) {
  const { colors } = useMarketTheme();
  const heading = useRef<ComponentRef<typeof Text>>(null);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    const timer = setTimeout(() => {
      if (Platform.OS === 'web') (heading.current as unknown as HTMLElement | null)?.focus();
      else { const handle = findNodeHandle(heading.current); if (handle != null) AccessibilityInfo.setAccessibilityFocus(handle); }
    }, 0);
    return () => clearTimeout(timer);
  }, [focused]);
  return <Text ref={heading} accessibilityRole="header" aria-level={1} {...(Platform.OS === 'web' ? { tabIndex: -1 } as object : {})} style={hidden ? srOnly : { color: colors.ink, fontSize: 30, lineHeight: 38, fontWeight: '700' }}>{children}</Text>;
}
function ContactActions({ businessId }: { businessId: BusinessSlug }) {
  const { colors } = useMarketTheme();
  const [error, setError] = useState('');
  const links = supportLinks(supportConfig[businessId]);
  const open = async (url: string) => {
    setError('');
    try { await Linking.openURL(url); }
    catch { setError('Could not open the contact app. Please try again on a device with a phone or WhatsApp app.'); }
  };
  const f = useFamilies();
  const action = (label: string, visible: string, icon: 'phone' | 'chat', filled: boolean, disabled: boolean, onPress: () => void) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: filled ? colors.primary : colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 10, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 })}>
    <MarketIcon name={icon} color={filled ? colors.onPrimary : colors.primary} size={18} />
    <Text accessible={false} style={{ color: filled ? colors.onPrimary : colors.primary, ...f.semi(15, 22) }}>{visible}</Text>
  </Pressable>;
  return <View style={{ gap: 10 }}>
    <View nativeID="support-contacts" style={{ flexDirection: 'row', gap: 10 }}>
      {action('Call restaurant', 'Call', 'phone', true, !links.call, () => { if (links.call) void open(links.call); })}
      {links.whatsapp ? action('WhatsApp restaurant', 'WhatsApp', 'chat', false, false, () => void open(links.whatsapp!)) : null}
    </View>
    {!links.call ? <MarketText variant="muted">Contact number not available yet.</MarketText> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
  </View>;
}
export function CustomerSupport({ businessId, market, go, orderReference }: { businessId: BusinessSlug; market: ReturnType<typeof useMarket>; go: (path: string) => void; orderReference?: string }) {
  const { colors, name, menuLayout } = useMarketTheme();
  const f = useFamilies();
  const origin = useRef<{ reference?: string; identity: Identity | null }>({ reference: orderReference, identity: null });
  if (origin.current.reference !== orderReference) origin.current = { reference: orderReference, identity: null };
  if (!origin.current.identity && market.authReady && market.session) origin.current.identity = market.identity.current;
  const currentReference = market.authReady && market.session && origin.current.identity && sameIdentity(origin.current.identity, market.identity.current) ? orderReference : undefined;
  const support = useSupportOrders(market, currentReference);
  // The opened order may be delivered or cancelled, so it is not in the active list: read that one own-row order by id.
  const [opened, setOpened] = useState<Order | null>(null);
  const activeMatch = currentReference ? support.orders.find(candidate => candidate.id === currentReference) : undefined;
  const { services } = market;
  useEffect(() => {
    setOpened(null);
    if (!currentReference || activeMatch) return;
    let stale = false;
    void services.getCustomerOrder(currentReference).then(found => { if (!stale && found?.id === currentReference) setOpened(found); }).catch(() => undefined);
    return () => { stale = true; };
  }, [currentReference, services, !!activeMatch]);
  // Never show the raw id: the order number once known, else the short reference.
  const openedReference = currentReference ? orderName(activeMatch ?? opened ?? { id: currentReference }) : '';
  const [expanded, setExpanded] = useState<string | null>(null);
  const config = supportConfig[businessId];
  const order = support.selected;
  const pill = menuLayout === 'carta' ? { fill: colors.band, text: '#FFFFFF', dot: colors.bandAccent } : { fill: colors.warningTint, text: colors.warning, dot: colors.warning };
  return <View style={{ gap: 20, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
    <SupportHeading hidden>Help &amp; support</SupportHeading>
    {currentReference ? <View style={{ gap: 4 }}><MarketText variant="muted">You opened Help for this order reference:</MarketText><Text selectable style={{ color: colors.ink, fontSize: 14, lineHeight: 22 }}>{openedReference}</Text><MarketText variant="muted">Share this reference when asking about that order. The selected active order below is labeled separately.</MarketText></View> : null}
    <View nativeID="support-card" style={{ backgroundColor: colors.surface, borderColor: colors.accent, borderWidth: 1.5, borderRadius: 16, padding: 16, gap: 12 }}>
      <Text accessibilityRole="header" style={{ color: colors.ink, ...f.heading(20, 28) }}>Contact the restaurant</Text>
      {!market.authReady ? <MarketStatus kind="loading" title="Checking your account" /> : !market.session ? <><MarketText>Sign in to see your active orders. You can still read common questions and contact information here.</MarketText><MarketButton label="Sign in to see orders" variant="secondary" onPress={() => go('/login')} /></> : null}
      {market.session && (!support.ready && !support.error || support.loading) ? <MarketStatus kind="loading" title={support.ready ? 'Refreshing active orders' : 'Loading active orders'} /> : null}
      {market.session && support.error ? <MarketStatus kind="error" title="Could not update active orders" message={support.error} action={<MarketButton label="Retry active orders" onPress={() => void support.refresh()} />} /> : null}
      {market.session && support.ready && !order && !support.error ? <MarketText>No active orders right now. You can still contact the restaurant with a question.</MarketText> : null}
      {order ? <View nativeID="support-order" style={{ gap: 8 }}>
        <MarketText variant="eyebrow">Selected active order</MarketText>
        <View style={{ gap: 2 }}><MarketText variant="muted">Order reference</MarketText><Text selectable style={{ color: colors.ink, ...f.semi(17, 24) }}>{orderName(order)}</Text></View>
        <View role="status" accessibilityLiveRegion="polite" style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 999, backgroundColor: pill.fill, paddingHorizontal: 12, paddingVertical: 5 }}><View aria-hidden style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: pill.dot }} /><Text style={{ color: pill.text, ...f.semi(14, 20) }}>Status: {order.status.replaceAll('_', ' ')}</Text></View>
        <View style={{ gap: 2 }}>{order.lines.map((line, i) => <MarketText key={`${line.menuItemId}-${i}`} variant="muted">{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText>)}<MarketText variant="muted">Total: {formatINRFromPaise(order.totalPaise)}</MarketText></View>
        <MarketButton label="View selected order" variant="secondary" onPress={() => go(`/orders/${order.id}`)} />
      </View> : null}
      <MarketText>Questions about your order? Get in touch with {name}.</MarketText>
      <ContactActions businessId={businessId} />
      <MarketText variant="muted">{config.notice}</MarketText>
      {market.session ? <MarketButton label="Refresh active orders" variant="secondary" disabled={support.loading || support.moreLoading} onPress={() => void support.refresh()} /> : null}
      {support.orders.length > 1 ? <View style={{ gap: 8 }}><MarketText variant="muted">Choose another active order</MarketText>{support.orders.map(candidate => <Pressable key={candidate.id} accessibilityRole="button" accessibilityLabel={`Select order reference ${orderName(candidate)}`} accessibilityState={{ selected: candidate.id === order?.id }} aria-pressed={candidate.id === order?.id} onPress={() => support.select(candidate.id)} style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: colors.primary, backgroundColor: candidate.id === order?.id ? colors.tint : colors.surface }}><Text style={{ color: colors.ink, fontWeight: '700' }}>{orderName(candidate)}</Text><MarketText variant="muted">{candidate.status.replaceAll('_', ' ')} · {formatINRFromPaise(candidate.totalPaise)}</MarketText></Pressable>)}</View> : null}
      {support.moreError ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{support.moreError}</Text> : null}
      {support.cursor ? <MarketButton label={support.moreLoading ? 'Loading more active orders…' : support.moreError ? 'Retry more active orders' : 'Load more active orders'} variant="secondary" disabled={support.loading || support.moreLoading} onPress={() => void support.loadMore()} /> : null}
      <View role="status" accessibilityLiveRegion="polite"><MarketText variant="muted">{support.selectionNotice}</MarketText></View>
    </View>
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text accessibilityRole="header" aria-level={2} style={{ color: menuLayout === 'carta' ? colors.warning : colors.muted, textTransform: 'uppercase', letterSpacing: 1.5, ...f.semi(12, 18) }}>Common questions</Text>
        {menuLayout === 'carta' ? <View aria-hidden style={{ flex: 1, height: 1, backgroundColor: colors.accent }} /> : null}
      </View>
      <View nativeID="support-faq" style={{ backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 16, paddingHorizontal: 16 }}>
        {config.questions.map((question, index) => {
          const open = expanded === question.id;
          return <View key={question.id} style={{ borderTopWidth: index ? 1 : 0, borderColor: colors.border }}>
            <Pressable nativeID={`faq-${question.id}`} accessibilityRole="button" accessibilityLabel={question.question} accessibilityState={{ expanded: open }} aria-expanded={open} aria-controls={`faq-answer-${question.id}`} onPress={() => setExpanded(open ? null : question.id)} style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 10 }}>
              <Text style={{ flex: 1, color: colors.ink, ...f.semi(16, 24) }}>{question.question}</Text>
              <View aria-hidden accessibilityElementsHidden importantForAccessibility="no"><MarketIcon name={open ? 'chevronUp' : 'chevronDown'} color={colors.ink} size={20} /></View>
            </Pressable>
            {open ? <View nativeID={`faq-answer-${question.id}`} role="region" aria-labelledby={`faq-${question.id}`} style={{ paddingBottom: 14 }}><MarketText>{question.answer}</MarketText></View> : null}
          </View>;
        })}
      </View>
    </View>
    <View nativeID="support-footer" style={{ alignItems: 'center', gap: 2, paddingTop: 4 }}>
      <Text style={{ color: colors.muted, ...f.body(14, 20) }}>{name} · {brandPlace}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Privacy policy" onPress={() => go('/privacy')} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text accessible={false} style={{ color: colors.primary, textDecorationLine: 'underline', ...f.semi(14, 20) }}>Privacy policy</Text></Pressable>
        <Text aria-hidden style={{ color: colors.muted }}>·</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Terms" onPress={() => go('/terms')} style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 8 }}><Text accessible={false} style={{ color: colors.primary, textDecorationLine: 'underline', ...f.semi(14, 20) }}>Terms</Text></Pressable>
      </View>
    </View>
  </View>;
}
export function CustomerLegal({ businessId, kind, go }: { businessId: BusinessSlug; kind: 'privacy' | 'terms'; go: (path: string) => void }) {
  const { colors } = useMarketTheme();
  return <View style={{ gap: 24, maxWidth: 720, width: '100%', alignSelf: 'center' }}><SupportHeading>{kind === 'privacy' ? 'Privacy policy' : 'Terms'}</SupportHeading><MarketText variant="eyebrow">Draft · owner review required before deployment</MarketText>{supportConfig[businessId][kind].map(section => <View key={section.heading} style={{ gap: 8 }}><Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '700' }}>{section.heading}</Text><MarketText>{section.text}</MarketText></View>)}<MarketButton label="Back to Help & support" variant="secondary" onPress={() => go('/help')} /></View>;
}
