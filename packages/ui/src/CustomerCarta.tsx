import { useMemo } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { formatINRFromPaise, type CartLine, type MenuItem } from '@market/core';
import { brandLogos } from './brand-logos';
import { DietMark } from './DietMark';
import { DishAction, menuControls, useFamilies, type Controls } from './DishAction';
import { DishPhoto } from './DishPhoto';
import { carouselCardWidth, featuredLabel, featuredMenuItems, type CustomerSection } from './menu-model';
import { useMarketTheme } from './theme';

const titleLine = 28;
const decorative = { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;
/** Keyboard focus on a half-hidden card brings the whole control into view inside the sideways carousel (web). */
const revealOnFocus = Platform.OS === 'web' ? ({ onFocus: (event: { target?: { scrollIntoView?: (options: object) => void } }) => event.target?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }) } as object) : {};
const priceLabel = (item: MenuItem) => `${item.isDemo ? 'Example price ' : ''}${formatINRFromPaise(item.pricePaise)}`;

/** One dish in the signature carousel: photo, category, name, price and add/stepper on the dark band. */
function SignatureCard({ item, controls, width }: { item: MenuItem; controls: Controls; width: number }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  return <View {...revealOnFocus} style={{ width, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(198,172,112,0.45)', backgroundColor: 'rgba(255,255,255,0.07)' }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`View details for ${item.name}`} onPress={() => controls.onOpen(item)}>
      <DishPhoto key={item.imageUrl ?? 'placeholder'} item={item} height={150} viewportRevision={controls.viewportRevision} />
      <View style={{ position: 'absolute', top: 10, left: 10, borderRadius: 6, backgroundColor: '#FFFFFF', padding: 3 }}><DietMark diet={item.diet} compact /></View>
    </Pressable>
    <View style={{ padding: 14, gap: 6, flex: 1 }}>
      <Text numberOfLines={1} style={{ color: colors.bandAccent, letterSpacing: 1.2, textTransform: 'uppercase', ...f.semi(12, 18) }}>{item.category}{item.isDemo ? ' · Example' : ''}</Text>
      <Text accessibilityRole="header" aria-level={3} onPress={() => controls.onOpen(item)} style={{ flex: 1, color: '#FFFFFF', ...f.heading(21, 30) }}>{item.name}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
        <Text accessibilityLabel={priceLabel(item)} style={{ color: '#FFFFFF', ...f.heading(20, 28) }}>{formatINRFromPaise(item.pricePaise)}</Text>
        <View style={{ minWidth: 112 }}><DishAction item={item} controls={controls} onDark /></View>
      </View>
    </View>
  </View>;
}

/**
 * Kokani Dine Inn menu header (design p. 3): dark band with the brand, then a horizontal carousel of the dishes the owner
 * marked as signature dishes (featured and available). No featured dish, no carousel. Nothing here is invented copy.
 */
export function CartaHeader({ items, cart, contentWidth, edge, orderingAllowed, demo, locked, viewportRevision, onAdd, onRemove, onOpen, name }: {
  items: readonly MenuItem[]; cart: readonly CartLine[]; contentWidth: number; edge: number; orderingAllowed: boolean; demo: boolean; locked: boolean; viewportRevision: number; name: string;
  onAdd: (item: MenuItem) => void; onRemove: (item: MenuItem) => void; onOpen: (item: MenuItem) => void;
}) {
  const { colors, businessId } = useMarketTheme();
  const f = useFamilies();
  const logo = brandLogos[businessId];
  const featured = useMemo(() => featuredMenuItems(items), [items]);
  const controls = menuControls(cart, { orderingAllowed, demo, locked, onAdd, onRemove, onOpen, viewportRevision });
  const width = carouselCardWidth(contentWidth);
  const label = featuredLabel(businessId, 'customer');
  const logoHeight = 64, logoWidth = Math.round(logo.width * logoHeight / logo.height);
  return <View style={{ position: 'relative', gap: 20, paddingTop: 8, paddingBottom: 28 }}>
    {/* Full-bleed band: wider than the centred page column so it spans wide screens. */}
    <View {...decorative} pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: -4000, right: -4000, backgroundColor: colors.band }} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View {...decorative}><SvgXml xml={logo.xml} width={logoWidth} height={logoHeight} /></View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.bandAccent, letterSpacing: 2, textTransform: 'uppercase', ...f.semi(12, 18) }}>Taste of Kokan</Text>
        <Text accessibilityRole="header" aria-level={1} style={{ color: '#FFFFFF', ...f.heading(32, 42) }}>{name}</Text>
      </View>
    </View>
    {featured.length ? <View nativeID="featured-menu" style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Text accessibilityRole="header" aria-level={2} style={{ color: '#FFFFFF', ...f.heading(24, 32) }}>{label}</Text>
        <View {...decorative} style={{ flex: 1, height: 1, backgroundColor: 'rgba(198,172,112,0.5)' }} />
      </View>
      <ScrollView horizontal role="region" aria-label={`${label}, scroll sideways`} accessibilityLabel={`${label}, scroll sideways`} showsHorizontalScrollIndicator={Platform.OS === 'web'} keyboardShouldPersistTaps="handled"
        style={{ marginHorizontal: -edge }} contentContainerStyle={{ gap: 14, paddingHorizontal: edge, paddingBottom: 6 }}>
        {featured.map(item => <SignatureCard key={item.id} item={item} controls={controls} width={width} />)}
      </ScrollView>
    </View> : null}
  </View>;
}

