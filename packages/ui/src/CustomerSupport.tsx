import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Linking, Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise, type BusinessSlug, type Order } from '@market/core';
import { useIsFocused } from '@react-navigation/native';
import type { useMarket } from './useMarket';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { useMarketTheme } from './theme';
import { supportConfig, supportLinks } from './support-model';
import { useSupportOrders } from './useSupportOrders';
import { orderName } from './CustomerOrderStatus';
import { sameIdentity, type Identity } from './checkout-state';

function SupportHeading({ children }: { children: string }) {
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
  return <Text ref={heading} accessibilityRole="header" aria-level={1} {...(Platform.OS === 'web' ? { tabIndex: -1 } as object : {})} style={{ color: colors.ink, fontSize: 30, lineHeight: 38, fontWeight: '700' }}>{children}</Text>;
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
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      <View style={{ flexGrow: 1 }}><MarketButton label="Call restaurant" disabled={!links.call} onPress={() => { if (links.call) void open(links.call); }} /></View>
      {links.whatsapp ? <View style={{ flexGrow: 1 }}><MarketButton label="WhatsApp restaurant" variant="secondary" onPress={() => void open(links.whatsapp!)} /></View> : null}
    </View>
    {!links.call ? <MarketText variant="muted">Contact number not available yet.</MarketText> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
  </View>;
}
export function CustomerSupport({ businessId, market, go, orderReference }: { businessId: BusinessSlug; market: ReturnType<typeof useMarket>; go: (path: string) => void; orderReference?: string }) {
  const { colors, name } = useMarketTheme();
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
  return <View style={{ gap: 24, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
    <View style={{ gap: 8 }}><SupportHeading>Help &amp; support</SupportHeading><MarketText variant="muted">Questions about your order? Get in touch with {name}.</MarketText></View>
    {currentReference ? <View style={{ gap: 4 }}><MarketText variant="muted">You opened Help for this order reference:</MarketText><Text selectable style={{ color: colors.ink, fontSize: 14, lineHeight: 22 }}>{openedReference}</Text><MarketText variant="muted">Share this reference when asking about that order. The selected active order below is labeled separately.</MarketText></View> : null}
    <MarketCard>
      <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '700' }}>Contact the restaurant</Text>
      {!market.authReady ? <MarketStatus kind="loading" title="Checking your account" /> : !market.session ? <><MarketText>Sign in to see your active orders. You can still read common questions and contact information here.</MarketText><MarketButton label="Sign in to see orders" variant="secondary" onPress={() => go('/login')} /></> : null}
      {market.session && (!support.ready && !support.error || support.loading) ? <MarketStatus kind="loading" title={support.ready ? 'Refreshing active orders' : 'Loading active orders'} /> : null}
      {market.session && support.error ? <MarketStatus kind="error" title="Could not update active orders" message={support.error} action={<MarketButton label="Retry active orders" onPress={() => void support.refresh()} />} /> : null}
      {market.session && support.ready && !order && !support.error ? <MarketText>No active orders right now. You can still contact the restaurant with a question.</MarketText> : null}
      {order ? <View nativeID="support-order" style={{ gap: 10 }}>
        <MarketText variant="eyebrow">Selected active order</MarketText>
        <View style={{ gap: 3 }}><MarketText variant="muted">Order reference</MarketText><Text selectable style={{ color: colors.ink, fontSize: 14, lineHeight: 22 }}>{orderName(order)}</Text></View>
        <View role="status" accessibilityLiveRegion="polite"><MarketText>Status: {order.status.replaceAll('_', ' ')}</MarketText></View>
        {order.lines.map((line, i) => <MarketText key={`${line.menuItemId}-${i}`}>{line.quantity} × {line.name} · {formatINRFromPaise(line.lineTotalPaise)}</MarketText>)}
        <MarketText>Total: {formatINRFromPaise(order.totalPaise)}</MarketText>
        <MarketButton label="View selected order" variant="secondary" onPress={() => go(`/orders/${order.id}`)} />
      </View> : null}
      <ContactActions businessId={businessId} />
      <MarketText variant="muted">{config.notice}</MarketText>
      {market.session ? <MarketButton label="Refresh active orders" variant="secondary" disabled={support.loading || support.moreLoading} onPress={() => void support.refresh()} /> : null}
      {support.orders.length > 1 ? <View style={{ gap: 8 }}><MarketText variant="muted">Choose another active order</MarketText>{support.orders.map(candidate => <Pressable key={candidate.id} accessibilityRole="button" accessibilityLabel={`Select order reference ${orderName(candidate)}`} accessibilityState={{ selected: candidate.id === order?.id }} aria-pressed={candidate.id === order?.id} onPress={() => support.select(candidate.id)} style={{ minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 12, borderColor: colors.primary, backgroundColor: candidate.id === order?.id ? colors.tint : colors.surface }}><Text style={{ color: colors.ink, fontWeight: '700' }}>{orderName(candidate)}</Text><MarketText variant="muted">{candidate.status.replaceAll('_', ' ')} · {formatINRFromPaise(candidate.totalPaise)}</MarketText></Pressable>)}</View> : null}
      {support.moreError ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{support.moreError}</Text> : null}
      {support.cursor ? <MarketButton label={support.moreLoading ? 'Loading more active orders…' : support.moreError ? 'Retry more active orders' : 'Load more active orders'} variant="secondary" disabled={support.loading || support.moreLoading} onPress={() => void support.loadMore()} /> : null}
      <View role="status" accessibilityLiveRegion="polite"><MarketText variant="muted">{support.selectionNotice}</MarketText></View>
    </MarketCard>
    <View style={{ gap: 8 }}><Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 22, lineHeight: 29, fontWeight: '700' }}>Common questions</Text>
      {config.questions.map(question => {
        const open = expanded === question.id;
        return <View key={question.id} style={{ borderBottomWidth: 1, borderColor: colors.border, paddingVertical: 4 }}><Pressable nativeID={`faq-${question.id}`} accessibilityRole="button" accessibilityLabel={question.question} accessibilityState={{ expanded: open }} aria-expanded={open} aria-controls={`faq-answer-${question.id}`} onPress={() => setExpanded(open ? null : question.id)} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 16, paddingVertical: 12 }}><Text style={{ flex: 1, color: colors.ink, fontSize: 16, lineHeight: 24, fontWeight: '700' }}>{question.question}</Text><Text aria-hidden accessibilityElementsHidden importantForAccessibility="no" style={{ color: colors.primary, fontSize: 22 }}>{open ? '−' : '+'}</Text></Pressable>{open ? <View nativeID={`faq-answer-${question.id}`} role="region" aria-labelledby={`faq-${question.id}`} style={{ paddingBottom: 16 }}><MarketText>{question.answer}</MarketText></View> : null}</View>;
      })}
    </View>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}><MarketButton label="Privacy policy" variant="secondary" onPress={() => go('/privacy')} /><MarketButton label="Terms" variant="secondary" onPress={() => go('/terms')} /></View>
  </View>;
}
export function CustomerLegal({ businessId, kind, go }: { businessId: BusinessSlug; kind: 'privacy' | 'terms'; go: (path: string) => void }) {
  const { colors } = useMarketTheme();
  return <View style={{ gap: 24, maxWidth: 720, width: '100%', alignSelf: 'center' }}><SupportHeading>{kind === 'privacy' ? 'Privacy policy' : 'Terms'}</SupportHeading><MarketText variant="eyebrow">Draft · owner review required before deployment</MarketText>{supportConfig[businessId][kind].map(section => <View key={section.heading} style={{ gap: 8 }}><Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '700' }}>{section.heading}</Text><MarketText>{section.text}</MarketText></View>)}<MarketButton label="Back to Help & support" variant="secondary" onPress={() => go('/help')} /></View>;
}
