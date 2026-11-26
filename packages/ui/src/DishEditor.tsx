import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { MarketSwitch } from './MarketSwitch';
import { MarketGroup, MarketRow } from './MarketList';
import { getDocumentAsync, type DocumentPickerAsset } from 'expo-document-picker';
import { traced } from '@market/notifications';
import { dietLabels, type Diet, type MenuItem } from '@market/core';
import type { MenuCategory, MarketServices } from '@market/services';
import { MarketButton, MarketStatus, MarketText } from './components';
import { MarketIcon } from './MarketIcons';
import { DietMark } from './DietMark';
import { useMarketFonts, useMarketTheme } from './theme';
import { dishDraftErrors, dishSortOrder, featuredLabel, type DishDraft, type DishDraftErrors } from './menu-model';
import { parseRupees, rupeesInput } from './admin-model';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { dishIsDirty } from './discard-model';
import { useDiscardGuard } from './DiscardGuard';

const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const focusById = (id: string) => { if (Platform.OS === 'web' && typeof document !== 'undefined') setTimeout(() => document.getElementById(id)?.focus(), 0); };
/** Green on / dark grey off: both tracks keep 3:1 contrast against white. */
const dietChoices: { diet: Diet; short: string }[] = [{ diet: 'veg', short: 'Veg' }, { diet: 'egg', short: 'Egg' }, { diet: 'non_veg', short: 'Non-veg' }];
const fieldIds: Record<keyof DishDraftErrors, string> = { name: 'dish-name', category: 'dish-category', price: 'dish-price', description: 'dish-description', diet: 'dish-diet-veg' };

