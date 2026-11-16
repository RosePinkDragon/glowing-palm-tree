import { createElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { formatINRFromPaise } from '@market/core';
import { ServiceError, type MarketServices } from '@market/services';
import type { DailySummary } from '@market/core';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { useMarketFonts, useMarketTheme } from './theme';
import { acceptPickedDate, cancelledLabel, chipLabel, collectedHeading, defaultPickedDate, deliveredLabel, deliveredNote, istDateISO, outstandingNote, placedLabel, requestDate, shortDateLabel, stepPickedDate, summaryFooter, todayChips, type TodayChip } from './today-model';

const rupees = (paise: number) => { try { return formatINRFromPaise(paise).replace(/\.00$/, ''); } catch { return '₹0'; } };
const chipNames: Record<TodayChip, string> = { today: 'Today', yesterday: 'Yesterday', date: 'Pick a date' };

function Bold({ children, size, color }: { children: ReactNode; size: number; color?: string }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  return <Text style={{ color: color ?? colors.ink, fontSize: size, lineHeight: Math.round(size * 1.25), ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>{children}</Text>;
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
      type: 'date', value, max: today, 'aria-labelledby': 'today-date-label', 'aria-label': 'Choose a day',
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
  return <View role="group" aria-label={`${label}: ${value}`} style={{ flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 18, padding: 14, gap: 4, minHeight: 48 }}>
    <Bold size={28}>{String(value)}</Bold>
    <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 18 }}>{label}</Text>
  </View>;
}

/** Owners' Today tab: cash for a chosen India-time day, what is still to collect now, order counts and the most-ordered dishes. */
export function OwnerToday({ services }: { services: MarketServices }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const demo = services.mode === 'demo';
  const [chip, setChip] = useState<TodayChip>('today');
  const [picked, setPicked] = useState(() => defaultPickedDate());
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
      setError(e instanceof Error ? e.message : 'Please try again.');
    }
  }, [services, date]);
  useEffect(() => { if (demo) return; void load(); return () => { request.current++; }; }, [load, demo, attempt]);
  const shown = summary?.dateISO ?? date ?? istDateISO();
  return <View style={{ gap: 16 }}>
    <View role="group" aria-label="Choose a day" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {todayChips.map(value => {
        const active = chip === value;
        return <Pressable key={value} accessibilityRole="button" accessibilityLabel={value === 'date' && active ? `Pick a date, ${shortDateLabel(picked)} selected` : chipLabel(value, picked)} aria-pressed={active}
          onPress={() => { if (value === 'date' && !active) setPicked(prev => prev || defaultPickedDate()); setChip(value); }}
          style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 24, borderWidth: 1, borderColor: active ? colors.ink : colors.border, backgroundColor: active ? colors.ink : colors.surface }}>
          <Text style={{ color: active ? colors.surface : colors.ink, fontSize: 15, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{value === 'date' && active ? `${chipNames.date}: ${shortDateLabel(picked)}` : chipLabel(value, picked)}</Text>
        </Pressable>;
      })}
    </View>
    {chip === 'date' ? <DatePicker value={picked} onChange={setPicked} /> : null}
    {demo ? <MarketStatus kind="empty" title="Sample mode" message="There are no live orders in sample mode. Connect the backend and sign in as an administrator to see the day's summary." /> : null}
    {state === 'loading' ? <MarketStatus kind="loading" title="Loading summary" /> : null}
    {state === 'denied' ? <MarketStatus kind="error" title="Owner access needed" message={error || 'Your admin access changed. Sign in again to see the summary.'} /> : null}
    {state === 'error' ? <MarketStatus kind="error" title="Could not load the summary" message={error} action={<MarketButton label="Retry" variant="secondary" onPress={() => setAttempt(n => n + 1)} />} /> : null}
    {state === 'ready' && summary ? <View style={{ gap: 16 }} aria-live="polite">
      <MarketCard>
        <MarketText variant="eyebrow">Cash</MarketText>
        <View>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{collectedHeading(shown)}</Text>
          <Bold size={34}>{rupees(summary.collectedPaise)}</Bold>
          <MarketText variant="muted">{deliveredNote(summary.deliveredCount, shown)}</MarketText>
        </View>
        <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
          <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>Still to collect now</Text>
          <Bold size={26} color={colors.primary}>{rupees(summary.outstandingPaise)}</Bold>
          <MarketText variant="muted">{outstandingNote(summary.outstandingCount)}</MarketText>
        </View>
      </MarketCard>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Tile label={placedLabel(shown)} value={summary.placedCount} />
        <Tile label={deliveredLabel(shown)} value={summary.deliveredCount} />
        <Tile label={cancelledLabel(shown)} value={summary.cancelledCount} />
      </View>
      <MarketCard>
        <Text accessibilityRole="header" aria-level={2} style={{ color: colors.primary, fontSize: 12, lineHeight: 18, letterSpacing: 1.5, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>MOST ORDERED</Text>
        {summary.topDishes.length ? summary.topDishes.map((dish, index) => <View key={`${dish.name}-${index}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ flex: 1 }}><MarketText>{dish.name}</MarketText></View>
          <Bold size={16}>{`× ${dish.quantity}`}</Bold>
        </View>) : <MarketText variant="muted">No dishes ordered</MarketText>}
      </MarketCard>
      <MarketText variant="muted">{summaryFooter}</MarketText>
    </View> : null}
  </View>;
}
