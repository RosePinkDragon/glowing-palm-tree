import { useEffect, useMemo, useRef, useState, type ComponentRef, type MutableRefObject, type RefObject } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import { MAX_QUANTITY, formatINRFromPaise, type BusinessSlug, type CartLine, type MenuItem } from '@market/core';
import { MarketButton, MarketStatus } from './components';
import { DietMark } from './DietMark';
import { DishPhoto } from './DishPhoto';
import { MarketIcon } from './MarketIcons';
import { activeSectionId, customerSections, featuredLabel, featuredMenuItems, gridColumns, searchMenuItems } from './menu-model';
import { useMarketFonts, useMarketTheme } from './theme';

const gap = 14, maxCart = MAX_QUANTITY, chipTarget = 44;
/** Scroll position reported by the screen's ScrollView, so the menu can highlight the category being read. */
export type MenuViewport = { y: number; height: number; contentHeight: number };
type Controls = { orderingAllowed: boolean; demo: boolean; locked: boolean; quantity: (item: MenuItem) => number; onAdd: (item: MenuItem) => void; onRemove: (item: MenuItem) => void; onOpen: (item: MenuItem) => void; viewportRevision: number };
type Focusable = { focus?: () => void } | null;

function useFamilies() {
  const fonts = useMarketFonts();
  const semi = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) });
  const heading = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) });
  const body = (size: number, lineHeight: number) => ({ fontSize: size, lineHeight, ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  return { semi, heading, body };
}

/** "+ Add" until the dish is in the cart, then a -/quantity/+ stepper. Focus follows the control that replaced the one pressed. */
function DishAction({ item, controls, wide = false }: { item: MenuItem; controls: Controls; wide?: boolean }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const { orderingAllowed, demo, locked, onAdd, onRemove } = controls;
  const quantity = controls.quantity(item);
  const example = demo || item.isDemo;
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
      style={({ pressed }) => ({ minHeight: chipTarget, minWidth: wide ? 112 : undefined, borderRadius: 12, borderWidth: 1.5, borderColor: colors.primary, backgroundColor: wide ? colors.primary : colors.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14, opacity: locked ? 0.5 : pressed ? 0.8 : 1 })}>
      <Text accessible={false} style={{ color: wide ? colors.onPrimary : colors.primary, ...f.semi(15, 22) }}>+ Add</Text>
    </Pressable>;
  }
  const button = (label: string, icon: 'plus' | 'minus', disabled: boolean, onPress: () => void, ref?: RefObject<Focusable>) => <Pressable ref={ref as never} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ width: chipTarget, minHeight: chipTarget, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.75 : 1 })}><MarketIcon name={icon} color={colors.onPrimary} size={18} /></Pressable>;
  return <View accessibilityRole="group" accessibilityLabel={`${item.name} quantity`} style={{ minHeight: chipTarget, borderRadius: 12, backgroundColor: colors.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minWidth: wide ? 132 : undefined }}>
    {button(`Remove one ${item.name}`, 'minus', locked, () => { if (quantity === 1) request('add'); onRemove(item); })}
    <Text accessibilityLabel={`${quantity} in cart`} accessibilityLiveRegion="polite" style={{ color: colors.onPrimary, minWidth: 24, textAlign: 'center', ...f.semi(16, 22) }}>{quantity}</Text>
    {button(`Add one ${item.name}`, 'plus', locked || !orderingAllowed || quantity >= maxCart, () => onAdd(item), plus)}
  </View>;
}

function NameAndPrice({ item, controls, size }: { item: MenuItem; controls: Controls; size: number }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  return <>
    <Text accessibilityRole="header" aria-level={3} onPress={() => controls.onOpen(item)} style={{ color: colors.ink, ...f.heading(size, size + 6) }}>{item.name}</Text>
    {item.isDemo ? <Text style={{ color: colors.primary, letterSpacing: 1, textTransform: 'uppercase', ...f.semi(11, 16) }}>Example</Text> : null}
    <Text style={{ color: colors.ink, ...f.semi(16, 22) }}>{item.isDemo ? 'Example price: ' : ''}{formatINRFromPaise(item.pricePaise)}</Text>
  </>;
}

