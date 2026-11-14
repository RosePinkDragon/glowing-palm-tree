import { useEffect, useRef, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { dietLabels, formatINRFromPaise, type Diet, type MenuItem } from '@market/core';
import type { MenuCategory, MarketServices } from '@market/services';
import { MarketButton, MarketCard, MarketField, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { useMarketTheme } from './theme';
import { featuredLabel, parseItemOrder, sortCategories, sortMenuItems } from './menu-model';
import { parseRupees, rupeesInput } from './admin-model';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';

type Draft = { diet: Diet | null; id?: string; name: string; description: string; categoryId: string; price: string; isAvailable: boolean; isDemo: boolean; isFeatured: boolean; order: string };
const blank = (): Draft => ({ diet: null, name: '', description: '', categoryId: '', price: '', isAvailable: true, isDemo: false, isFeatured: false, order: '0' });
const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
export function AdminMenu({ services }: { services: MarketServices }) {
  const { colors, businessId } = useMarketTheme();
  const featureLabel = featuredLabel(businessId, 'admin');
  const trigger = useRef<HTMLElement | null>(null);
  const closeDraft = () => { setDraft(null); restorePanelFocus(trigger.current); };
  const closeRemove = () => { setRemove(null); restorePanelFocus(trigger.current); };
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [categoryDraft, setCategoryDraft] = useState<{ id?: string; name: string; order: string } | null>(null);
  const [removeCategory, setRemoveCategory] = useState<MenuCategory | null>(null);
  const closeCategory = () => { setCategoryDraft(null); setRemoveCategory(null); restorePanelFocus(trigger.current); };
  const [items, setItems] = useState<MenuItem[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remove, setRemove] = useState<MenuItem | null>(null);
  const [error, setError] = useState('');
  const [operationError, setOperationError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState(false);
  const load = async () => { setLoading(true); try { const [menu, groups] = await Promise.all([services.getMenu(), services.getCategories()]); setItems(menu); setCategories(sortCategories(groups)); setError(''); return true; } catch (e) { setError(message(e)); return false; } finally { setLoading(false); } };
  useEffect(() => { void load(); }, [services]);
  const save = async () => {
    if (!draft) return;
    const pricePaise = parseRupees(draft.price);
    const sortOrder = parseItemOrder(draft.order);
    if (sortOrder === null || (!draft.id && !draft.diet) || !draft.name.trim() || !categories.some(category => category.id === draft.categoryId) || pricePaise === null || pricePaise <= 0 || pricePaise > 2147483647) { setValidation(true); return; }
    setBusy(true); setOperationError(''); setSuccess('');
    try { await services.saveMenuItem({ diet: draft.diet, id: draft.id, name: draft.name.trim(), description: draft.description.trim(), categoryId: draft.categoryId, pricePaise, isAvailable: draft.isAvailable, isDemo: draft.isDemo, isFeatured: draft.isFeatured, sortOrder }); setSuccess('Item saved.'); await load(); closeDraft(); }
    catch (e) { setOperationError(message(e)); } finally { setBusy(false); }
  };
  const deleteItem = async () => {
    if (!remove) return;
    setBusy(true); setOperationError(''); setSuccess('');
    try { await services.deleteMenuItem(remove.id); setRemove(null); setSuccess('Item deleted.'); await load(); if (typeof document !== 'undefined') setTimeout(() => document.getElementById('admin-menu-heading')?.focus(), 0); } catch (e) { setOperationError(message(e)); } finally { setBusy(false); }
  };
  const saveCategory = async () => {
    if (!categoryDraft) return;
    const sortOrder = parseItemOrder(categoryDraft.order);
    if (!categoryDraft.name.trim() || [...categoryDraft.name.trim()].length > 100 || sortOrder === null) { setValidation(true); return; }
    setBusy(true); setOperationError(''); setSuccess('');
    try { await services.saveCategory({ id: categoryDraft.id, name: categoryDraft.name.trim(), sortOrder }); setSuccess('Category saved.'); await load(); closeCategory(); }
    catch (e) { setOperationError(message(e)); } finally { setBusy(false); }
  };
  const deleteCategory = async () => {
    if (!removeCategory) return;
    setBusy(true); setOperationError(''); setSuccess('');
    try { await services.deleteCategory(removeCategory.id); setRemoveCategory(null); if (await load()) setSuccess('Category deleted.'); if (typeof document !== 'undefined') setTimeout(() => document.getElementById('admin-menu-heading')?.focus(), 0); }
    catch (e) { setOperationError(message(e)); } finally { setBusy(false); }
  };
  const openCategory = (category?: MenuCategory) => { trigger.current = capturePanelFocus(); setValidation(false); setOperationError(''); setCategoryDraft(category ? { id: category.id, name: category.name, order: String(category.sortOrder) } : { name: '', order: '0' }); };
  return <View style={{ gap: 16 }}>
    <Text nativeID="admin-menu-heading" accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 22, fontWeight: '700' }}>Menu</Text>
    <MarketText variant="muted">Manage availability and prices. Sample items are clearly labelled.</MarketText>
    {services.mode === 'demo' ? <MarketText>Sample mode: connect the backend to make menu changes.</MarketText> : null}
    {success ? <View role="status" aria-live="polite"><MarketText>{success}</MarketText></View> : null}
    {error ? <MarketStatus kind="error" title="Could not complete the request" message={error} action={<MarketButton label="Retry loading menu" variant="secondary" onPress={() => void load()} />} /> : null}
    {loading ? <MarketStatus kind="loading" title="Loading menu" /> : null}
    <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: colors.ink }}>Categories</Text>
    <MarketText variant="muted">Lower category order numbers appear first. Ties are sorted by name.</MarketText>
    <MarketButton label="Add category" variant="secondary" onPress={() => openCategory()} disabled={services.mode === 'demo' || busy || loading || !!error} />
    {!loading && !error && !categories.length ? <MarketText>Add a category before adding a dish.</MarketText> : null}
    {categories.map(category => {
      const count = items.filter(item => item.categoryId === category.id).length;
      return <MarketCard key={category.id}><MarketText variant="heading">{category.name}</MarketText><MarketText variant="muted">Order {category.sortOrder} · {count} {count === 1 ? 'dish' : 'dishes'}</MarketText>
        <MarketButton label={`Edit category ${category.name}`} variant="secondary" disabled={services.mode === 'demo' || busy || loading || !!error} onPress={() => openCategory(category)} />
        <MarketButton label={`Delete category ${category.name}`} variant="secondary" disabled={services.mode === 'demo' || busy || loading || !!error || count > 0} onPress={() => { trigger.current = capturePanelFocus(); setOperationError(''); setRemoveCategory(category); }} />
        {count ? <MarketText variant="muted">Move all dishes to another category before deleting this category.</MarketText> : null}
      </MarketCard>;
    })}
    {categoryDraft ? <AccessiblePanel title={categoryDraft.id ? 'Edit category' : 'Add category'} onClose={() => { if (!busy) closeCategory(); }}>
      {operationError ? <MarketStatus kind="error" title="Could not save category" message={operationError} /> : null}
      <MarketField label="Category name" value={categoryDraft.name} editable={!busy} onChangeText={name => setCategoryDraft({ ...categoryDraft, name })} error={validation && (!categoryDraft.name.trim() || [...categoryDraft.name.trim()].length > 100) ? 'Enter a name from 1 to 100 characters.' : undefined} />
      <MarketField label="Category order" value={categoryDraft.order} editable={!busy} onChangeText={order => setCategoryDraft({ ...categoryDraft, order })} error={validation && parseItemOrder(categoryDraft.order) === null ? 'Enter a whole number from -2,147,483,648 to 2,147,483,647.' : undefined} />
      <MarketText variant="muted">Lower numbers appear first. Ties are sorted by name.</MarketText>
      <MarketButton label={busy ? 'Saving…' : 'Save category'} disabled={busy} onPress={() => void saveCategory()} /><MarketButton label="Cancel" variant="secondary" disabled={busy} onPress={closeCategory} />
    </AccessiblePanel> : null}
    {removeCategory ? <AccessiblePanel title={`Delete category ${removeCategory.name}?`} onClose={() => { if (!busy) closeCategory(); }}><MarketText>This removes the empty category from the menu.</MarketText>{operationError ? <MarketStatus kind="error" title="Could not delete category" message={operationError} /> : null}<MarketButton label={busy ? 'Deleting…' : 'Confirm delete category'} disabled={busy} onPress={() => void deleteCategory()} /><MarketButton label="Keep category" variant="secondary" disabled={busy} onPress={closeCategory} /></AccessiblePanel> : null}
    <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: '700', color: colors.ink }}>Dishes</Text>
    {draft ? <AccessiblePanel title={draft.id ? 'Edit item' : 'Add item'} onClose={() => { if (!busy) closeDraft(); }}>
      {operationError ? <MarketStatus kind="error" title="Could not save item" message={operationError} action={<MarketButton label="Reload categories" variant="secondary" disabled={busy || loading} onPress={() => void load()} />} /> : null}
      <MarketField label="Name" value={draft.name} onChangeText={name => setDraft({ ...draft, name })} error={validation && !draft.name.trim() ? 'Enter a name.' : undefined} />
      <View style={{ gap: 8 }}><MarketText>Category</MarketText><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {categories.map(category => <Pressable key={category.id} accessibilityRole="button" accessibilityLabel={`Category: ${category.name}`} aria-pressed={draft.categoryId === category.id} accessibilityState={{ selected: draft.categoryId === category.id, disabled: busy }} disabled={busy} onPress={() => setDraft({ ...draft, categoryId: category.id })} style={{ minHeight: 48, padding: 12, borderWidth: draft.categoryId === category.id ? 2 : 1, borderRadius: 10, borderColor: colors.inputBorder, backgroundColor: draft.categoryId === category.id ? colors.tint : colors.surface }}><MarketText>{category.name}</MarketText></Pressable>)}
      </View>{validation && !categories.some(category => category.id === draft.categoryId) ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>Choose a category. Reload the menu if it is no longer available.</Text> : null}</View>
      <MarketField label="Description" value={draft.description} onChangeText={description => setDraft({ ...draft, description })} multiline />
      <MarketField label="Price in rupees" value={draft.price} onChangeText={price => setDraft({ ...draft, price })} keyboardType="decimal-pad" error={validation && (parseRupees(draft.price) === null || parseRupees(draft.price)! <= 0 || parseRupees(draft.price)! > 2147483647) ? 'Enter a positive amount up to 21,474,836.47 with up to two decimal places.' : undefined} />
      <View style={{ gap: 8 }}>
        <MarketText>Diet classification</MarketText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(['veg', 'egg', 'non_veg'] as const).map(diet => <Pressable key={diet} accessibilityRole="button" accessibilityLabel={dietLabels[diet]} aria-pressed={draft.diet === diet} accessibilityState={{ selected: draft.diet === diet, disabled: busy }} disabled={busy} onPress={() => setDraft({ ...draft, diet })} style={{ minHeight: 48, padding: 10, borderWidth: draft.diet === diet ? 2 : 1, borderRadius: 10, borderColor: colors.inputBorder, backgroundColor: draft.diet === diet ? colors.tint : colors.surface }}><DietMark diet={diet} /></Pressable>)}
        </View>
        {!draft.diet ? <MarketText variant="muted">{draft.id ? 'Not classified yet. No diet mark is shown to customers.' : 'Choose a diet classification before saving this dish.'}</MarketText> : null}
        {validation && !draft.id && !draft.diet ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>Choose a diet classification.</Text> : null}
      </View>
      <MarketField label="Order within category" value={draft.order} onChangeText={order => setDraft({ ...draft, order })} error={validation && parseItemOrder(draft.order) === null ? 'Enter a whole number from -2,147,483,648 to 2,147,483,647.' : undefined} />
      <MarketText variant="muted">Lower numbers appear first within a category. Ties are sorted by name.</MarketText>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><MarketText>{featureLabel}</MarketText><Switch accessibilityLabel={featureLabel} value={draft.isFeatured} onValueChange={isFeatured => setDraft({ ...draft, isFeatured })} /></View>
      <MarketText variant="muted">Featured dishes appear only while available.</MarketText>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><MarketText>Available</MarketText><Switch accessibilityLabel="Available" value={draft.isAvailable} onValueChange={isAvailable => setDraft({ ...draft, isAvailable })} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><MarketText>Sample item</MarketText><Switch accessibilityLabel="Sample item" value={draft.isDemo} onValueChange={isDemo => setDraft({ ...draft, isDemo })} /></View>
      <MarketButton label={busy ? 'Saving…' : 'Save item'} onPress={() => void save()} disabled={busy || services.mode === 'demo'} />
      <MarketButton label="Cancel" variant="secondary" onPress={closeDraft} disabled={busy} />
    </AccessiblePanel> : <MarketButton label="Add item" onPress={() => { trigger.current = capturePanelFocus(); setOperationError(''); setValidation(false); setDraft(blank()); }} disabled={services.mode === 'demo' || loading || !!error || !categories.length || busy} />}
    {remove ? <AccessiblePanel title={`Delete ${remove.name}?`} onClose={() => { if (!busy) closeRemove(); }}><MarketText>This removes the item from the menu.</MarketText>{operationError ? <MarketStatus kind="error" title="Could not delete item" message={operationError} /> : null}<MarketButton label={busy ? 'Deleting…' : 'Confirm delete'} onPress={() => void deleteItem()} disabled={busy} /><MarketButton label="Keep item" variant="secondary" onPress={closeRemove} disabled={busy} /></AccessiblePanel> : null}
    {!loading && !items.length && !error ? <MarketStatus kind="empty" title="No menu items yet" message="Add an item to get started." /> : null}
    {sortMenuItems(items).map(item => <MarketCard key={item.id}><MarketText variant="heading">{item.name}</MarketText><DietMark diet={item.diet} /><MarketText>{item.category} · {formatINRFromPaise(item.pricePaise)}</MarketText><MarketText variant="muted">{item.isAvailable ? 'Available' : 'Unavailable'}{item.isDemo ? ' · Sample item' : ''}{item.isFeatured ? ` · ${featureLabel}` : ''}{` · Order ${item.sortOrder}`}</MarketText>{item.description ? <MarketText>{item.description}</MarketText> : null}<MarketButton label={`Edit ${item.name}`} variant="secondary" disabled={services.mode === 'demo' || busy} onPress={() => { trigger.current = capturePanelFocus(); setOperationError(''); setValidation(false); setDraft({ ...item, diet: item.diet ?? null, price: rupeesInput(item.pricePaise), order: String(item.sortOrder) }); }} /><MarketButton label={`Delete ${item.name}`} variant="secondary" disabled={services.mode === 'demo' || busy} onPress={() => { trigger.current = capturePanelFocus(); setOperationError(''); setRemove(item); }} /></MarketCard>)}
  </View>;
}
