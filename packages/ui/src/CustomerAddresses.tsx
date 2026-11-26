import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { addressLine, addressTitle, businesses, type AddressDraft, type SavedAddress } from '@market/core';
import { MarketButton, MarketCard, MarketStatus, MarketText } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { AddressForm } from './AddressForm';
import { MarketPill } from './MarketChips';
import { StateScreen } from './StateScreen';
import { friendlyErrorText, noAddressesCopy } from './states-model';
import { MarketIcon, type MarketIconName } from './MarketIcons';
import { addressErrorMessage, bothAppsNote, formatDistance, maxSavedAddresses } from './address-model';
import { sameIdentity } from './checkout-state';
import { messageOf, type useMarket } from './useMarket';
import { useMarketFonts, useMarketTheme } from './theme';

type Market = ReturnType<typeof useMarket>;
type Dialog = { kind: 'form'; address: SavedAddress | null } | { kind: 'options' | 'delete'; address: SavedAddress } | null;

/** Saved addresses (#48): this customer's list, shared by both restaurant apps, with add, edit and delete. */
export function CustomerAddresses({ market }: { market: Market }) {
  const { colors, businessId, name } = useMarketTheme();
  const fonts = useMarketFonts();
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('');
  const trigger = useRef<HTMLElement | null>(null);
  const ammu = businessId === 'ammu-sammu';
  const other = Object.values(businesses).map(business => business.name).find(value => value !== name) ?? name;
  const userId = market.session?.user.id;
  useEffect(() => {
    let active = true; const started = market.identity.current;
    setError(''); if (reload === 0) setAddresses(null);
    market.services.listAddresses().then(list => { if (active && sameIdentity(started, market.identity.current)) setAddresses(list); })
      .catch(e => { if (active && sameIdentity(started, market.identity.current)) { setAddresses(current => current ?? []); setError(messageOf(e)); } });
    return () => { active = false; };
  }, [market.services, market.identity, market.identityVersion, userId, reload]);
  const refresh = () => setReload(value => value + 1);
  const open = (next: Dialog) => { trigger.current = capturePanelFocus(); setDeleteError(''); setDialog(next); };
  const close = () => { setDialog(null); restorePanelFocus(trigger.current); };
  const save = async (draft: AddressDraft) => {
    const editing = dialog?.kind === 'form' ? dialog.address : null;
    try { await market.services.saveAddress(draft, editing ? { id: editing.id, version: editing.version } : undefined); }
    catch (e) { if ((e as { code?: string }).code === 'ADDRESS_CHANGED') refresh(); throw e; }
    setNotice(editing ? 'Address updated.' : 'Address saved.'); close(); refresh();
  };
  const remove = async (address: SavedAddress) => {
    if (deleting) return; setDeleting(true); setDeleteError('');
    try { await market.services.deleteAddress(address.id); setNotice('Address deleted.'); close(); refresh(); }
    catch (e) { setDeleteError(addressErrorMessage(e)); } finally { setDeleting(false); }
  };
  const full = (addresses?.length ?? 0) >= maxSavedAddresses;
  const rowIcon = (address: SavedAddress): MarketIconName => address.label === 'home' ? 'home' : address.label === 'work' ? 'work' : 'pin';
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  return <View style={{ gap: 16 }}>
    <MarketText variant="heading">Saved addresses</MarketText>
    <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21 }}>Manage your saved addresses here. You choose where each order goes at checkout.</Text>
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.tint }}>
      <MarketIcon name="pin" color={colors.primary} size={18} nudge={2} />
      <Text style={{ flex: 1, color: colors.ink, fontSize: 14, lineHeight: 21 }}>We deliver in Khed and nearby villages. Addresses outside our area are shown but can't be used for an order.</Text>
    </View>
    {notice ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.positive, fontSize: 15 }}>{notice}</Text> : null}
    {error ? <MarketCard><Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 23 }}>{friendlyErrorText(error)}</Text><MarketButton label="Retry addresses" variant="secondary" onPress={refresh} /></MarketCard> : null}
    {addresses === null ? <MarketStatus kind="loading" title="Loading addresses" /> : null}
    {addresses && !addresses.length && !error ? <StateScreen card icon="pin" level={3} {...noAddressesCopy(other)} /> : null}
    {addresses?.length ? <MarketCard>{addresses.map((address, index) => {
      const distance = formatDistance(address.distanceM), title = addressTitle(address), out = !address.inArea;
      return <View key={address.id} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingTop: index ? 12 : 0, borderTopWidth: index ? 1 : 0, borderTopColor: colors.border }}>
        {ammu ? <View style={{ alignItems: 'center', gap: 4, width: 52 }}>
          <View accessible={false} style={{ width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: out ? colors.neutralTint : address.label === 'home' ? colors.primary : colors.tint }}>
            <MarketIcon name={rowIcon(address)} color={out ? colors.muted : address.label === 'home' ? colors.onPrimary : colors.primary} size={22} />
          </View>
          {distance ? <Text style={{ color: colors.muted, fontSize: 12 }}>{distance}</Text> : null}
        </View> : null}
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
            <Text accessibilityRole="header" style={{ color: out ? colors.muted : colors.ink, fontSize: 18, lineHeight: 26, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>{title}</Text>
            {!ammu && distance ? <Text style={{ color: colors.muted, fontSize: 13 }}>{distance}</Text> : null}
          </View>
          <Text style={{ color: out ? colors.muted : colors.ink, fontSize: 15, lineHeight: 22 }}>{addressLine(address)}</Text>
          {out ? <View style={{ alignSelf: 'flex-start' }}><MarketPill label="Outside delivery area" tone="neutral" /></View> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Options for ${title}`} onPress={() => open({ kind: 'options', address })} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <Text accessible={false} aria-hidden style={{ color: colors.ink, fontSize: 24, ...bold }}>⋮</Text>
        </Pressable>
      </View>;
    })}</MarketCard> : null}
    {full ? <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21 }}>You have saved {maxSavedAddresses} addresses, the most you can keep. Delete one to add another.</Text> : null}
    <MarketButton label="Add address" disabled={addresses === null || full} onPress={() => open({ kind: 'form', address: null })} />
    {dialog?.kind === 'options' ? <AccessiblePanel sheet title={addressTitle(dialog.address)} onClose={close}>
      <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 22 }}>{addressLine(dialog.address)}</Text>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Edit address" onPress={() => setDialog({ kind: 'form', address: dialog.address })} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <MarketIcon name="edit" color={colors.ink} size={18} /><Text style={{ color: colors.ink, fontSize: 16, ...bold }}>Edit address</Text>
        </Pressable>
        <View style={{ height: 1, backgroundColor: colors.border }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Delete address" onPress={() => setDialog({ kind: 'delete', address: dialog.address })} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <MarketIcon name="trash" color={colors.danger} size={18} /><Text style={{ color: colors.danger, fontSize: 16, ...bold }}>Delete address</Text>
        </Pressable>
      </View>
      <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 21 }}>{bothAppsNote([name, other])}</Text>
      <MarketButton label="Close" variant="secondary" onPress={close} />
    </AccessiblePanel> : null}
    {dialog?.kind === 'delete' ? <AccessiblePanel title="Delete this address?" onClose={() => { if (!deleting) close(); }}>
      <Text style={{ color: colors.ink, fontSize: 16, lineHeight: 24 }}><Text style={bold}>{addressTitle(dialog.address)}</Text>, {addressLine(dialog.address)}</Text>
      <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 23 }}>It will be removed from both apps. Past orders keep the address they were delivered to.</Text>
      {deleteError ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15 }}>{deleteError}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Yes, delete address" accessibilityState={{ disabled: deleting }} disabled={deleting} onPress={() => void remove(dialog.address)} style={{ minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.danger, opacity: deleting ? 0.5 : 1 }}>
        <Text style={{ color: colors.onPrimary, fontSize: 15, ...bold }}>{deleting ? 'Deleting…' : 'Yes, delete address'}</Text>
      </Pressable>
      <MarketButton label="Keep address" variant="secondary" disabled={deleting} onPress={close} />
    </AccessiblePanel> : null}
    {dialog?.kind === 'form' ? <AddressForm key={dialog.address?.id ?? 'new'} editing={dialog.address} save={save} close={close} /> : null}
  </View>;
}
