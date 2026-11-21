import { createElement, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import { formatINRFromPaise } from '@market/core';
import { OfferValidationError, OwnerOfferError, type MarketServices, type OfferField, type OwnerOffer } from '@market/services';
import { MarketButton } from './components';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { MarketChip, MarketPill } from './MarketChips';
import { MarketLine, MarketSection } from './MarketList';
import { MarketSwitch } from './MarketSwitch';
import { useMarketFonts, useMarketTheme } from './theme';
import { emptyOfferForm, firstOfferError, formFromOffer, istInput, formatIst, formatWindow, kindLabels, offerActions, offerApplied, offerEndedMessage, offerLockedMessage, offerSummary, offerUsage, serverOfferErrors, statusLabels, statusTones, validateLockedForm, validateOfferForm, weekdayLong, weekdayShort, type OfferForm, type OfferFormErrors } from './offers-model';

// Owners' offer form (#182 slice B): create, edit, and for an offer that has been used, only its name and end date.
// Terms are read-only once an offer has been redeemed; pause, resume and end live here too.
type Problem = { kind: 'stale' | 'locked' | 'missing' | 'error'; message: string };
type Busy = 'save' | 'pause' | 'resume' | 'end' | null;
type FieldKey = OfferField | 'windowFrom' | 'windowTo';
const notes = { pause: 'Offer paused.', resume: 'Offer resumed.', end: 'Offer ended.' } as const;

export function OwnerOfferForm({ services, offer, onClose, onSaved, onReload }: {
  services: MarketServices; offer?: OwnerOffer; onClose: () => void; onSaved: (saved: OwnerOffer, note: string) => void; onReload: (id: string) => void;
}) {
  const { colors } = useMarketTheme();
  const fonts = useMarketFonts();
  const locked = offer?.termsLocked === true;
  // An ended offer is view only: its end date could otherwise quietly bring it back to life.
  const ended = offer?.status === 'ended';
  const [form, setForm] = useState<OfferForm>(() => offer ? formFromOffer(offer) : emptyOfferForm());
  const [errors, setErrors] = useState<OfferFormErrors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const busyRef = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const refs = useRef<Partial<Record<FieldKey, { focus(): void } | null>>>({});
  const body = (size = 15) => ({ color: colors.ink, fontSize: size, lineHeight: Math.round(size * 1.45), ...(fonts.body ? { fontFamily: fonts.body } : {}) });
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const muted = { ...body(13), color: colors.muted };
  const actions = offer ? offerActions(offer) : null;
  const blocked = ended || problem?.kind === 'stale' || problem?.kind === 'locked' || problem?.kind === 'missing';

  const set = (changes: Partial<OfferForm>, ...cleared: FieldKey[]) => {
    setForm(current => ({ ...current, ...changes }));
    setErrors(current => { const next = { ...current }; for (const key of cleared) delete next[key as OfferField]; return next; });
  };
  const focus = (errs: OfferFormErrors) => { const field = firstOfferError(errs); const key: FieldKey | undefined = field === 'window' ? 'windowFrom' : field; if (key) setTimeout(() => refs.current[key]?.focus(), 0); };

  /** One place for every failed write: field errors stay on their field, everything else is a banner. */
  const failed = (error: unknown) => {
    setConfirmEnd(false);
    if (error instanceof OfferValidationError) { const next = serverOfferErrors(error.fields, form.kind); setErrors(next); focus(next); return; }
    if (error instanceof OwnerOfferError && error.code === 'OFFER_CODE_TAKEN') { const next = { code: error.message }; setErrors(next); focus(next); return; }
    if (error instanceof OwnerOfferError) { setProblem({ kind: error.code === 'OFFER_STALE' ? 'stale' : error.code === 'OFFER_LOCKED' ? 'locked' : 'missing', message: error.message }); return; }
    setProblem({ kind: 'error', message: error instanceof Error ? error.message : 'Please try again.' });
  };
  const run = async (kind: Exclude<Busy, null>, write: () => Promise<OwnerOffer>, note: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(kind); setProblem(null);
    try { onSaved(await write(), note); } catch (error) { failed(error); } finally { busyRef.current = false; setBusy(null); }
  };
  const save = () => {
    if (busyRef.current || blocked) return;
    setProblem(null);
    if (offer && locked) {
      const checked = validateLockedForm(form);
      if (!checked.ok) { setErrors(checked.errors); focus(checked.errors); return; }
      setErrors({}); void run('save', () => services.updateOffer(offer.id, offer.version, checked.patch), 'Offer saved.'); return;
    }
    const checked = validateOfferForm(form);
    if (!checked.ok) { setErrors(checked.errors); focus(checked.errors); return; }
    setErrors({});
    void run('save', () => offer ? services.updateOffer(offer.id, offer.version, checked.input) : services.createOffer(checked.input), offer ? 'Offer saved.' : 'Offer created.');
  };
  const act = (kind: 'pause' | 'resume' | 'end') => { if (offer) void run(kind, () => services[`${kind}Offer`](offer.id, offer.version), notes[kind]); };

  const ids = (key: string) => ({ label: `offer-${key}-label`, error: `offer-${key}-error`, hint: `offer-${key}-hint` });
  const field = (key: FieldKey, label: string, value: string, onChange: (text: string) => void, o: { optional?: boolean; hint?: string; prefix?: string; suffix?: string; numeric?: boolean; placeholder?: string; capitals?: boolean; errorKey?: OfferField; flex?: boolean; picker?: 'datetime-local' | 'time'; min?: string } = {}) => {
    const error = errors[o.errorKey ?? (key as OfferField)], id = ids(key), name = o.optional ? `${label} (optional)` : label;
    const describedBy = [error ? id.error : '', o.hint ? id.hint : ''].filter(Boolean).join(' ') || undefined;
    // On the web, dates and times come from the browser's own pickers. Their values are IST wall time as typed: nothing here ever goes through the device's time zone.
    const web = Platform.OS === 'web' && o.picker !== undefined;
    const shown = o.picker === 'datetime-local' ? value.replace(' ', 'T') : value;
    return <View key={key} style={{ gap: 8, flex: o.flex ? 1 : undefined }}>
      <Text nativeID={id.label} style={{ ...body(15), ...bold }}>{label}{o.optional ? <Text style={{ ...body(14), color: colors.muted, fontWeight: '400' }}>{' (optional)'}</Text> : null}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderWidth: error ? 2 : 1, borderColor: error ? colors.danger : colors.fieldBorder, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14, gap: 6 }}>
        {o.prefix ? <Text aria-hidden style={body(16)}>{o.prefix}</Text> : null}
        {web ? createElement('input', { ref: (node: HTMLInputElement | null) => { refs.current[key] = node; }, type: o.picker, value: shown, min: o.min || undefined, disabled: !!busy, 'aria-label': name, 'aria-labelledby': id.label, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy,
          onChange: (event: { target: { value: string } }) => onChange(event.target.value), onKeyDown: (event: { key: string }) => { if (event.key === 'Enter') save(); },
          style: { flex: 1, minWidth: 0, minHeight: 48, boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', color: colors.ink, fontSize: 16, fontFamily: fonts.body ?? 'inherit' } })
          : <TextInput ref={node => { refs.current[key] = node; }} value={value} editable={!busy} onChangeText={onChange} onSubmitEditing={save} placeholder={o.placeholder} placeholderTextColor={colors.muted} maxLength={40}
          accessibilityLabel={name} aria-labelledby={id.label} aria-label={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy} accessibilityHint={error}
          inputMode={o.numeric ? 'decimal' : 'text'} keyboardType={o.numeric ? 'decimal-pad' : 'default'} autoCapitalize={o.capitals ? 'characters' : 'none'} autoComplete="off" autoCorrect={false} returnKeyType="done"
          style={{ flex: 1, minWidth: 0, minHeight: 48, color: colors.ink, fontSize: 16, ...(fonts.body ? { fontFamily: fonts.body } : {}), ...({ outlineStyle: 'none' } as object) }} />}
        {web && o.optional && value ? <Pressable accessibilityRole="button" accessibilityLabel={`Clear ${label.toLowerCase()}`} disabled={!!busy} onPress={() => onChange('')} style={({ pressed }) => ({ minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}><Text aria-hidden style={{ ...body(14), color: colors.muted, ...bold }}>Clear</Text></Pressable> : null}
        {o.suffix ? <Text aria-hidden style={body(16)}>{o.suffix}</Text> : null}
      </View>
      {error ? <Text nativeID={id.error} role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{error}</Text> : null}
      {o.hint ? <Text nativeID={id.hint} style={muted}>{o.hint}</Text> : null}
    </View>;
  };
  const choice = <T extends string>(id: string, label: string, current: T, options: { value: T; label: string }[], pick: (value: T) => void) => <View style={{ gap: 8 }}>
    <Text nativeID={id} style={{ ...body(15), ...bold }}>{label}</Text>
    <View role="radiogroup" aria-labelledby={id} accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map(option => <MarketChip key={option.value} radio label={option.label} selected={current === option.value} onPress={() => { if (!busy) pick(option.value); }} />)}
    </View>
  </View>;
  const heading = (text: string) => <Text accessibilityRole="header" aria-level={2} style={{ ...muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', ...bold }}>{text}</Text>;
  const switchRow = (title: string, detail: string, value: boolean, onChange: (next: boolean) => void) => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 8 }}>
    <View style={{ flex: 1, gap: 2 }}><Text style={{ ...body(15), ...bold }}>{title}</Text><Text style={muted}>{detail}</Text></View>
    <MarketSwitch label={title} hint={detail} value={value} disabled={!!busy} onValueChange={onChange} />
  </View>;
  const inr = (paise: number) => formatINRFromPaise(paise);
  const row = (label: string, value: string) => <MarketLine key={label} left={<Text style={muted}>{label}</Text>} right={<Text style={{ ...body(14), ...bold, flexShrink: 1, textAlign: 'right' }}>{value}</Text>} />;

  const percent = form.kind === 'percent';
  // Ends cannot be before Starts, nor (for a new offer) in the past. Same IST wall-time format as the picker.
  const startsPicked = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(form.startsAt) ? form.startsAt.replace(' ', 'T') : '';
  const nowIst = istInput(new Date().toISOString()).replace(' ', 'T');
  const endsMin = [startsPicked, nowIst].sort().at(-1) || undefined;
  return <AccessiblePanel fullScreen owner title={offer ? 'Edit offer' : 'New offer'} subtitle={offer ? offer.name : undefined} closeDisabled={!!busy} onClose={() => { if (!busy) onClose(); }}
    footer={<>
      {problem ? <View role="alert" accessibilityRole="alert" style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: colors.warningTint }}>
        <Text style={{ ...body(15), color: colors.warning, ...bold }}>{problem.message}</Text>
        {offer && (problem.kind === 'stale' || problem.kind === 'locked') ? <MarketButton label="Reload offer" variant="secondary" onPress={() => onReload(offer.id)} /> : null}
        {problem.kind === 'missing' ? <MarketButton label="Back to offers" variant="secondary" onPress={onClose} /> : null}
      </View> : null}
      {Object.keys(errors).length ? <Text role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger, ...bold, textAlign: 'center' }}>Check the highlighted fields above.</Text> : null}
      <MarketButton label={busy === 'save' ? 'Saving…' : offer ? 'Save changes' : 'Create offer'} disabled={!!busy || blocked} onPress={save} />
    </>}>
    {offer ? <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <MarketPill label={statusLabels[offer.status]} tone={statusTones[offer.status]} dot />
      <Text style={muted}>{offerSummary(offer)} · {offerApplied(offer)} · {offerUsage(offer)}</Text>
    </View> : null}

    {ended ? null : field('name', 'Offer name', form.name, name => set({ name }, 'name'), { hint: 'Shown to customers. 3 to 40 characters.', placeholder: 'Weekend special' })}

    {locked || ended ? <MarketSection muted title="Terms">
      <Text style={body(14)}>{ended ? offerEndedMessage : offerLockedMessage}</Text>
      {ended ? <>{row('Name', offer!.name)}{row('Ended', formatIst(offer!.endsAt))}</> : null}
      {row('Offer', offerSummary(offer!))}{row('Minimum order', offer!.minOrderPaise ? inr(offer!.minOrderPaise) : 'None')}{row('How applied', offerApplied(offer!))}
      {row('First order only', offer!.firstOrderOnly ? 'Yes' : 'No')}{row('Uses per customer', offer!.perCustomerLimit === null ? 'No limit' : String(offer!.perCustomerLimit))}{row('Total uses', offer!.totalLimit === null ? 'No limit' : String(offer!.totalLimit))}
      {row('Starts', offer!.startsAt ? formatIst(offer!.startsAt) : 'Right away')}{row('Daily window', offer!.window ? formatWindow(offer!.window) : 'All day')}
    </MarketSection> : <>
      <View style={{ gap: 18 }}>
        {heading('Discount')}
        {choice('offer-type-label', 'Offer type', form.kind, (Object.keys(kindLabels) as (keyof typeof kindLabels)[]).map(value => ({ value, label: kindLabels[value] })), kind => set({ kind }, 'value', 'maxDiscount'))}
        {form.kind === 'free_delivery' ? <Text style={muted}>The delivery fee is taken off the order.</Text> : field('value', percent ? 'Discount percent' : 'Discount amount', form.value, value => set({ value }, 'value'), percent ? { suffix: '%', numeric: true, hint: 'A whole percent from 1 to 90.' } : { prefix: '₹', numeric: true, hint: 'From ₹1 to ₹1,000.' })}
        {percent ? field('maxDiscount', 'Maximum discount', form.maxDiscount, maxDiscount => set({ maxDiscount }, 'maxDiscount'), { optional: true, prefix: '₹', numeric: true, hint: 'Caps what one order can save, up to ₹1,000.' }) : null}
        {field('minOrder', 'Minimum order', form.minOrder, minOrder => set({ minOrder }, 'minOrder'), { optional: true, prefix: '₹', numeric: true, hint: 'Checked against the order before the discount, up to ₹10,000.' })}
      </View>
      <View style={{ gap: 18 }}>
        {heading('Availability')}
        {choice('offer-apply-label', 'How customers get it', form.applyMode, [{ value: 'automatic', label: 'Automatic' }, { value: 'code', label: 'With a code' }], applyMode => set({ applyMode }, 'code'))}
        {form.applyMode === 'code' ? field('code', 'Offer code', form.code, text => set({ code: text.toUpperCase() }, 'code'), { capitals: true, placeholder: 'DINNER20', hint: '4 to 15 letters and numbers. Customers can type it in any case.' }) : <Text style={muted}>Customers get the best automatic offer without doing anything.</Text>}
      </View>
      <View style={{ gap: 18 }}>
        {heading('Limits')}
        {switchRow('First order only', 'Only a customer’s first order with you', form.firstOrderOnly, firstOrderOnly => set({ firstOrderOnly }))}
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {field('perCustomerLimit', 'Uses per customer', form.perCustomerLimit, perCustomerLimit => set({ perCustomerLimit }, 'perCustomerLimit'), { optional: true, numeric: true, flex: true })}
          {field('totalLimit', 'Total uses', form.totalLimit, totalLimit => set({ totalLimit }, 'totalLimit'), { optional: true, numeric: true, flex: true })}
        </View>
      </View>
    </>}

    {ended ? null : <View style={{ gap: 18 }}>
      {heading('Dates (India time)')}
      {locked ? null : field('startsAt', 'Starts', form.startsAt, startsAt => set({ startsAt }, 'startsAt', 'endsAt'), { optional: true, picker: 'datetime-local', placeholder: '2026-11-21 18:00', hint: Platform.OS === 'web' ? 'Pick a date and time in India time. Empty starts right away.' : 'Year-month-day and 24-hour time, like 2026-11-21 18:00. Empty starts right away.' })}
      {field('endsAt', 'Ends', form.endsAt, endsAt => set({ endsAt }, 'endsAt'), { optional: true, picker: 'datetime-local', min: endsMin, placeholder: '2026-12-31 23:59', hint: Platform.OS === 'web' ? 'Pick a date and time in India time. Empty runs until you end it.' : locked ? 'Year-month-day and 24-hour time. Empty runs until you end it.' : 'Year-month-day and 24-hour time. Empty runs until you end it.' })}
    </View>}

    {locked || ended ? null : <View style={{ gap: 18 }}>
      {heading('Happy hour')}
      {switchRow('Happy hour window', 'Only on certain days, between two times', form.windowOn, windowOn => set({ windowOn }, 'window'))}
      {form.windowOn ? <>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {field('windowFrom', Platform.OS === 'web' ? 'From' : 'From (24-hour)', form.windowFrom, windowFrom => set({ windowFrom }, 'window'), { placeholder: '15:00', picker: 'time', flex: true })}
          {field('windowTo', Platform.OS === 'web' ? 'To' : 'To (24-hour)', form.windowTo, windowTo => set({ windowTo }, 'window'), { placeholder: '18:00', picker: 'time', flex: true })}
        </View>
        <View style={{ gap: 8 }}>
          <Text nativeID="offer-days-label" style={{ ...body(15), ...bold }}>Days</Text>
          <View role="group" aria-labelledby="offer-days-label" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {weekdayShort.map((short, index) => { const day = index + 1, on = form.windowDays.includes(day); return <MarketChip key={day} label={short} accessibilityLabel={weekdayLong[index]} selected={on} onPress={() => { if (!busy) set({ windowDays: on ? form.windowDays.filter(d => d !== day) : [...form.windowDays, day].sort((a, b) => a - b) }, 'window'); }} />; })}
          </View>
          {errors.window ? <Text nativeID={ids('window').error} role="alert" accessibilityRole="alert" style={{ ...body(14), color: colors.danger }}>{errors.window}</Text> : null}
          <Text style={muted}>A window that ends after midnight, like 22:00 to 02:00, belongs to the day it starts on.</Text>
        </View>
      </> : null}
    </View>}

    {offer && actions && (actions.pause || actions.resume || actions.end) ? <View style={{ gap: 10 }}>
      {heading('Manage')}
      {actions.pause ? <MarketButton label={busy === 'pause' ? 'Pausing…' : 'Pause offer'} variant="secondary" disabled={!!busy || blocked} onPress={() => act('pause')} /> : null}
      {actions.resume ? <MarketButton label={busy === 'resume' ? 'Resuming…' : 'Resume offer'} variant="secondary" disabled={!!busy || blocked} onPress={() => act('resume')} /> : null}
      {actions.end ? <Pressable accessibilityRole="button" accessibilityLabel="End offer" accessibilityState={{ disabled: !!busy || blocked }} disabled={!!busy || blocked} onPress={() => { trigger.current = capturePanelFocus(); setConfirmEnd(true); }}
        style={({ pressed }) => ({ minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: colors.danger, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', opacity: busy || blocked ? 0.5 : pressed ? 0.8 : 1 })}>
        <Text style={{ color: colors.danger, fontSize: 15, ...bold }}>End offer</Text>
      </Pressable> : null}
    </View> : null}

    {confirmEnd && offer ? <AccessiblePanel sheet owner title={`End ${offer.name}?`} closeDisabled={busy === 'end'} onClose={() => { if (busy !== 'end') { setConfirmEnd(false); restorePanelFocus(trigger.current); } }}>
      <Text style={body(15)}>Customers stop getting this offer right away. Orders already placed keep their discount.</Text>
      <MarketButton label={busy === 'end' ? 'Ending…' : 'End offer now'} disabled={busy === 'end'} onPress={() => act('end')} />
      <MarketButton label="Keep offer" variant="secondary" disabled={busy === 'end'} onPress={() => { setConfirmEnd(false); restorePanelFocus(trigger.current); }} />
    </AccessiblePanel> : null}
  </AccessiblePanel>;
}
