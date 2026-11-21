import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { formatINRFromPaise } from '@market/core';
import { ServiceError, type DayOffers, type MarketServices } from '@market/services';
import type { DailySummary } from '@market/core';
import { MarketButton, MarketStatus, MarketText } from './components';
import { MarketGroup, MarketRow, MarketSection } from './MarketList';
import { MarketIcon } from './MarketIcons';
import { dayOffersTotal, formatWindow } from './offers-model';
import { MarketChip } from './MarketChips';
import { useMarketFonts, useMarketTheme } from './theme';
import { useOwnerHorizontalPadding } from './OwnerShell';
import { scopeWord, acceptPickedDate, amountFontSize, minPickedDate, cancelledLabel, chipLabel, collectedHeading, defaultPickedDate, deliveredLabel, deliveredNote, istDateISO, outstandingNote, placedLabel, requestDate, shortDateLabel, stepPickedDate, summaryFooter, todayChips, type TodayChip } from './today-model';

const rupees = (paise: number) => { try { return formatINRFromPaise(paise); } catch { return '₹0'; } };

function Bold({ children, size, color, heading = false }: { children: ReactNode; size: number; color?: string; /** Brand heading face (Eczar), for the cash figures (#114, p. 11). */ heading?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const face = heading && fonts.heading ? { fontFamily: fonts.heading } : fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  return <Text style={{ color: color ?? colors.ink, fontSize: size, lineHeight: Math.round(size * 1.25), ...face }}>{children}</Text>;
}

/** The chosen day. Lives with the owners' shell so the chips can sit in its header; it resets when the Today tab is left. */
export type OwnerTodayDay = { chip: TodayChip; setChip: (chip: TodayChip) => void; picked: string; setPicked: (value: string | ((previous: string) => string)) => void };
export function useOwnerTodayDay(active: boolean): OwnerTodayDay {
  const [chip, setChip] = useState<TodayChip>('today');
  const [picked, setPicked] = useState(() => defaultPickedDate());
  useEffect(() => { if (!active) { setChip('today'); setPicked(defaultPickedDate()); } }, [active]);
  return { chip, setChip, picked, setPicked };
}

/** Today / Yesterday / Pick a date chips for the compact header region, like the Orders filters. */
export function OwnerTodayFilters({ day }: { day: OwnerTodayDay }) {
  const { ownerHeader } = useMarketTheme();
  const padding = useOwnerHorizontalPadding();
  const { chip, picked, setChip, setPicked } = day;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: padding }}>
    <View role="group" aria-label="Choose a day" style={{ flexDirection: 'row', gap: 8 }}>
      {todayChips.map(value => {
        const active = chip === value;
        return <MarketChip key={value} onDark={ownerHeader === 'dark'} selected={active} label={value === 'date' && active ? shortDateLabel(picked) : chipLabel(value, picked)} accessibilityLabel={value === 'date' && active ? `${shortDateLabel(picked)}, picked date` : chipLabel(value, picked)}
          onPress={() => { if (value === 'date' && !active) setPicked(prev => prev || defaultPickedDate()); setChip(value); }} />;
      })}
    </View>
  </ScrollView>;
}

/**
 * Date chooser. On the web it is the browser's own date input (keyboard, screen-reader and mobile-picker support for free,
 * max = today in India). On native, where no date picker ships without a new dependency, it is previous/next-day buttons
 * around the chosen date, which never go beyond today.
 */
