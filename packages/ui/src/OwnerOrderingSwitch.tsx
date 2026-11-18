import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { MarketSwitch } from './MarketSwitch';
import type { Business, MarketServices } from '@market/services';
import { MarketButton } from './components';
import { ownerContentWidth, useOwnerHorizontalPadding } from './OwnerShell';
import { useMarketFonts, useMarketTheme } from './theme';

type State = { services: MarketServices; business: Business | null; ready: boolean; saving: boolean; error: string; notice: string; uncertain: boolean };
const empty = (services: MarketServices): State => ({ services, business: null, ready: false, saving: false, error: '', notice: '', uncertain: false });

/** Portable Orders control; the backend owns authorization and the actual value. */
export function OwnerOrderingSwitch({ services }: { services: MarketServices }) {
  const { colors, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const [state, setState] = useState(() => empty(services));
  const [attempt, setAttempt] = useState(0);
  const change = useRef<((next: boolean) => void) | null>(null);
  useEffect(() => {
    if (services.mode === 'demo') return;
    let active = true, request = 0, saving = false, disconnected = false;
    let business: Business | null = null, ready = false, error = '', notice = '', uncertain = false;
    let unsubscribe: (() => void) | undefined;
    const publish = () => { if (active) setState({ services, business, ready, saving, error, notice, uncertain }); };
    const refresh = async (confirmed: boolean | null = null) => {
      if (!active || saving) return;
      const started = ++request; ready = false; error = ''; publish();
      try {
        const [latest, allowed] = await Promise.all([services.getBusiness(), services.isAdmin()]);
        if (!active || started !== request) return;
        if (!allowed) throw new Error('Owner access is required to change restaurant status. Sign in again with an owner account.');
        business = latest; ready = !disconnected;
        if (disconnected) error = 'Live restaurant updates are disconnected. Refresh to reconnect before changing the status.';
        if (confirmed !== null) notice = latest.acceptingOrders === confirmed ? 'Restaurant status updated.' : 'Another owner changed the status. The latest confirmed status is shown.';
        else if (uncertain) notice = 'The change request was not confirmed. The latest restaurant status is shown.';
        publish();
      } catch (failure) {
        if (active && started === request) { ready = false; error = failure instanceof Error ? failure.message : 'Could not load restaurant status.'; publish(); }
      }
    };
    const save = async (next: boolean) => {
      if (!active || saving || !ready || !business || next === business.acceptingOrders) return;
      saving = true; ready = false; request++; error = ''; notice = ''; uncertain = false; publish();
      let confirmed: boolean | null = null;
      try {
        confirmed = await services.setAcceptingOrders(next);
        if (!active) return;
        notice = 'Change saved. Confirming the latest restaurant status…'; publish();
      } catch {
        if (!active) return;
        uncertain = true; notice = 'The change could not be confirmed. Refresh the restaurant status before trying again.'; publish();
      } finally {
        if (active) { saving = false; await refresh(confirmed); }
      }
    };
    change.current = next => { void save(next); };
    const failed = (failure: unknown) => {
      if (!active) return;
      request++; disconnected = true; ready = false;
      error = failure instanceof Error ? failure.message : 'Live restaurant updates disconnected. Refresh to reconnect.'; publish();
    };
    void refresh();
    void services.subscribeBusinessState(() => { if (active) { disconnected = false; void refresh(); } }, failed)
      .then(stop => { if (active) unsubscribe = stop; else stop(); }).catch(failed);
    return () => { active = false; request++; change.current = null; unsubscribe?.(); };
  }, [services, attempt]);
  const padding = useOwnerHorizontalPadding();
  const body = (bg: string, children: ReactNode) => <View style={{ backgroundColor: bg }}><View style={{ width: '100%', maxWidth: ownerContentWidth, alignSelf: 'center', paddingHorizontal: padding, paddingVertical: 12, gap: 6 }}>{children}</View></View>;
  if (services.mode === 'demo') return body(colors.openBand, <Text style={{ color: colors.onOpenBand, fontSize: 15, lineHeight: 22, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>Restaurant availability cannot be changed in sample mode.</Text>);
  const current = state.services === services ? state : empty(services);
  const checked = current.business?.acceptingOrders === true;
  const disabled = !current.ready || current.saving;
  const setupPending = current.business?.orderingEnabled === false;
  const title = current.saving ? 'Saving restaurant status…' : !current.ready ? current.error ? 'Restaurant status unavailable' : 'Checking restaurant status…'
    : checked ? setupPending ? 'Kitchen marked open · ordering setup pending' : 'Open · taking orders' : 'Closed · not taking orders';
  // Open / unknown: pale band with coloured text. Confirmed closed: dark band with white text (#53, owners p. 3 and 7).
  const closed = current.ready && !checked;
  const ink = closed ? colors.onClosedBand : colors.onOpenBand;
  const sans = { color: ink, ...(fonts.body ? { fontFamily: fonts.body } : {}) };
  const sansBold = { color: ink, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) };
  return body(closed ? colors.closedBand : colors.openBand, <>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <View style={{ flex: 1 }}>
        <Text accessibilityRole="header" style={{ fontSize: 17, lineHeight: 24, ...sansBold }}>{title}</Text>
        <View role="status" accessibilityLiveRegion="polite"><Text style={{ fontSize: 14, lineHeight: 21, ...sans }}>{current.saving ? 'Please wait for confirmation. Existing orders can still be managed.' : !current.ready ? 'Refresh or wait for confirmation before changing whether the restaurant takes new orders.' : checked ? 'Switch off to pause new orders' : "Customers can see the menu but can't order"}</Text></View>
      </View>
      <MarketSwitch label={`Take new orders at ${name}`} hint={disabled ? 'Wait for the restaurant status to be confirmed.' : checked ? 'Switch off to pause new orders.' : 'Switch on to take new orders.'} value={checked} disabled={!current.ready} busy={current.saving} onValueChange={next => change.current?.(next)} />
    </View>
    {setupPending ? <Text style={{ fontSize: 14, lineHeight: 21, ...sans }}>Customer ordering setup is not enabled yet. This switch only marks the kitchen open or closed; it cannot enable customer ordering by itself.</Text> : null}
    {current.notice ? <Text accessibilityRole={current.uncertain ? 'alert' : undefined} accessibilityLiveRegion="polite" style={{ fontSize: 14, lineHeight: 21, ...(current.uncertain ? sansBold : sans) }}>{current.notice}</Text> : null}
    {current.error ? <><Text accessibilityRole="alert" style={{ fontSize: 14, lineHeight: 21, ...sansBold }}>{current.error}</Text><MarketButton label="Refresh restaurant status" variant="secondary" disabled={current.saving} onPress={() => setAttempt(value => value + 1)} /></> : null}
  </>);
}
