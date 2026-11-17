import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { addressLine, addressTitle, businesses, type AddressDraft, type SavedAddress } from '@market/core';
import { MarketButton, MarketStatus } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { AddressForm } from './AddressForm';
import { MarketPill } from './MarketChips';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { formatDistance } from './address-model';
import { addressOutsideReason, selectable, type ConfirmationCopy } from './checkout-model';
import { sameIdentity } from './checkout-state';
import { messageOf, type useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';

type Market = ReturnType<typeof useMarket>;
export type CheckoutAddresses = ReturnType<typeof useCheckoutAddresses>;

/** The customer's saved addresses for this restaurant, which one checkout uses, and the picker dialogs (#48). */
export function useCheckoutAddresses(market: Market, enabled: boolean) {
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'picker' | 'form' | null>(null), [notice, setNotice] = useState('');
  const auto = useRef(false), trigger = useRef<HTMLElement | null>(null);
  const userId = market.session?.user.id;
  useEffect(() => { setAddresses(null); setSelectedId(null); setDialog(null); setNotice(''); setError(''); auto.current = false; }, [userId, market.identityVersion]);
  useEffect(() => {
    if (!enabled || !userId) return;
    let active = true; const started = market.identity.current;
    market.services.listAddresses().then(list => {
      if (!active || !sameIdentity(started, market.identity.current)) return;
      setAddresses(list); setError('');
      // Pick the first usable address once, as in the design; later changes are the customer's.
      if (!auto.current) { auto.current = true; const first = list.find(selectable); if (first) setSelectedId(first.id); }
    }).catch(e => { if (active && sameIdentity(started, market.identity.current)) { setAddresses(current => current ?? []); setError(messageOf(e)); } });
    return () => { active = false; };
  }, [enabled, userId, market.services, market.identity, market.identityVersion, reload]);
  const selected = addresses?.find(address => address.id === selectedId && selectable(address)) ?? null;
  /** `from` is the control to return focus to when the opener is about to unmount (the confirmation sheet's button). */
  const open = (from?: HTMLElement | null) => { trigger.current = from ?? capturePanelFocus(); setNotice(''); setDialog('picker'); };
  const close = () => { setDialog(null); restorePanelFocus(trigger.current); };
  const saveNew = async (draft: AddressDraft) => {
    const created = await market.services.saveAddress(draft);
    const list = await market.services.listAddresses();
    setAddresses(list); auto.current = true; setError('');
    const fresh = list.find(address => address.id === created.id);
    if (fresh && selectable(fresh)) { setSelectedId(fresh.id); close(); }
    else { setNotice('Address saved, but we don\'t deliver there. Choose another address.'); setDialog('picker'); }
  };
  return { enabled, addresses, error, selected, selectedId, dialog, notice, open, close, setDialog, saveNew, select: setSelectedId, refresh: () => setReload(value => value + 1) };
}

/** One row of the picker, or the summary line. */
function useRowStyle() {
  const { colors } = useMarketTheme(); const fonts = useMarketFonts();
  return { colors, fonts, bold: fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const } };
}