function DishCard({ item, controls, width }: { item: MenuItem; controls: Controls; width: number }) {
  const { colors } = useMarketTheme();
  return <View style={{ width, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 18, overflow: 'hidden' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`View details for ${item.name}`} onPress={() => controls.onOpen(item)}>
      <DishPhoto key={item.imageUrl ?? 'placeholder'} item={item} height={width < 200 ? 118 : 150} viewportRevision={controls.viewportRevision} />
    </Pressable>
    <View style={{ padding: 12, gap: 6, flex: 1 }}>
      <DietMark diet={item.diet} compact />
      <View style={{ flex: 1, gap: 6 }}><NameAndPrice item={item} controls={controls} size={17} /></View>
      <View style={{ marginTop: 4 }}><DishAction item={item} controls={controls} /></View>
    </View>
  </View>;
}

function SpecialCard({ item, controls, width, label }: { item: MenuItem; controls: Controls; width: number | string; label: string }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  return <View style={{ width: width as number, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 22, overflow: 'hidden' }}>
    <Text accessibilityRole="header" aria-level={2} style={{ position: 'absolute', top: 12, left: 12, zIndex: 1, overflow: 'hidden', borderRadius: 10, backgroundColor: colors.surface, color: colors.primary, paddingHorizontal: 10, paddingVertical: 4, letterSpacing: 1.2, textTransform: 'uppercase', ...f.semi(12, 18) }}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`View details for ${item.name}`} onPress={() => controls.onOpen(item)}>
      <DishPhoto key={item.imageUrl ?? 'placeholder'} item={item} height={190} viewportRevision={controls.viewportRevision} />
    </Pressable>
    <View style={{ padding: 16, gap: 6, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <View style={{ flex: 1, gap: 6 }}>
        <DietMark diet={item.diet} compact />
        <NameAndPrice item={item} controls={controls} size={22} />
        {item.description ? <Text numberOfLines={2} style={{ color: colors.muted, ...f.body(14, 20) }}>{item.description}</Text> : null}
      </View>
      <View style={{ width: 132 }}><DishAction item={item} controls={controls} wide /></View>
    </View>
  </View>;
}

const reducedMotion = () => Platform.OS === 'web' && typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Ammu Sammu menu (design p. 3): search, Today's special (dishes the owner marked featured and available),
 * sticky category chips that jump to and follow the sections, and a photo grid with + Add / stepper.
 */
export function PhotoMenu({ businessId, items, cart, contentWidth, bleed, orderingAllowed, demo, locked, viewportRevision, scrollRef, viewportListener, message, onDismissMessage, onAdd, onRemove, onOpen }: {
  businessId: BusinessSlug; items: readonly MenuItem[]; cart: readonly CartLine[]; contentWidth: number; bleed: number; orderingAllowed: boolean; demo: boolean; locked: boolean; viewportRevision: number;
  scrollRef: RefObject<ComponentRef<typeof ScrollView> | null>; viewportListener: MutableRefObject<((viewport: MenuViewport) => void) | null>;
  /** Cart error from the last add/remove (e.g. the 20-dish limit), shown with the sticky chips so it is seen wherever the customer is in the grid. */
  message: string; onDismissMessage: () => void;
  onAdd: (item: MenuItem) => void; onRemove: (item: MenuItem) => void; onOpen: (item: MenuItem) => void;
}) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [chipsHeight, setChipsHeight] = useState(64);
  const sections = useMemo(() => customerSections(items, query), [items, query]);
  const specials = useMemo(() => featuredMenuItems(searchMenuItems(items, query)), [items, query]);
  const quantities = useMemo(() => new Map(cart.map(line => [line.item.id, line.quantity])), [cart]);
  const controls: Controls = { orderingAllowed, demo, locked, quantity: item => quantities.get(item.id) ?? 0, onAdd, onRemove, onOpen, viewportRevision };
  const columns = gridColumns(contentWidth);
  const cardWidth = Math.floor((contentWidth - gap * (columns - 1)) / columns);
  const searching = query.trim().length > 0;
  const found = sections.reduce((total, section) => total + section.items.length, 0);

  // Section tops in scroll-content coordinates: this view, the sections wrapper and each section report their own offset.
  const layout = useRef({ root: 0, inner: 0, wrap: 0, sections: {} as Record<string, number>, chips: {} as Record<string, number> });
  const lockUntil = useRef(0);
  const chipScroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const tops = () => sections.map(section => ({ id: section.id, top: layout.current.root + layout.current.inner + layout.current.wrap + (layout.current.sections[section.id] ?? 0) }));
  const follow = (id: string | null) => { setActive(id); const x = id ? layout.current.chips[id] : 0; if (x !== undefined) chipScroll.current?.scrollTo({ x: Math.max(0, x - 24), animated: !reducedMotion() }); };
  const lastViewport = useRef<MenuViewport | null>(null);
  const update = ({ y, height, contentHeight }: MenuViewport) => {
    if (Date.now() < lockUntil.current || !sections.length) return;
    const atEnd = contentHeight > height && y + height >= contentHeight - 4;
    const next = atEnd && y > 0 ? sections[sections.length - 1]!.id : activeSectionId(tops(), y + chipsHeight + 12);
    if (next !== active) follow(next);
  };
  viewportListener.current = viewport => { lastViewport.current = viewport; update(viewport); };
  const settled = useRef(update); settled.current = update;
  useEffect(() => () => { viewportListener.current = null; }, [viewportListener]);
  // A search can remove the highlighted section.
  useEffect(() => { if (active && !sections.some(section => section.id === active)) setActive(null); }, [active, sections]);
  const jump = (id: string | null) => {
    // Ignore the scroll events of the animated jump, then re-read the final position.
    lockUntil.current = Date.now() + 900;
    setTimeout(() => { if (lastViewport.current) settled.current(lastViewport.current); }, 950);
    follow(id);
    const target = id === null ? 0 : Math.max(0, tops().find(entry => entry.id === id)!.top - chipsHeight - 12);
    scrollRef.current?.scrollTo({ y: target, animated: !reducedMotion() });
  };
  const layoutY = (event: LayoutChangeEvent) => event.nativeEvent.layout.y;
  const sticky = Platform.OS === 'web' ? ({ position: 'sticky', top: 0 } as object) : null;
  const pad = bleed;
  const chip = (id: string | null, name: string, label: string) => {
    const selected = active === id;
    return <Pressable key={id ?? 'all'} accessibilityRole="button" accessibilityLabel={label} aria-pressed={selected} accessibilityState={{ selected }} onPress={() => jump(id)} onLayout={event => { if (id) layout.current.chips[id] = event.nativeEvent.layout.x; }}
      style={{ minHeight: chipTarget, justifyContent: 'center', paddingHorizontal: 18, borderRadius: 22, borderWidth: 1, borderColor: selected ? colors.ink : colors.border, backgroundColor: selected ? colors.ink : colors.surface }}>
      <Text accessible={false} style={{ color: selected ? '#FFFFFF' : colors.ink, ...f.semi(15, 22) }}>{name}</Text>
    </Pressable>;
  };

  return <View onLayout={event => { layout.current.root = layoutY(event); }} style={{ gap: 18, paddingBottom: cart.length ? 64 : 0 }}>
    <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 14, backgroundColor: colors.surface, paddingLeft: 14 }}>
      <MarketIcon name="search" color={colors.muted} size={18} />
      <TextInput accessibilityLabel="Search dishes" placeholder="Search dishes" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} returnKeyType="search" autoCorrect={false} autoCapitalize="none"
        style={[{ flex: 1, minHeight: 46, paddingHorizontal: 10, color: colors.ink, fontSize: 16 }, f.body(16, 22) as object]} />
      {searching ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={{ width: chipTarget, minHeight: chipTarget, alignItems: 'center', justifyContent: 'center' }}><MarketIcon name="close" color={colors.ink} size={18} /></Pressable> : null}
    </View>
    {searching ? <Text accessibilityLiveRegion="polite" style={{ color: colors.muted, marginTop: -8, ...f.body(14, 20) }}>{found === 0 ? 'No dishes found' : `${found} ${found === 1 ? 'dish' : 'dishes'} found`}</Text> : null}
    {specials.length ? <View nativeID="featured-menu" style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
      {specials.map(item => <SpecialCard key={item.id} item={item} controls={controls} label={featuredLabel(businessId, 'customer')} width={columns >= 3 ? cardWidth * 2 + gap : '100%'} />)}
    </View> : null}
    {sections.length ? <View onLayout={event => { layout.current.inner = layoutY(event); }} style={{ gap: 18 }}>
      <View onLayout={event => setChipsHeight(Math.round(event.nativeEvent.layout.height))} style={[{ zIndex: 5, marginHorizontal: -pad, paddingHorizontal: pad, paddingVertical: 8, backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border }, sticky]}>
        <ScrollView ref={chipScroll} horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingRight: pad }}>
          {chip(null, 'All', 'All dishes')}{sections.map(section => chip(section.id, section.name, section.name))}
        </ScrollView>
        {message ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingLeft: 12, borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.danger }}>
          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ flex: 1, paddingVertical: 8, color: colors.danger, ...f.semi(14, 20) }}>{message}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss message" onPress={onDismissMessage} style={{ width: chipTarget, minHeight: chipTarget, alignItems: 'center', justifyContent: 'center' }}><MarketIcon name="close" color={colors.ink} size={18} /></Pressable>
        </View> : null}
      </View>
      <View nativeID="regular-menu" onLayout={event => { layout.current.wrap = layoutY(event); }} style={{ gap: 26 }}>
        {sections.map(section => <View key={section.id} onLayout={event => { layout.current.sections[section.id] = layoutY(event); }} style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text accessibilityRole="header" aria-level={2} style={{ color: colors.ink, ...f.heading(24, 31) }}>{section.name}</Text>
            <Text style={{ color: colors.muted, ...f.body(14, 20) }}>{section.items.length} {section.items.length === 1 ? 'item' : 'items'}</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>{section.items.map(item => <DishCard key={item.id} item={item} controls={controls} width={cardWidth} />)}</View>
        </View>)}
      </View>
    </View> : searching ? <MarketStatus kind="empty" title={`No dishes match “${query.trim()}”`} message="Check the spelling or try a shorter name." action={<MarketButton label="Clear search" variant="secondary" onPress={() => setQuery('')} />} />
      : <MarketStatus kind="empty" title="No menu items yet" message="Please check back later." />}
  </View>;
}