/** Add/Edit dish: full-screen on phones. Ordering is by move/drag on the list, so the saved position is kept here. */
export function DishEditor({ item, items, categories, services, onClose, onSaved, onDeleted, reload }: {
  item?: MenuItem; items: readonly MenuItem[]; categories: readonly MenuCategory[]; services: MarketServices;
  onClose: () => void; onSaved: (note: string) => Promise<void>; onDeleted: (name: string) => Promise<void>; reload: () => Promise<boolean>;
}) {
  const { colors, businessId } = useMarketTheme();
  const fonts = useMarketFonts();
  const feature = featuredLabel(businessId, 'admin');
  const demo = services.mode === 'demo';
  const [draft, setDraft] = useState<DishDraft>(() => item
    ? { id: item.id, name: item.name, description: item.description, categoryId: item.categoryId, price: rupeesInput(item.pricePaise), diet: item.diet ?? null, isAvailable: item.isAvailable, isFeatured: item.isFeatured, isDemo: item.isDemo }
    : { name: '', description: '', categoryId: categories.length === 1 ? categories[0].id : '', price: '', diet: null, isAvailable: true, isFeatured: false, isDemo: false });
  // What was opened, or last saved: leaving asks only when the normalized fields differ from it (#200). Photo changes save on their own and never touch the draft.
  const [baseline, setBaseline] = useState<DishDraft>(draft);
  const [validation, setValidation] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [note, setNote] = useState('');
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  // The list reloads after photo changes and reorders; always act on the newest copy.
  const latest = item ? items.find(entry => entry.id === item.id) ?? item : undefined;
  const errors = dishDraftErrors(draft, categories.map(category => category.id), parseRupees(draft.price));
  const shown: DishDraftErrors = validation ? errors : {};
  const set = (changes: Partial<DishDraft>) => setDraft(current => ({ ...current, ...changes }));
  const category = categories.find(entry => entry.id === draft.categoryId);
  const save = async () => {
    if (busy) return;
    const invalid = (Object.keys(fieldIds) as (keyof DishDraftErrors)[]).find(key => errors[key]);
    if (invalid) { setValidation(true); focusById(fieldIds[invalid]); return; }
    setBusy('save'); setError(''); setNote('');
    try {
      await services.saveMenuItem({ id: draft.id, name: draft.name.trim(), description: draft.description.trim(), categoryId: draft.categoryId, pricePaise: parseRupees(draft.price)!, diet: draft.diet, isAvailable: draft.isAvailable, isFeatured: draft.isFeatured, isDemo: draft.isDemo, sortOrder: dishSortOrder(items, draft.categoryId, latest) });
      setBaseline(draft);
      await onSaved(draft.id ? 'Dish saved.' : 'Dish added. Open it again to add a photo.');
    } catch (e) { setError(message(e)); } finally { setBusy(null); }
  };
  const remove = async () => {
    if (!latest || busy) return;
    setBusy('delete'); setDeleteError('');
    try { await services.deleteMenuItem(latest.id); await onDeleted(latest.name); }
    catch (e) { setDeleteError(message(e)); } finally { setBusy(null); }
  };
  const guard = useDiscardGuard(dishIsDirty(baseline, draft), onClose, !!busy);
  const closeDelete = () => { setConfirmDelete(false); restorePanelFocus(trigger.current); };
  const closePhoto = () => { setPhotoOpen(false); restorePanelFocus(trigger.current); };
  const photo = latest?.imageUrl?.replace(/\/card\.webp$/, '/detail.webp');
  // Owners' Edit dish (#114): brand body face and lighter (still 3:1) field outlines.
  const body = fonts.body ? { fontFamily: fonts.body } : {};
  const bold = fonts.bodyBold ? { fontFamily: fonts.bodyBold } : { fontWeight: '700' as const };
  const label = (text: string, optional?: boolean) => <Text style={{ color: colors.ink, fontSize: 15, ...bold }}>{text}{optional ? <Text style={{ color: colors.muted, ...body, fontWeight: '400' }}> (optional)</Text> : null}</Text>;
  const fieldError = (text?: string) => text ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14 }}>{text}</Text> : null;
  const box = { minHeight: 48, borderWidth: 1, borderRadius: 14, backgroundColor: colors.surface, paddingHorizontal: 14 } as const;
  const textField = (id: string, labelText: string, value: string, onChange: (text: string) => void, error?: string, extra?: object, multiline = false) => <View style={{ gap: 8 }}>{label(labelText)}<TextInput nativeID={id} multiline={multiline} accessibilityLabel={labelText} accessibilityState={{ disabled: !!busy }} editable={!busy} value={value} onChangeText={onChange} placeholderTextColor={colors.muted} style={{ ...box, borderColor: error ? colors.danger : colors.fieldBorder, color: colors.ink, fontSize: 16, ...body, ...extra }} />{fieldError(error)}</View>;
  return <AccessiblePanel fullScreen title={item ? 'Edit dish' : 'Add dish'} closeDisabled={!!busy} onClose={() => { if (!busy) guard.requestLeave(); }}
    // Errors sit beside Save: the form is taller than a phone screen.
    footer={<>
      {error ? <MarketStatus kind="error" title="Could not save dish" message={error} action={<MarketButton label="Reload menu" variant="secondary" disabled={!!busy} onPress={() => void reload()} />} /> : null}
      {validation && Object.keys(errors).length ? <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 14, fontWeight: '700', textAlign: 'center' }}>Check the highlighted fields above.</Text> : null}
      <MarketButton label={busy === 'save' ? 'Saving…' : item ? 'Save changes' : 'Save dish'} disabled={!!busy || demo} onPress={() => void save()} />
    </>}>
    <View style={{ gap: 16 }}>
    {demo ? <MarketText>Sample mode: connect the backend to make menu changes.</MarketText> : null}
    {/* Always mounted so changes are announced, but out of the layout while empty (no extra gap above the photo). */}
    <View role="status" aria-live="polite" style={note ? undefined : { position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>{note ? <MarketText>{note}</MarketText> : null}</View>

    <View style={{ height: 180, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.tint }}>
      {photo && failedPhoto !== photo
        ? <Image key={photo} accessibilityLabel={`Photo of ${latest!.name}`} source={{ uri: photo }} onError={() => setFailedPhoto(photo)} resizeMode="cover" style={{ width: '100%', height: '100%' }} />
        : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}><Text style={{ color: colors.muted, fontSize: 15, textAlign: 'center' }}>{item ? 'No photo yet' : 'Save the dish first, then open it again to add a photo.'}</Text></View>}
      {item ? <Pressable accessibilityRole="button" disabled={demo || !!busy} accessibilityState={{ disabled: demo || !!busy }} onPress={() => { trigger.current = capturePanelFocus(); setNote(''); setPhotoOpen(true); }}
        style={({ pressed }) => ({ position: 'absolute', right: 12, bottom: 12, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, justifyContent: 'center', backgroundColor: 'rgba(38,26,22,0.82)', opacity: demo || busy ? 0.5 : pressed ? 0.8 : 1 })}>
        <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>{latest?.imageUrl ? 'Change photo' : 'Add photo'}</Text>
      </Pressable> : null}
    </View>

    {textField('dish-name', 'Dish name', draft.name, name => set({ name }), shown.name)}

    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <View style={{ flex: 3, gap: 8 }}>
        {label('Category')}
        <Pressable nativeID="dish-category" accessibilityRole="button" accessibilityLabel={`Category: ${category?.name ?? 'not chosen'}`} aria-expanded={pickerOpen} accessibilityState={{ expanded: pickerOpen, disabled: !!busy }} disabled={!!busy} onPress={() => setPickerOpen(open => !open)}
          style={{ ...box, borderColor: shown.category ? colors.danger : colors.fieldBorder, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 16, color: category ? colors.ink : colors.muted, ...body }}>{category?.name ?? 'Choose'}</Text>
          <Text accessible={false} aria-hidden style={{ color: colors.muted, fontSize: 14 }}>{pickerOpen ? '▴' : '▾'}</Text>
        </Pressable>
      </View>
      <View style={{ flex: 2, gap: 8 }}>
        {label('Price')}
        <View style={{ ...box, borderColor: shown.price ? colors.danger : colors.fieldBorder, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text accessible={false} aria-hidden style={{ fontSize: 16, color: colors.ink }}>₹</Text>
          <TextInput nativeID="dish-price" accessibilityLabel="Price in rupees" value={draft.price} editable={!busy} onChangeText={price => set({ price })} keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.muted} style={{ flex: 1, minWidth: 0, minHeight: 46, fontSize: 16, color: colors.ink, ...body }} />
        </View>
      </View>
    </View>
    {pickerOpen ? <View role="group" aria-label="Category" style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface, overflow: 'hidden' }}>
      {categories.map((entry, index) => { const selected = entry.id === draft.categoryId; return <Pressable key={entry.id} accessibilityRole="button" aria-pressed={selected} accessibilityState={{ selected }} onPress={() => { set({ categoryId: entry.id }); setPickerOpen(false); focusById('dish-category'); }}
        style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 14, justifyContent: 'center', borderTopWidth: index ? 1 : 0, borderTopColor: colors.border, backgroundColor: selected ? colors.tint : pressed ? colors.background : colors.surface })}>
        <Text style={{ fontSize: 16, color: colors.ink, ...(selected ? bold : body) }}>{entry.name}</Text>
      </Pressable>; })}
    </View> : null}
    {fieldError(shown.category)}{fieldError(shown.price)}

    {textField('dish-description', 'Description (optional)', draft.description, description => set({ description }), shown.description, { minHeight: 96, paddingTop: 12, textAlignVertical: 'top' }, true)}

    <View style={{ gap: 8 }}>
      {label('Veg, egg or non-veg')}
      <View role="group" aria-label="Veg, egg or non-veg" style={{ flexDirection: 'row', gap: 8 }}>
        {dietChoices.map(({ diet, short }) => { const selected = draft.diet === diet; return <Pressable key={diet} nativeID={`dish-diet-${diet}`} accessibilityRole="button" accessibilityLabel={dietLabels[diet]} aria-pressed={selected} accessibilityState={{ selected, disabled: !!busy }} disabled={!!busy} onPress={() => set({ diet })}
          style={{ flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 6, borderRadius: 14, borderWidth: selected ? 2 : 1, borderColor: selected ? colors.ink : colors.fieldBorder, backgroundColor: selected ? colors.tint : colors.surface }}>
          <DietMark diet={diet} compact /><Text style={{ fontSize: 15, color: colors.ink, ...(selected ? bold : body) }}>{short}</Text>
        </Pressable>; })}
      </View>
      {!draft.diet ? <MarketText variant="muted">{draft.id ? 'Not classified yet. No diet mark is shown to customers.' : 'Choose one before saving this dish.'}</MarketText> : null}
      {fieldError(shown.diet)}
    </View>

    <MarketGroup inset>
      <MarketRow title="Available to order" detail={'Off shows "Currently unavailable"'} end={<MarketSwitch label="Available to order" value={draft.isAvailable} disabled={!!busy} onValueChange={isAvailable => set({ isAvailable })} />} />
      <MarketRow title={feature} detail={businessId === 'ammu-sammu' ? 'Shown big at the top of the menu while available' : 'Shown with the signature dishes at the top of the menu while available'} end={<MarketSwitch label={feature} value={draft.isFeatured} disabled={!!busy} onValueChange={isFeatured => set({ isFeatured })} />} />
      <MarketRow title="Sample dish" detail="For testing; labelled as a sample" end={<MarketSwitch label="Sample dish" value={draft.isDemo} disabled={!!busy} onValueChange={isDemo => set({ isDemo })} />} />
    </MarketGroup>

    {item ? <Pressable accessibilityRole="button" disabled={demo || !!busy} accessibilityState={{ disabled: demo || !!busy }} onPress={() => { trigger.current = capturePanelFocus(); setDeleteError(''); setConfirmDelete(true); }}
      style={({ pressed }) => ({ alignSelf: 'flex-start', minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, opacity: demo || busy ? 0.5 : pressed ? 0.7 : 1 })}>
      <MarketIcon name="trash" color={colors.danger} size={18} />
      <Text style={{ color: colors.danger, fontSize: 16, ...bold }}>Delete this dish</Text>
    </Pressable> : null}
    </View>

    {photoOpen && latest ? <MenuPhotoEditor item={latest} services={services} onClose={closePhoto} onSaved={async text => { if (!await reload()) throw new Error('Could not reload the menu. Retry loading before changing the photo.'); setNote(text); }} /> : null}
    {confirmDelete && latest ? <AccessiblePanel title={`Delete ${latest.name}?`} onClose={() => { if (!busy) closeDelete(); }}>
      <MarketText>This removes the dish from the menu. Customers will no longer see it.</MarketText>
      {deleteError ? <MarketStatus kind="error" title="Could not delete dish" message={deleteError} /> : null}
      <MarketButton label={busy === 'delete' ? 'Deleting…' : 'Delete dish'} disabled={!!busy} onPress={() => void remove()} />
      <MarketButton label="Keep dish" variant="secondary" disabled={!!busy} onPress={closeDelete} />
    </AccessiblePanel> : null}
    {guard.confirm}
  </AccessiblePanel>;
}