/** The "Deliver to" card at the top of checkout (customer p. 4): icon tile, address, Change, and the in-area strip. */
export function CheckoutAddressSummary({ ctrl }: { ctrl: CheckoutAddresses }) {
  const { colors, fonts, bold } = useRowStyle();
  const { statusHeader } = useMarketTheme();
  const { addresses, error, selected } = ctrl;
  const muted = { color: colors.muted, fontSize: 15, lineHeight: 22 };
  const card = { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1, borderRadius: 20, padding: 16, gap: 12 };
  if (!ctrl.enabled) return <View style={card}><Text style={muted}>Sign in to choose a delivery address.</Text></View>;
  const band = statusHeader === 'band';
  const icon: MarketIconName = selected ? rowIcon(selected) : 'pin';
  return <View style={card}>
    <Text accessibilityRole="header" style={{ color: colors.muted, fontSize: 12, lineHeight: 16, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Delivery address</Text>
    {error ? <><Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }}>{error}</Text><MarketButton label="Retry addresses" variant="secondary" onPress={ctrl.refresh} /></> : null}
    {addresses === null && !error ? <Text accessibilityRole="progressbar" style={muted}>Loading your saved addresses…</Text> : null}
    {addresses && !addresses.length && !error ? <>
      <MarketStatus kind="empty" title="No saved addresses yet" message="Add an address to deliver to. It is saved for next time, in both restaurant apps." />
      <MarketButton label="Add a new address" onPress={() => { ctrl.open(); ctrl.setDialog('form'); }} />
    </> : null}
    {addresses?.length ? <>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
        <View aria-hidden style={{ width: 44, height: 44, borderRadius: band ? 22 : 14, alignItems: 'center', justifyContent: 'center', backgroundColor: band ? colors.band : colors.tint }}>
          <MarketIcon name={icon} color={band ? colors.onPrimary : colors.primary} size={20} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.ink, fontSize: 17, lineHeight: 24, ...bold }}>{selected ? `Deliver to ${addressTitle(selected)}` : 'No address chosen'}</Text>
          <Text style={{ ...muted, ...(fonts.body ? { fontFamily: fonts.body } : {}) }}>{selected ? `${addressLine(selected)}${selected.distanceM !== null ? ` · ${formatDistance(selected.distanceM)}` : ''}` : 'Choose where we should deliver this order.'}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={selected ? 'Change delivery address' : 'Choose delivery address'} onPress={() => ctrl.open()} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 }}>
          <Text style={{ color: colors.primary, fontSize: 15, ...bold }}>{selected ? 'Change' : 'Choose'}</Text>
        </Pressable>
      </View>
      {selected ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.positiveTint }}>
        <MarketIcon name="check" color={colors.positive} size={16} />
        <Text style={{ color: colors.positive, fontSize: 14, lineHeight: 20 }}>Inside our delivery area</Text>
      </View> : null}
    </> : null}
  </View>;
}

const rowIcon = (address: SavedAddress): MarketIconName => address.label === 'home' ? 'home' : address.label === 'work' ? 'work' : 'pin';

