import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { addressLabels, type AddressDraft, type AddressLabel, type SavedAddress } from '@market/core';
import { MarketButton, MarketField } from './components';
import { AccessiblePanel } from './AccessiblePanel';
import { MarketChip } from './MarketChips';
import { MarketIcon } from './MarketIcons';
import { requestLocation } from './location';
import { addressErrorMessage, checkAddressForm, emptyAddressForm, formFromAddress, locationErrorMessage, type AddressForm as FormState, type AddressFormErrors } from './address-model';
import { useMarketFonts, useMarketTheme } from './theme';

/**
 * Add or edit one saved address (#48). The delivery pin comes from the phone's location for now
 * (map pin and place search are #49); saving is blocked until a pin is set.
 */
export function AddressForm({ editing, save, close, inline = false }: { editing: SavedAddress | null; save: (draft: AddressDraft) => Promise<void>; close: () => void; /** Render in place (the cart's first-address card, #187) instead of as a full-screen panel. Same fields, checks and location step. */ inline?: boolean }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const [form, setForm] = useState<FormState>(editing ? formFromAddress(editing) : emptyAddressForm);
  const [errors, setErrors] = useState<AddressFormErrors>({});
  const [locating, setLocating] = useState(false), [saving, setSaving] = useState(false);
  const [locationError, setLocationError] = useState(''), [saveError, setSaveError] = useState('');
  const busy = useRef(false);
  const set = (change: Partial<FormState>) => { setForm(current => ({ ...current, ...change })); };
  const locate = async () => {
    if (busy.current) return; busy.current = true; setLocating(true); setLocationError('');
    try {
      const fix = await requestLocation();
      set({ location: { latitude: fix.latitude, longitude: fix.longitude, source: 'gps' } });
      setErrors(current => ({ ...current, location: undefined }));
    } catch (error) { setLocationError(locationErrorMessage(error)); }
    finally { busy.current = false; setLocating(false); }
  };
  const submit = async () => {
    if (busy.current) return;
    const checked = checkAddressForm(form);
    if ('errors' in checked) { setErrors(checked.errors); setSaveError(''); return; }
    setErrors({}); setSaveError(''); busy.current = true; setSaving(true);
    try { await save(checked.draft); }
    catch (error) { setSaveError(addressErrorMessage(error)); }
    finally { busy.current = false; setSaving(false); }
  };
  const pinText = form.location ? (form.location.source === 'gps' ? 'Delivery pin set from your phone\'s location.' : 'Delivery pin is set on the map.') : 'No delivery pin yet.';
  const locationProblem = locationError || errors.location;
  const footer = <>
      {saveError ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 15, lineHeight: 22 }}>{saveError}</Text> : null}
      <MarketButton label={saving ? 'Saving…' : 'Save address'} disabled={saving || locating} onPress={() => void submit()} />
    </>;
  const body = <>
    <Pressable accessibilityRole="button" accessibilityLabel="Use my current location" accessibilityState={{ disabled: locating, busy: locating }} disabled={locating} onPress={() => void locate()}
      style={({ pressed }) => ({ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: locationProblem ? colors.danger : colors.border, backgroundColor: colors.surface, opacity: locating ? 0.6 : pressed ? 0.85 : 1 })}>
      <MarketIcon name="locate" color={colors.primary} size={22} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.ink, fontSize: 16, ...(fonts.bodySemiBold ? { fontFamily: fonts.bodySemiBold } : { fontWeight: '700' as const }) }}>{locating ? 'Finding your location…' : 'Use my current location'}</Text>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>{pinText}</Text>
      </View>
    </Pressable>
    {[locationError, errors.location].filter(Boolean).map(message => <Text key={message} accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14, lineHeight: 21 }}>{message}</Text>)}
    <MarketField label="House, flat or floor" placeholder="e.g. Flat 3, Sai Krupa Apartments" value={form.house} maxLength={120} error={errors.house} autoComplete="address-line1" onChangeText={house => set({ house })} />
    <MarketField label="Street and area" placeholder="e.g. Bharne Naka" value={form.streetArea} maxLength={200} error={errors.streetArea} autoComplete="address-line2" onChangeText={streetArea => set({ streetArea })} />
    <MarketField label="Landmark (optional)" placeholder="e.g. Opposite the Maruti temple" value={form.landmark} maxLength={120} error={errors.landmark} onChangeText={landmark => set({ landmark })} />
    <View accessibilityRole="radiogroup" accessibilityLabel="Save as" style={{ gap: 8 }}>
      <Text style={{ color: colors.ink, fontSize: 15, ...(fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const }) }}>Save as</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(['home', 'work', 'other'] as AddressLabel[]).map(label => <MarketChip key={label} label={addressLabels[label]} selected={form.label === label} radio onPress={() => set({ label })} />)}
      </View>
    </View>
    {form.label === 'other' ? <MarketField label="Name this address (optional)" placeholder="e.g. Aai's place" value={form.customLabel} maxLength={40} error={errors.customLabel} onChangeText={customLabel => set({ customLabel })} /> : null}
  </>;
  if (inline) return <View style={{ gap: 14 }}>{body}{footer}</View>;
  return <AccessiblePanel fullScreen title={editing ? 'Edit address' : 'Add address'} onClose={close} closeDisabled={saving} footer={footer}>{body}</AccessiblePanel>;
}
