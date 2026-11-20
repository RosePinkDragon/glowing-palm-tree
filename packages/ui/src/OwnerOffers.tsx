import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MarketServices, OwnerOffer } from '@market/services';
import { MarketButton, MarketStatus } from './components';
import { MarketIcon } from './MarketIcons';
import { MarketPill } from './MarketChips';
import { MarketGroup, MarketRow } from './MarketList';
import { OwnerOfferForm } from './OwnerOfferForm';
import { offerApplied, offerGroups, offerSummary, offerUsage, statusLabels, statusTones } from './offers-model';
import { useMarketFonts, useMarketTheme } from './theme';

// Owners' Offers (#182 slice B), opened from Settings. Active and scheduled offers first, then paused, then ended.
// Create, edit, pause, resume and end happen in the offer form; offers are never deleted.
type Load = { kind: 'loading' } | { kind: 'ready'; offers: OwnerOffer[] } | { kind: 'error' };
// A fresh key on every open and reload, so the form starts from the latest copy (a redemption locks terms without changing the offer's version).
type Editing = { offer?: OwnerOffer; key: number } | null;

export function OwnerOffers({ services, onBack, backLabel = 'Back to Settings' }: { services: MarketServices; onBack: () => void; backLabel?: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState('');
  const requestId = useRef(0);
  const opened = useRef(0);

  const reload = useCallback(async (quiet = false): Promise<OwnerOffer[] | null> => {
    const id = ++requestId.current;
    if (!quiet) setLoad({ kind: 'loading' });
    try {
      const offers = await services.listOffers();
      if (id !== requestId.current) return null;
      setLoad({ kind: 'ready', offers }); return offers;
    } catch {
      // Never show the raw server text: it is for logs, not for owners.
      if (id === requestId.current) setLoad({ kind: 'error' });
      return null;
    }
  }, [services]);
  useEffect(() => { void reload(); return () => { requestId.current++; }; }, [reload]);

  const saved = (_offer: OwnerOffer, note: string) => { setEditing(null); setNotice(note); void reload(true); };
  /** Stale or locked: show the latest copy of the same offer, or say it is gone. */
  const reopen = async (id: string) => {
    const offers = await reload(true);
    const fresh = offers?.find(offer => offer.id === id);
    if (fresh) { setEditing({ offer: fresh, key: ++opened.current }); setNotice(''); }
    else if (offers) { setEditing(null); setNotice('That offer is no longer available.'); }
  };
  const open = (offer?: OwnerOffer) => { setNotice(''); setEditing({ offer, key: ++opened.current }); };

  const body = (size = 15) => ({ color: colors.ink, fontSize: size, lineHeight: Math.round(size * 1.45), ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const ready = load.kind === 'ready';

  return <View style={{ flex: 1 }}>
    <View style={{ backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border, paddingTop: insets.top }}>
      <View style={{ width: '100%', maxWidth: 600, alignSelf: 'center', minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}><MarketIcon name="back" color={colors.ink} size={22} /></Pressable>
        <Text accessibilityRole="header" aria-level={1} numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 24, lineHeight: 32, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>Offers</Text>
        {ready ? <Pressable accessibilityRole="button" accessibilityLabel="New offer" onPress={() => open()} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.primary, opacity: pressed ? 0.8 : 1 })}>
          <Text style={{ color: colors.onPrimary, fontSize: 15, ...bold }}>+ New offer</Text>
        </Pressable> : null}
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 24, gap: 24 }}>
      {notice ? <Text role="status" accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...body(15), color: colors.positive, ...bold }}>{notice}</Text> : null}
      {load.kind === 'loading' ? <MarketStatus kind="loading" title="Loading offers" /> : null}
      {load.kind === 'error' ? <MarketStatus kind="error" title="Couldn't load offers" message="Check your connection and try again." action={<MarketButton label="Try again" onPress={() => void reload()} />} /> : null}
      {load.kind === 'ready' && !load.offers.length ? <MarketStatus kind="empty" title="No offers yet" message="Offers give customers a discount automatically or with a code you share." action={<MarketButton label="Create an offer" onPress={() => open()} />} /> : null}
      {load.kind === 'ready' && load.offers.some(offer => !offer.usageKnown) ? <View role="status" accessibilityRole="text" style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: colors.warningTint }}>
        <Text style={{ ...body(15), color: colors.warning, ...bold }}>Usage couldn't be loaded, so counts are hidden. You can still pause, resume and end offers.</Text>
        <MarketButton label="Reload usage" variant="secondary" onPress={() => void reload()} />
      </View> : null}
      {load.kind === 'ready' ? offerGroups(load.offers).map(group => <MarketGroup key={group.key} inset title={group.title}>
        {group.offers.map(offer => <Pressable key={offer.id} accessibilityRole="button" accessibilityLabel={`${offer.name}, ${statusLabels[offer.status]}, ${offerSummary(offer)}, ${offerApplied(offer)}, ${offerUsage(offer)}`} accessibilityHint="Opens the offer" onPress={() => open(offer)}
          style={({ pressed }) => ({ backgroundColor: pressed ? colors.tint : 'transparent' })}>
          <MarketRow roomy title={offer.name} detail={`${offerSummary(offer)} · ${offerApplied(offer)}\n${offerUsage(offer)}`}
            end={<View style={{ alignItems: 'flex-end', gap: 8 }}><MarketPill label={statusLabels[offer.status]} tone={statusTones[offer.status]} dot /><MarketIcon name="chevronRight" color={colors.muted} /></View>} />
        </Pressable>)}
      </MarketGroup>) : null}
    </ScrollView>
    {editing ? <OwnerOfferForm key={editing.key} services={services} offer={editing.offer} onClose={() => setEditing(null)} onSaved={saved} onReload={id => void reopen(id)} /> : null}
  </View>;
}