function Picker({ ctrl }: { ctrl: CheckoutAddresses }) {
  const { colors, fonts, bold } = useRowStyle();
  const { businessId, name } = useMarketTheme();
  const ammu = businessId === 'ammu-sammu';
  const other = Object.values(businesses).map(business => business.name).find(value => value !== name) ?? name;
  const [pending, setPending] = useState<string | null>(ctrl.selected?.id ?? null);
  const addresses = ctrl.addresses ?? [];
  const chosen = addresses.find(address => address.id === pending && selectable(address));
  return <AccessiblePanel fullScreen title="Delivery address" onClose={ctrl.close}
    footer={<MarketButton label={chosen ? `Deliver to ${addressTitle(chosen)}` : 'Choose an address'} disabled={!chosen} onPress={() => { if (chosen) { ctrl.select(chosen.id); ctrl.close(); } }} />}>
    <MarketButton label="Add a new address" variant="secondary" onPress={() => ctrl.setDialog('form')} />
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
      <MarketIcon name="pin" color={colors.primary} size={18} nudge={2} />
      <Text style={{ flex: 1, color: colors.ink, fontSize: 14, lineHeight: 21 }}>We deliver in Khed and nearby villages. Addresses outside our area are shown but can't be picked.</Text>
    </View>
    {ctrl.notice ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }}>{ctrl.notice}</Text> : null}
    <Text accessibilityRole="header" style={{ color: colors.muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Saved addresses</Text>
    {!addresses.length ? <MarketStatus kind="empty" title="No saved addresses yet" message={`Add an address above. It is saved for next time, in this app and the ${other} app.`} /> : null}
    {addresses.length ? <View accessibilityRole="radiogroup" accessibilityLabel="Saved addresses" style={{ gap: 12, backgroundColor: colors.surface, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14 }}>
      {addresses.map((address, index) => {
        const title = addressTitle(address), usable = selectable(address), checked = usable && pending === address.id, distance = formatDistance(address.distanceM);
        return <Pressable key={address.id} accessibilityRole="radio" aria-checked={checked} aria-disabled={!usable} disabled={!usable}
          accessibilityLabel={`${title}, ${addressLine(address)}${distance ? `, ${distance}` : ''}${usable ? '' : `, ${addressOutsideReason.toLowerCase()}`}`}
          accessibilityState={{ checked, disabled: !usable }} onPress={() => setPending(address.id)}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, minHeight: 48, paddingTop: index ? 12 : 0, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border, opacity: usable ? 1 : 0.75 }}>
          {ammu ? <View style={{ alignItems: 'center', gap: 4, width: 52 }}>
            <View accessible={false} style={{ width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: !usable ? colors.neutralTint : checked ? colors.primary : colors.tint }}>
              <MarketIcon name={rowIcon(address)} color={!usable ? colors.muted : checked ? colors.onPrimary : colors.primary} size={22} />
            </View>
            {distance ? <Text style={{ color: colors.muted, fontSize: 12 }}>{distance}</Text> : null}
          </View> : <View accessible={false} style={{ width: 24, height: 24, marginTop: 2, borderRadius: 12, borderWidth: 2, borderColor: usable ? colors.primary : colors.muted, borderStyle: usable ? 'solid' : 'dashed', alignItems: 'center', justifyContent: 'center' }}>
            {checked ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.primary }} /> : null}
          </View>}
          <View style={{ flex: 1, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
              <Text style={{ color: usable ? colors.ink : colors.muted, fontSize: 18, lineHeight: 26, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>
              {!ammu && distance ? <Text style={{ color: colors.muted, fontSize: 13 }}>{distance}</Text> : null}
              {ammu && checked ? <MarketPill label="Selected" tone="positive" /> : null}
            </View>
            <Text style={{ color: usable ? colors.ink : colors.muted, fontSize: 15, lineHeight: 22 }}>{addressLine(address)}</Text>
            {!usable ? <View style={{ alignSelf: 'flex-start' }}><MarketPill label={addressOutsideReason} tone="neutral" /></View> : null}
          </View>
        </Pressable>;
      })}
    </View> : null}
  </AccessiblePanel>;
}

/** The picker and, over it, the add-address form. */
export function CheckoutAddressDialogs({ ctrl }: { ctrl: CheckoutAddresses }) {
  return <>
    {ctrl.dialog === 'picker' ? <Picker ctrl={ctrl} /> : null}
    {ctrl.dialog === 'form' ? <AddressForm editing={null} save={ctrl.saveNew} close={() => (ctrl.addresses?.length ? ctrl.setDialog('picker') : ctrl.close())} /> : null}
  </>;
}

/** Shown before ordering when the phone is far from the pin or has no location (design: remote and NoLocation). */
export function OrderConfirmationSheet({ copy, busy, confirm, change, dismiss }: { copy: ConfirmationCopy; busy: boolean; confirm: () => void; change: () => void; dismiss: () => void }) {
  const { colors, bold } = useRowStyle();
  return <AccessiblePanel sheet title={copy.title} onClose={() => { if (!busy) dismiss(); }}>
    <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}>{copy.lead}</Text>
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
      <MarketIcon name="pin" color={colors.primary} size={18} nudge={2} />
      <Text style={{ flex: 1, color: colors.ink, fontSize: 15, lineHeight: 22 }}>{copy.cash.split(copy.amount).flatMap((part, i) => i ? [<Text key={i} style={bold}>{copy.amount}</Text>, part] : [part])}</Text>
    </View>
    <MarketButton label={busy ? 'Placing order…' : 'Yes, place order'} disabled={busy} onPress={confirm} />
    <MarketButton label="Change address" variant="secondary" disabled={busy} onPress={change} />
  </AccessiblePanel>;
}