function DatePicker({ value, onChange }: { value: string; onChange: (dateISO: string) => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const today = istDateISO();
  if (Platform.OS === 'web') return <View style={{ gap: 6 }}>
    <Text nativeID="today-date-label" style={{ color: colors.muted, fontSize: 14, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>Choose a day</Text>
    {createElement('input', {
      type: 'date', value, max: today, min: minPickedDate(), 'aria-labelledby': 'today-date-label', 'aria-label': 'Choose a day',
      onChange: (event: { target: { value: string } }) => { const next = acceptPickedDate(event.target.value); if (next) onChange(next); },
      style: { minHeight: 48, boxSizing: 'border-box', padding: '0 14px', fontSize: 16, color: colors.ink, backgroundColor: colors.surface, border: `1px solid ${colors.inputBorder}`, borderRadius: 14, fontFamily: fonts.body ?? 'inherit' },
    })}
  </View>;
  return <View role="group" aria-label="Choose a day" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
    <MarketButton label="Previous day" variant="secondary" onPress={() => onChange(stepPickedDate(value, -1))} />
    <View style={{ flex: 1, alignItems: 'center' }}><Bold size={16}>{shortDateLabel(value)}</Bold></View>
    <MarketButton label="Next day" variant="secondary" disabled={value >= today} onPress={() => onChange(stepPickedDate(value, 1))} />
  </View>;
}

function Tile({ label, value }: { label: string; value: number }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <View role="group" aria-label={`${label}: ${value}`} style={{ flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 16, gap: 6, minHeight: 88 }}>
    <Bold size={28}>{String(value)}</Bold>
    <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{label}</Text>
  </View>;
}

/**
 * Offers on the selected day (#182): what was applied to that day's non-cancelled orders, from the orders' own offer snapshots,
 * and for today the active offers nobody has used yet. The header opens the Offers page (also reachable from Settings).
 */
function TodayOffers({ services, date, onOpenOffers }: { services: MarketServices; date: string; onOpenOffers: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; offers: DayOffers }>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    services.getDayOffers(date).then(offers => { if (active) setState({ kind: 'ready', offers }); }, () => { if (active) setState({ kind: 'error' }); });
    return () => { active = false; };
  }, [services, date, attempt]);
  const today = date === istDateISO();
  const note = { color: colors.muted, fontSize: 15, lineHeight: 23, ...(fonts.body ? { fontFamily: fonts.body } : {}) };
  const offers = state.kind === 'ready' ? state.offers : null;
  const running = offers?.running ?? [];
  return <MarketSection>
    <Pressable accessibilityRole="button" accessibilityLabel="Offers" accessibilityHint="Opens your offers" onPress={onOpenOffers} style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', opacity: pressed ? 0.7 : 1 })}>
      <Bold size={18}>Offers</Bold><MarketIcon name="chevronRight" color={colors.muted} />
    </Pressable>
    {state.kind === 'loading' ? <Text style={note}>Loading offers…</Text> : null}
    {state.kind === 'error' ? <View style={{ gap: 10 }}><Text style={note}>Couldn't load offers for this day.</Text><MarketButton label="Try again" variant="secondary" onPress={() => setAttempt(n => n + 1)} /></View> : null}
    {offers ? <View style={{ gap: 12 }}>
      {offers.used.length || running.length ? <MarketGroup>
        {[...offers.used.map(offer => <MarketRow key={offer.offerId} title={offer.name} detail={`${offer.code ? `Code ${offer.code}` : 'Automatic'} · ${offer.uses} ${offer.uses === 1 ? 'use' : 'uses'} · ${rupees(offer.givenPaise)} given`} />),
          ...running.map(offer => <MarketRow key={offer.id} title={offer.name} detail={`${offer.code ? `Code ${offer.code}` : 'Automatic'} · ${offer.state === 'running' ? 'Running · no uses yet' : offer.state === 'outside_window' && offer.window ? `Runs ${formatWindow(offer.window)}` : 'Active'}`} />)]}
      </MarketGroup> : null}
      {offers.used.length ? <Bold size={15}>{dayOffersTotal(offers.totalGivenPaise, offers.orderCount)}</Bold> : null}
      {!offers.used.length && !today ? <Text style={note}>No offers used on this day</Text> : null}
      {!offers.used.length && today && offers.running && !running.length ? <View style={{ gap: 10 }}><Text style={note}>No offers running</Text><MarketButton label="Create an offer" variant="secondary" onPress={onOpenOffers} /></View> : null}
    </View> : null}
  </MarketSection>;
}

/** Owners' Today tab: cash for a chosen India-time day, what is still to collect now, order counts and the most-ordered dishes. */
export function OwnerToday({ services, day, onOpenOffers }: { services: MarketServices; day: OwnerTodayDay; onOpenOffers?: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const demo = services.mode === 'demo';
  const { chip, picked, setPicked } = day;
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'denied'>(demo ? 'ready' : 'loading');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const date = requestDate(chip, picked);
  const load = useCallback(async () => {
    const current = ++request.current;
    setState('loading'); setError('');
    try {
      const result = await services.getDailySummary(date);
      if (current !== request.current) return; // a newer chip choice superseded this response
      setSummary(result); setState('ready');
    } catch (e) {
      if (current !== request.current) return;
      setSummary(null);
      if (e instanceof ServiceError && e.code === 'ADMIN_REQUIRED') setState('denied'); else setState('error');
      // Our own access message is safe to show; anything else gets a fixed, friendly line.
      setError(e instanceof ServiceError && e.code === 'ADMIN_REQUIRED' ? e.message : 'Check your connection and try again.');
    }
  }, [services, date]);
  useEffect(() => { if (demo) return; void load(); return () => { request.current++; }; }, [load, demo, attempt]);
  const shown = summary?.dateISO ?? date ?? istDateISO();
  // Light text on the dark cash card; bars scale to the most-ordered dish.
  const soft = 'rgba(255,255,255,0.78)';
  const topQuantity = Math.max(1, ...(summary?.topDishes.map(dish => dish.quantity) ?? [1]));
  const cashSize = summary ? amountFontSize(rupees(summary.collectedPaise), rupees(summary.outstandingPaise)) : 30;
  return <View style={{ gap: 16 }}>
    {/* Always mounted, so screen readers announce changes to it. */}
    <Text role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0 }}>{state === 'loading' ? 'Loading summary' : state === 'ready' && summary ? `Showing ${scopeWord(shown)}: ${rupees(summary.collectedPaise)} collected, ${rupees(summary.outstandingPaise)} still to collect.` : ''}</Text>
    {chip === 'date' ? <DatePicker value={picked} onChange={setPicked} /> : null}
    {demo ? <MarketStatus kind="empty" title="Sample mode" message="There are no live orders in sample mode. Connect the backend and sign in as an administrator to see the day's summary." /> : null}
    {state === 'loading' ? <MarketStatus kind="loading" title="Loading summary" /> : null}
    {state === 'denied' ? <MarketStatus kind="error" title="Owner access needed" message={error || 'Your admin access changed. Sign in again to see the summary.'} /> : null}
    {state === 'error' ? <MarketStatus kind="error" title="Could not load the summary" message={error} action={<MarketButton label="Retry" variant="secondary" onPress={() => setAttempt(n => n + 1)} />} /> : null}
    {state === 'ready' && summary ? <View style={{ gap: 16 }}>
      <View style={{ backgroundColor: colors.ink, borderRadius: 20, padding: 20, gap: 14 }}>
        <Text style={{ color: soft, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>CASH</Text>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: soft, fontSize: 14, lineHeight: 20 }}>{shown === istDateISO() ? 'Collected' : collectedHeading(shown)}</Text>
            <Bold heading size={cashSize} color={colors.surface}>{rupees(summary.collectedPaise)}</Bold>
            <Text style={{ color: soft, fontSize: 13, lineHeight: 18, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{deliveredNote(summary.deliveredCount, shown)}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: soft, fontSize: 14, lineHeight: 20 }}>Still to collect now</Text>
            <Bold heading size={cashSize} color={colors.surface}>{rupees(summary.outstandingPaise)}</Bold>
            <Text style={{ color: soft, fontSize: 13, lineHeight: 18, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{outstandingNote(summary.outstandingCount)}</Text>
          </View>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Tile label={placedLabel(shown)} value={summary.placedCount} />
        <Tile label={deliveredLabel(shown)} value={summary.deliveredCount} />
        <Tile label={cancelledLabel(shown)} value={summary.cancelledCount} />
      </View>
      <MarketSection title="Most ordered">
        {summary.topDishes.length ? summary.topDishes.map((dish, index) => <View key={`${dish.name}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}><MarketText>{dish.name}</MarketText></View>
          <Bold size={16}>{`× ${dish.quantity}`}</Bold>
          <View aria-hidden style={{ width: 90, height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' }}><View style={{ width: `${Math.max(4, Math.round(dish.quantity / topQuantity * 100))}%`, height: '100%', backgroundColor: colors.primary }} /></View>
        </View>) : <MarketText variant="muted">No dishes ordered</MarketText>}
      </MarketSection>
      {onOpenOffers ? <TodayOffers services={services} date={shown} onOpenOffers={onOpenOffers} /> : null}
      <MarketText variant="muted">{summaryFooter}</MarketText>
    </View> : null}
  </View>;
}