/** One à la carte category: ruled caps heading, then a row per dish. */
export function CartaSection({ section, controls }: { section: CustomerSection; controls: Controls }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  return <View style={{ gap: 4 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 }}>
      <View {...decorative} style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
      <Text accessibilityRole="header" aria-level={3} style={{ color: colors.primary, textAlign: 'center', letterSpacing: 2, textTransform: 'uppercase', ...f.semi(14, 20) }}>{section.name}</Text>
      <View {...decorative} style={{ flex: 1, height: 1, backgroundColor: colors.accent }} />
    </View>
    {section.items.map(item => <CartaRow key={item.id} item={item} controls={controls} />)}
  </View>;
}

/**
 * name ........ price, a dotted leader between them, then the description and the add/stepper control.
 * The leader is decorative and hidden from assistive tech; the name is the heading and the price is its own text,
 * and a transparent button over the title line opens the dish (so keyboard users reach details too).
 */
function CartaRow({ item, controls }: { item: MenuItem; controls: Controls }) {
  const { colors } = useMarketTheme();
  const f = useFamilies();
  const off = !item.isAvailable && !item.isDemo && !controls.demo;
  const ink = off ? colors.muted : colors.ink;
  return <View style={{ paddingVertical: 14, gap: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ flexShrink: 1, flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ height: titleLine, justifyContent: 'center' }}><DietMark diet={item.diet} compact /></View>
        <Text accessibilityRole="header" aria-level={4} style={{ flexShrink: 1, color: ink, ...f.heading(19, titleLine) }}>{item.name}</Text>
      </View>
      <View {...decorative} style={{ flex: 1, minWidth: 14, marginTop: titleLine - 7, borderBottomWidth: 1.5, borderStyle: 'dotted', borderColor: colors.muted }} />
      <Text accessibilityLabel={priceLabel(item)} style={{ flexShrink: 0, color: ink, ...f.heading(19, titleLine) }}>{formatINRFromPaise(item.pricePaise)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`View details for ${item.name}`} onPress={() => controls.onOpen(item)} style={[StyleSheet.absoluteFill, { minHeight: 44 }]} />
    </View>
    {item.isDemo ? <Text style={{ color: colors.primary, letterSpacing: 1, textTransform: 'uppercase', ...f.semi(11, 16) }}>Example</Text> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
      <Text numberOfLines={3} style={{ flexGrow: 1, flexShrink: 1, flexBasis: 170, color: colors.muted, ...f.body(14, 21) }}>{item.description}</Text>
      <DishAction item={item} controls={controls} />
    </View>
  </View>;
}
