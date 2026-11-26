import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { OpeningHoursValidationError, RestaurantSettingsValidationError, ServiceError, type MarketServices, type RestaurantSettings, type RestaurantSettingsView } from '@market/services';
import { MarketButton, MarketStatus } from './components';
import { MarketIcon } from './MarketIcons';
import { MarketSection } from './MarketList';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMarketFonts, useMarketTheme } from './theme';
import { detailsAreDirty, hoursAreDirty } from './discard-model';
import { MarketSwitch } from './MarketSwitch';
import { clockText, hoursFormFrom, hoursPreview, validateHoursForm, type HoursErrors, type HoursForm } from './opening-hours-form';
import { useDiscardGuard } from './DiscardGuard';
import { deliveryAreaText, orderNumberFormat, firstErrorField, formFromSettings, serverFieldErrors, validateDetailsForm, type DetailsErrors, type DetailsField, type DetailsForm } from './restaurant-details-model';

// Owners' Restaurant details (owners' screen p. 13, opened from Settings p. 10). Saves all four fields
// together with the version that was loaded; the server stays the authority (#135).
const conflictMessage = 'Another owner saved changes. Reload to see the latest.';
const noAccessMessage = 'You no longer have access to change restaurant details.';
type Load = { kind: 'loading' } | { kind: 'ready'; settings: RestaurantSettings; view: RestaurantSettingsView } | { kind: 'error'; message: string } | { kind: 'denied' };
type Problem = { kind: 'conflict' | 'denied' | 'unconfirmed' | 'error'; message: string };

const hoursLabels = { opensAt: 'Opening time', closesAt: 'Closing time' } as const;
const labels: Record<DetailsField, string> = { contactPhone: 'Phone number for customers', whatsappPhone: 'WhatsApp number', deliveryFee: 'Delivery fee', minOrder: 'Minimum order' };