function MenuPhotoEditor({ item, services, onSaved, onClose }: {
  item: MenuItem; services: MarketServices; onSaved: (message: string) => Promise<void>; onClose: () => void;
}) {
  const { colors } = useMarketTheme();
  const [selected, setSelected] = useState<DocumentPickerAsset | null>(null);
  const [preview, setPreview] = useState<string | undefined>(item.imageUrl);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (!selected) { setPreview(item.imageUrl); return; }
    // Expo's web picker already owns a blob URL for this asset.
    const uri = selected.uri;
    setPreview(uri); setBroken(false);
    return () => { if (Platform.OS === 'web' && uri.startsWith('blob:')) URL.revokeObjectURL(uri); };
  }, [selected, item.imageUrl]);
  const choose = async () => {
    if (active.current) return;
    setError('');
    try {
      const result = await getDocumentAsync({ type: ['image/jpeg', 'image/png', 'image/webp'], multiple: false, copyToCacheDirectory: true, base64: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      if ((asset.size ?? asset.file?.size ?? 0) > 5 * 1024 * 1024) {
        if (Platform.OS === 'web' && asset.uri.startsWith('blob:')) URL.revokeObjectURL(asset.uri);
        setError('Choose a photo up to 5 MB.'); return;
      }
      setSelected(asset);
    } catch { setError('The photo picker could not open. Please try again.'); }
  };
  const save = async (remove = false) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError('');
    let sent = false;
    try {
      let bytes: ArrayBuffer | undefined;
      if (!remove) {
        if (!selected) throw new Error('Choose a photo first.');
        if (Platform.OS === 'web') {
          if (!selected.file) throw new Error('Choose this photo again.');
          bytes = await selected.file.arrayBuffer();
        } else {
          const { File } = await import('expo-file-system');
          bytes = await new File(selected.uri).arrayBuffer();
        }
        if (!bytes.byteLength || bytes.byteLength > 5 * 1024 * 1024) throw new Error('Choose a photo up to 5 MB.');
      }
      sent = true;
      const result = remove ? await services.removeMenuPhoto(item) : await traced('photo_upload', () => services.uploadMenuPhoto(item, bytes!));
      await onSaved(`${remove ? 'Photo removed.' : 'Photo saved.'}${result.cleanupComplete ? '' : ' Old photos are queued for cleanup; use Retry photo cleanup.'}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The photo could not be saved.');
      // A lost HTTP response may follow a successful attachment. Require a fresh
      // dish snapshot before retrying, preserving optimistic concurrency.
      setUncertain(sent);
    } finally { active.current = false; setBusy(false); }
  };
  return <AccessiblePanel title={`Photo for ${item.name}`} onClose={() => { if (!busy) onClose(); }}>
    <View style={{ height: 200, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' }}>
      {preview && !broken ? <Image accessibilityLabel={item.name} source={{ uri: preview }} onError={() => setBroken(true)} style={{ width: '100%', height: '100%' }} resizeMode="contain" /> : <MarketText variant="muted">No photo</MarketText>}
    </View>
    <MarketText variant="muted">Use your restaurant’s own JPEG, PNG or WebP, up to 5 MB and 16 megapixels. Photos are checked and resized before saving.</MarketText>
    {selected ? <MarketText>Selected: {selected.name}</MarketText> : null}
    {error ? <MarketStatus kind="error" title="Could not save photo" message={error} /> : null}
    {uncertain ? <><MarketText>Reload the dish to check its current photo before trying again.</MarketText><MarketButton label="Reload dish photo" disabled={busy} onPress={() => { void onSaved('Current photo reloaded.').then(onClose).catch(() => setError('Could not reload the menu. Close and retry loading it.')); }} /></> : <>
      <MarketButton label={selected || item.imageUrl ? 'Choose another photo' : 'Choose photo'} variant="secondary" disabled={busy} onPress={() => void choose()} />
      <MarketButton label={busy ? 'Saving photo…' : item.imageUrl ? 'Replace photo' : 'Upload photo'} disabled={busy || !selected} onPress={() => void save()} />
      {item.imageUrl ? <MarketButton label="Remove photo" variant="secondary" disabled={busy} onPress={() => void save(true)} /> : null}
    </>}
    <MarketButton label={busy ? 'Please wait…' : 'Close photo editor'} variant="secondary" disabled={busy} onPress={onClose} />
  </AccessiblePanel>;
}