export function OwnerRestaurantDetails({ services, onBack }: { services: MarketServices; onBack: () => void }) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [form, setForm] = useState<DetailsForm>({ contactPhone: '', whatsappPhone: '', deliveryFee: '', minOrder: '' });
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Opening hours (#253) save on their own (their own RPC) but share the settings version with the fields above.
  const [hoursForm, setHoursForm] = useState<HoursForm>(hoursFormFrom(null));
  const [hoursErrors, setHoursErrors] = useState<HoursErrors>({});
  const [hoursNotice, setHoursNotice] = useState('');
  const hoursRefs = useRef<Partial<Record<'opensAt' | 'closesAt', ComponentRef<typeof TextInput> | null>>>({});
  const refs = useRef<Partial<Record<DetailsField, ComponentRef<typeof TextInput> | null>>>({});
  const requestId = useRef(0);

  const reload = useCallback(() => {
    const id = ++requestId.current;
    setLoad({ kind: 'loading' }); setErrors({}); setProblem(null); setNotice(''); setHoursErrors({}); setHoursNotice('');
    services.getRestaurantSettings().then(settings => {
      if (id !== requestId.current) return;
      setForm(formFromSettings(settings)); setHoursForm(hoursFormFrom(settings.openingHours ?? null)); setLoad({ kind: 'ready', settings, view: settings });
    }, error => {
      if (id !== requestId.current) return;
      setLoad(error instanceof ServiceError && error.code === 'ADMIN_REQUIRED' ? { kind: 'denied' } : { kind: 'error', message: error instanceof Error ? error.message : 'Please try again.' });
    });
  }, [services]);
  useEffect(() => { reload(); return () => { requestId.current++; }; }, [reload]);

  const body = (size = 15) => ({ color: colors.ink, fontSize: size, lineHeight: Math.round(size * 1.45), ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const muted = { ...body(13), color: colors.muted };
  const change = (field: DetailsField, value: string) => {
    setForm(current => ({ ...current, [field]: value }));
    setErrors(current => { if (!current[field]) return current; const { [field]: _removed, ...rest } = current; return rest; });
    setNotice('');
  };
  const focusField = (errs: DetailsErrors) => { const field = firstErrorField(errs); if (field) setTimeout(() => refs.current[field]?.focus(), 0); };

  const save = async () => {
    if (load.kind !== 'ready' || savingRef.current || problem?.kind === 'conflict' || problem?.kind === 'denied') return;
    setNotice(''); setProblem(null);
    const result = validateDetailsForm(form, load.settings.version);
    if (!result.ok) {
      setErrors(result.errors);
      if (result.formError) setProblem({ kind: 'unconfirmed', message: `${result.formError} Reload to continue.` });
      focusField(result.errors); return;
    }
    setErrors({}); savingRef.current = true; setSaving(true);
    const id = requestId.current;
    try {
      const saved = await services.saveRestaurantSettings(result.input);
      if (id !== requestId.current) return;
      setForm(formFromSettings(saved)); setLoad(current => current.kind === 'ready' ? { kind: 'ready', settings: saved, view: current.view } : current); setNotice('Restaurant details saved.');
    } catch (error) {
      if (id !== requestId.current) return;
      if (error instanceof RestaurantSettingsValidationError) { const next = serverFieldErrors(error.fields); setErrors(next); focusField(next); if (!Object.keys(next).length) setProblem({ kind: 'error', message: error.message }); }
      else if (error instanceof ServiceError && error.code === 'SETTINGS_CHANGED') setProblem({ kind: 'conflict', message: conflictMessage });
      else if (error instanceof ServiceError && error.code === 'ADMIN_REQUIRED') setProblem({ kind: 'denied', message: noAccessMessage });
      else if (error instanceof ServiceError && ['INVALID_RESPONSE', 'SESSION_CHANGED'].includes(error.code)) setProblem({ kind: 'unconfirmed', message: error.message });
      else setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Could not save. Please try again.' });
    } finally { savingRef.current = false; if (id === requestId.current) setSaving(false); }
  };

  const changeHours = (patch: Partial<HoursForm>) => {
    setHoursForm(current => ({ ...current, ...patch }));
    setHoursErrors(current => { const next = { ...current }; for (const key of Object.keys(patch)) delete next[key as keyof HoursErrors]; delete next.openingHours; return next; });
    setHoursNotice('');
  };
  const focusHours = (errs: HoursErrors) => { const name = errs.opensAt ? 'opensAt' : errs.closesAt ? 'closesAt' : null; if (name) setTimeout(() => hoursRefs.current[name]?.focus(), 0); };
  const saveHours = async () => {
    if (load.kind !== 'ready' || savingRef.current || problem?.kind === 'conflict' || problem?.kind === 'denied') return;
    setHoursNotice(''); setProblem(null);
    const result = validateHoursForm(hoursForm, load.settings.version);
    if (!result.ok) { setHoursErrors(result.errors); focusHours(result.errors); return; }
    setHoursErrors({}); savingRef.current = true; setSaving(true);
    const id = requestId.current;
    try {
      const saved = await services.saveOpeningHours(result.input);
      if (id !== requestId.current) return;
      // The other fields' form must now save against the version this write produced.
      setHoursForm(hoursFormFrom(saved.openingHours));
      setLoad(current => current.kind === 'ready' ? { kind: 'ready', settings: { ...current.settings, version: saved.version }, view: { ...current.view, version: saved.version, openingHours: saved.openingHours } } : current);
      setHoursNotice('Opening hours saved.');
    } catch (error) {
      if (id !== requestId.current) return;
      if (error instanceof OpeningHoursValidationError) { setHoursErrors(error.fields); focusHours(error.fields); if (!Object.keys(error.fields).length) setProblem({ kind: 'error', message: error.message }); }
      else if (error instanceof ServiceError && error.code === 'SETTINGS_CHANGED') setProblem({ kind: 'conflict', message: conflictMessage });
      else if (error instanceof ServiceError && error.code === 'ADMIN_REQUIRED') setProblem({ kind: 'denied', message: noAccessMessage });
      else if (error instanceof ServiceError && ['INVALID_RESPONSE', 'SESSION_CHANGED'].includes(error.code)) setProblem({ kind: 'unconfirmed', message: error.message });
      else setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Could not save. Please try again.' });
    } finally { savingRef.current = false; if (id === requestId.current) setSaving(false); }
  };

  const hoursField = (name: 'opensAt' | 'closesAt') => {
    const label = hoursLabels[name], error = hoursErrors[name], labelId = `restaurant-details-${name}-label`, errorId = `restaurant-details-${name}-error`, hintId = 'restaurant-details-hours-hint';
    return <View key={name} style={{ gap: 8 }}>
      <Text nativeID={labelId} style={{ ...body(15), ...bold }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: error ? 2 : 1, borderColor: error ? colors.danger : colors.fieldBorder, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14 }}>
        <TextInput ref={node => { hoursRefs.current[name] = node; }} value={hoursForm[name]} editable={!saving} onChangeText={value => changeHours({ [name]: value })} onSubmitEditing={() => void saveHours()}
          accessibilityLabel={label} aria-labelledby={labelId} aria-label={label} aria-invalid={error ? true : undefined} aria-describedby={[error ? errorId : '', hintId].filter(Boolean).join(' ')} accessibilityHint={error}
          placeholder={name === 'opensAt' ? '09:00' : '19:30'} autoComplete="off" autoCorrect={false} autoCapitalize="none" returnKeyType="done"
          style={{ flex: 1, minHeight: 48, color: colors.ink, fontSize: 16, ...(fonts.body ? { fontFamily: fonts.body } : {}), ...({ outlineStyle: 'none' } as object) }} />
        {name === 'closesAt' ? <Pressable accessibilityRole="button" accessibilityLabel="Close at midnight" disabled={saving} onPress={() => changeHours({ closesAt: clockText('00:00', true) })} style={{ minHeight: 44, justifyContent: 'center', paddingLeft: 8 }}><Text style={{ color: colors.primary, fontSize: 15, ...bold }}>Midnight</Text></Pressable> : null}
      </View>
      {error ? <Text nativeID={errorId} role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{error}</Text> : null}
    </View>;
  };

  const field = (name: DetailsField, opts: { optional?: boolean; hint?: string; money?: boolean }) => {
    const label = labels[name], accessibleName = opts.optional ? `${label} (optional)` : label, error = errors[name];
    const labelId = `restaurant-details-${name}-label`, errorId = `restaurant-details-${name}-error`, hintId = `restaurant-details-${name}-hint`;
    const describedBy = [error ? errorId : '', opts.hint ? hintId : ''].filter(Boolean).join(' ') || undefined;
    return <View key={name} style={{ gap: 8, flex: opts.money ? 1 : undefined }}>
      <Text nativeID={labelId} style={{ ...body(15), ...bold }}>{label}{opts.optional ? <Text style={{ ...body(14), color: colors.muted, fontWeight: '400' }}>{' (optional)'}</Text> : null}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: error ? 2 : 1, borderColor: error ? colors.danger : colors.fieldBorder, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14, gap: 6 }}>
        {opts.money ? <Text aria-hidden style={body(16)}>₹</Text> : null}
        <TextInput ref={node => { refs.current[name] = node; }} value={form[name]} editable={!saving} onChangeText={value => change(name, value)} onSubmitEditing={() => void save()}
          accessibilityLabel={accessibleName} aria-labelledby={labelId} aria-label={accessibleName} aria-invalid={error ? true : undefined} aria-required={name === 'contactPhone' ? true : undefined} aria-describedby={describedBy}
          accessibilityHint={error} inputMode={opts.money ? 'decimal' : 'tel'} keyboardType={opts.money ? 'decimal-pad' : 'phone-pad'} autoComplete="off" autoCorrect={false} returnKeyType="done"
          style={{ flex: 1, minHeight: 48, color: colors.ink, fontSize: 16, ...(fonts.body ? { fontFamily: fonts.body } : {}), ...({ outlineStyle: 'none' } as object) }} />
      </View>
      {error ? <Text nativeID={errorId} role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{error}</Text> : null}
      {opts.hint ? <Text nativeID={hintId} style={muted}>{opts.hint}</Text> : null}
    </View>;
  };

  // Dirty means the typed fields differ from the settings last loaded or saved (#200); a save replaces that baseline, a failed one keeps it.
  const guard = useDiscardGuard(load.kind === 'ready' && (detailsAreDirty(formFromSettings(load.settings), form) || hoursAreDirty(hoursFormFrom(load.view.openingHours ?? null), hoursForm)), onBack, saving);
  const disabled = load.kind !== 'ready' || saving || problem?.kind === 'conflict' || problem?.kind === 'denied';
  const readOnlyRow = (label: string, value: string) => <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}><Text style={muted}>{label}</Text><Text style={{ ...body(14), ...bold, flexShrink: 1, textAlign: 'right' }}>{value}</Text></View>;

  return <View style={{ flex: 1 }}>
    <View style={{ backgroundColor: colors.background, borderBottomWidth: 1, borderBottomColor: colors.border, paddingTop: insets.top }}>
      <View style={{ width: '100%', maxWidth: 600, alignSelf: 'center', minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to Settings" onPress={guard.requestLeave} style={({ pressed }) => ({ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}><MarketIcon name="back" color={colors.ink} size={22} /></Pressable>
        <Text accessibilityRole="header" aria-level={1} numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: 24, lineHeight: 32, ...(fonts.heading ? { fontFamily: fonts.heading } : { fontWeight: '700' as const }) }}>Restaurant details</Text>
      </View>
    </View>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ width: '100%', maxWidth: 600, alignSelf: 'center', paddingHorizontal: 20, paddingVertical: 24, gap: 28 }}>
      {load.kind === 'loading' ? <MarketStatus kind="loading" title="Loading restaurant details" /> : null}
      {load.kind === 'error' ? <MarketStatus kind="error" title="Could not load restaurant details" message={load.message} action={<MarketButton label="Try again" onPress={reload} />} /> : null}
      {load.kind === 'denied' ? <MarketStatus kind="error" title="No access" message="Your account cannot change restaurant details for this restaurant." /> : null}
      {load.kind === 'ready' ? <>
        <View style={{ gap: 18 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ ...muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Contact</Text>
          {field('contactPhone', { hint: 'Shown on the Call buttons in the customer app.' })}
          {field('whatsappPhone', { optional: true })}
        </View>
        <View style={{ gap: 18 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ ...muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Ordering</Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>{field('deliveryFee', { money: true })}{field('minOrder', { money: true })}</View>
          <Text style={muted}>Changes apply to new orders. Orders already placed keep the fee they were placed with.</Text>
        </View>
        <View style={{ gap: 14 }}>
          <Text accessibilityRole="header" aria-level={2} style={{ ...muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>Opening hours</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <Text aria-hidden style={{ ...body(16), ...bold, flex: 1 }}>Open all day</Text>
            <MarketSwitch label="Open all day" value={hoursForm.allDay} disabled={disabled} onValueChange={allDay => changeHours({ allDay })} />
          </View>
          {hoursForm.allDay ? null : <>
            {hoursField('opensAt')}{hoursField('closesAt')}
            <Text nativeID="restaurant-details-hours-hint" style={muted}>Type a time such as 09:00 or 7:30 pm. India time; the window ends at closing, and Midnight closes at the end of the day.</Text>
          </>}
          {hoursErrors.openingHours ? <Text role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{hoursErrors.openingHours}</Text> : null}
          <Text role="status" accessibilityLiveRegion="polite" style={muted}>{hoursPreview(hoursForm) ?? ''}</Text>
          <Text style={muted}>Outside these hours customers can browse the menu but cannot order. The ordering switch still works within the hours.</Text>
          <MarketButton label="Save opening hours" variant="secondary" disabled={disabled} onPress={() => void saveHours()} />
          {hoursNotice ? <Text role="status" accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...body(15), color: colors.positive, ...bold }}>{hoursNotice}</Text> : null}
        </View>
        <MarketSection muted>
          {readOnlyRow('Delivery area', deliveryAreaText(load.view.deliveryArea))}
          {readOnlyRow('Order numbers', orderNumberFormat(load.view.orderPrefix))}
          <Text style={muted}>Ask your developer to change these.</Text>
        </MarketSection>
      </> : null}
      {problem ? <View role="alert" accessibilityRole="alert" style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: colors.warningTint }}>
        <Text style={{ ...body(15), color: colors.warning, ...bold }}>{problem.message}</Text>
        {problem.kind === 'conflict' || problem.kind === 'unconfirmed' ? <MarketButton label="Reload" variant="secondary" onPress={reload} /> : null}
      </View> : null}
      {notice ? <Text role="status" accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...body(15), color: colors.positive, ...bold }}>{notice}</Text> : null}
    </ScrollView>
    <View style={{ backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 12), paddingTop: 12 }}>
      <View style={{ width: '100%', maxWidth: 600, alignSelf: 'center', paddingHorizontal: 20 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={saving ? 'Saving' : 'Save changes'} accessibilityState={{ disabled, busy: saving }} aria-busy={saving} disabled={disabled} onPress={() => void save()}
          style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 })}>
          <Text style={{ color: colors.onPrimary, fontSize: 16, ...bold }}>{saving ? 'Saving…' : 'Save changes'}</Text>
        </Pressable>
      </View>
    </View>
    {guard.confirm}
  </View>;
}
