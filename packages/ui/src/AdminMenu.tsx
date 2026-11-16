import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, PanResponder, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { MarketSwitch } from './MarketSwitch';
import { formatINRFromPaise, type MenuItem } from '@market/core';
import type { MenuCategory, MarketServices } from '@market/services';
import { MarketButton, MarketField, MarketStatus, MarketText } from './components';
import { DietMark } from './DietMark';
import { useMarketTheme } from './theme';
import { applyCategoryOrder, applyItemOrder, dragTarget, featuredLabel, menuSections, moveId, nextCategoryOrder, sectionSummary, sortCategories, sortMenuItems } from './menu-model';
import { AccessiblePanel, capturePanelFocus, restorePanelFocus } from './AccessiblePanel';
import { DishEditor } from './DishEditor';

const message = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
const errorCode = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
const focusById = (id: string) => { if (Platform.OS === 'web' && typeof document !== 'undefined') setTimeout(() => document.getElementById(id)?.focus(), 0); };
const webOnly = (style: object) => Platform.OS === 'web' ? style : {};

/** Lets a surrounding header (the owners' app shell) show the "Add dish" action. */
export type AdminMenuAddDish = { open: () => void; disabled: boolean };
type CategoryPanel = { kind: 'list' } | { kind: 'edit'; category?: MenuCategory } | { kind: 'delete'; category: MenuCategory };
type Drag = { id: string; categoryId: string; start: number; dy: number; height: number };

/**
 * Owners' Menu: search, category sections, availability switches, reorder by
 * drag or Move up/down, and the Add/Edit dish editor. With `showHeader={false}`
 * the caller renders the title and calls the action given to `onAddDishChange`.
 */
export function AdminMenu({ services, showHeader = true, onAddDishChange }: { services: MarketServices; showHeader?: boolean; onAddDishChange?: (action: AdminMenuAddDish) => void }) {
  const { colors, businessId } = useMarketTheme();
  const feature = featuredLabel(businessId, 'admin');
  const demo = services.mode === 'demo';
  const [items, setItems] = useState<MenuItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const pendingRef = useRef(new Map<string, boolean>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [reordering, setReordering] = useState(false);
  const [arrangeId, setArrangeId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const lastDragEnd = useRef(0);
  const rowHeights = useRef(new Map<string, number>());
  const [editor, setEditor] = useState<{ item?: MenuItem } | null>(null);
  const [panel, setPanel] = useState<CategoryPanel | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const categoryTrigger = useRef<HTMLElement | null>(null);
  const request = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  dragRef.current = drag;

  const load = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const [menu, groups] = await Promise.all([services.getMenu(), services.getCategories()]);
      if (current === request.current) {
        // A switch that is still saving keeps its new position until its own response arrives.
        setItems(menu.map(item => pendingRef.current.has(item.id) ? { ...item, isAvailable: pendingRef.current.get(item.id)! } : item));
        setCategories(sortCategories(groups)); setLoadError('');
      }
      return true;
    } catch (e) { if (current === request.current) setLoadError(message(e)); return false; }
    finally { if (current === request.current) setLoading(false); }
  }, [services]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!reordering && pendingFocus.current) { focusById(pendingFocus.current); pendingFocus.current = null; } }, [reordering]);

  const focusTop = () => focusById(showHeader ? 'admin-menu-heading' : 'admin-menu-search');
  // Background reloads keep Add dish enabled (no flicker, and focus can return to it after saving).
  const addDisabled = demo || !!loadError || !categories.length;
  const openEditor = (item?: MenuItem) => { trigger.current = capturePanelFocus(); setNotice(''); setStatus(''); setArrangeId(null); setEditor({ item }); };
  const openAdd = useRef(openEditor);
  openAdd.current = openEditor;
  const announceAdd = useRef(onAddDishChange);
  announceAdd.current = onAddDishChange;
  // Only a change in availability is reported, so an inline callback cannot cause a render loop.
  useEffect(() => { announceAdd.current?.({ open: () => openAdd.current(), disabled: addDisabled }); }, [addDisabled]);
  const closeEditor = () => { setEditor(null); restorePanelFocus(trigger.current); };
  // A saved dish may have moved to another section, which re-creates its row.
  const closeSaved = () => { const id = editor?.item?.id; setEditor(null); if (id) focusById(`edit-${id}`); else restorePanelFocus(trigger.current); };
  const openCategories = (next: CategoryPanel = { kind: 'list' }) => { categoryTrigger.current = capturePanelFocus(); setNotice(''); setStatus(''); setPanel(next); };
  const closeCategories = () => { setPanel(null); restorePanelFocus(categoryTrigger.current); };
  const categoryName = (id: string) => categories.find(category => category.id === id)?.name ?? '';
  const idsIn = (categoryId: string) => sortMenuItems(items).filter(item => item.categoryId === categoryId).map(item => item.id);

  const toggleAvailability = async (item: MenuItem, next: boolean) => {
    if (pendingRef.current.has(item.id)) return;
    pendingRef.current.set(item.id, next); setPending(new Set(pendingRef.current.keys()));
    setNotice(''); setStatus(''); setRowError(null);
    setItems(current => current.map(entry => entry.id === item.id ? { ...entry, isAvailable: next } : entry));
    try {
      const updated = await services.setMenuItemAvailability(item.id, next);
      pendingRef.current.delete(item.id);
      // Only availability: a late response must not undo a reorder made meanwhile.
      setItems(current => current.map(entry => entry.id === updated.id ? { ...entry, isAvailable: updated.isAvailable } : entry));
      setRowError(current => current?.id === item.id ? null : current);
      setStatus(updated.isAvailable ? `${updated.name} is available to order.` : `${updated.name} now shows as currently unavailable.`);
    } catch (e) {
      pendingRef.current.delete(item.id);
      setItems(current => current.map(entry => entry.id === item.id ? { ...entry, isAvailable: item.isAvailable } : entry));
      setNotice(`Could not ${next ? 'switch on' : 'switch off'} ${item.name}: ${message(e)} Showing the saved menu again.`);
      // Also explain beside the switch, which may be far below the notice.
      setRowError({ id: item.id, text: `Not saved. ${item.name} is still ${item.isAvailable ? 'available' : 'unavailable'}.` });
      void load();
    } finally { setPending(new Set(pendingRef.current.keys())); }
  };

  // Writes the complete order the owner saw; a stale list is rejected and reloaded.
  const saveOrder = async (categoryId: string | null, ids: string[], done: string, focusId?: string) => {
    setReordering(true); setNotice(''); setStatus('');
    if (categoryId) setItems(current => applyItemOrder(current, ids)); else setCategories(current => sortCategories(applyCategoryOrder(current, ids)));
    try {
      if (categoryId) await services.reorderMenuItems(categoryId, ids); else await services.reorderCategories(ids);
      setStatus(done); pendingFocus.current = focusId ?? null;
    } catch (e) {
      const reloaded = await load();
      setNotice(errorCode(e) === 'MENU_CHANGED'
        ? `The menu was changed on another device, so this new order was not saved. ${reloaded ? 'The latest menu is shown; arrange it again.' : 'Retry loading the menu, then arrange it again.'}`
        : `The new order was not saved: ${message(e)} ${reloaded ? 'The saved order is shown again; please try again.' : 'Retry loading the menu, then try again.'}`);
    } finally { setReordering(false); }
  };
  const moveDish = (item: MenuItem, delta: -1 | 1) => {
    const ids = idsIn(item.categoryId), to = ids.indexOf(item.id) + delta, next = moveId(ids, item.id, to);
    if (!next) return;
    const direction = to === 0 ? 'down' : to === ids.length - 1 ? 'up' : delta < 0 ? 'up' : 'down';
    void saveOrder(item.categoryId, next, `${item.name} moved to position ${to + 1} of ${ids.length} in ${categoryName(item.categoryId)}.`, `move-${item.id}-${direction}`);
  };
  const moveCategory = (category: MenuCategory, delta: -1 | 1) => {
    const ids = categories.map(entry => entry.id), to = ids.indexOf(category.id) + delta, next = moveId(ids, category.id, to);
    if (!next) return;
    const direction = to === 0 ? 'down' : to === ids.length - 1 ? 'up' : delta < 0 ? 'up' : 'down';
    void saveOrder(null, next, `${category.name} moved to position ${to + 1} of ${ids.length}.`, `move-category-${category.id}-${direction}`);
  };
  const canArrange = !demo && !reordering && !query.trim() && !loadError;
  const dragStart = (item: MenuItem) => {
    const ids = idsIn(item.categoryId);
    const heights = ids.map(id => rowHeights.current.get(id) ?? 0).filter(height => height > 0);
    setArrangeId(null);
    setDrag({ id: item.id, categoryId: item.categoryId, start: ids.indexOf(item.id), dy: 0, height: heights.length ? Math.min(...heights) : 76 });
  };
  const dragEnd = (dy: number, commit: boolean) => {
    const current = dragRef.current;
    setDrag(null); lastDragEnd.current = Date.now();
    if (!current || !commit) return;
    const ids = idsIn(current.categoryId), to = dragTarget(current.start, dy, current.height, ids.length), next = moveId(ids, current.id, to);
    const item = items.find(entry => entry.id === current.id);
    if (next && item) void saveOrder(current.categoryId, next, `${item.name} moved to position ${to + 1} of ${ids.length} in ${categoryName(current.categoryId)}.`);
  };

  const retryCleanup = () => {
    setCleanupBusy(true); setStatus(''); setNotice('');
    void services.retryMenuPhotoCleanup().then(result => setStatus(result.cleanupComplete ? 'Unused photo cleanup completed.' : 'Some photos are still queued. Please retry in a few minutes.'))
      .catch(e => setNotice(`Photo cleanup did not finish: ${message(e)}`)).finally(() => setCleanupBusy(false));
  };

  const sections = menuSections(items, categories, query);
  const matches = sections.reduce((sum, section) => sum + section.items.length, 0);
  const loadStatus = loadError ? <MarketStatus kind="error" title="Could not load the menu" message={loadError} action={<MarketButton label="Retry loading menu" variant="secondary" onPress={() => void load()} />} /> : null;
  const noticeStatus = notice ? <MarketStatus kind="error" title="Menu not updated" message={notice} action={<MarketButton label="Dismiss" variant="secondary" onPress={() => setNotice('')} />} /> : null;
  return <View style={{ gap: 16 }}>
    {showHeader ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <Text nativeID="admin-menu-heading" accessibilityRole="header" {...({ tabIndex: -1 } as object)} style={{ fontSize: 26, fontWeight: '700', color: colors.ink }}>Menu</Text>
      <AddDishButton action={{ open: () => openEditor(), disabled: addDisabled }} />
    </View> : null}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 12, backgroundColor: colors.surface, paddingLeft: 14 }}>
      <View accessible={false} aria-hidden style={{ width: 16, height: 16 }}>
        <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.muted }} />
        <View style={{ position: 'absolute', right: 0, bottom: 1, width: 6, height: 2, backgroundColor: colors.muted, transform: [{ rotate: '45deg' }] }} />
      </View>
      <TextInput nativeID="admin-menu-search" accessibilityLabel="Search dishes" placeholder={`Search ${items.length} ${items.length === 1 ? 'dish' : 'dishes'}`} placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} autoCorrect={false} autoCapitalize="none" returnKeyType="search"
        style={{ flex: 1, minWidth: 0, minHeight: 46, fontSize: 16, color: colors.ink }} />
      {query ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => { setQuery(''); focusById('admin-menu-search'); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Text accessible={false} aria-hidden style={{ color: colors.muted, fontSize: 16 }}>✕</Text>
      </Pressable> : null}
    </View>
    <MarketText variant="muted">Switch a dish off when it runs out. Customers see it as currently unavailable. Hold ⠿ and drag to change the order, or tap ⠿ to move a dish up or down.</MarketText>
    {demo ? <MarketText>Sample mode: connect the backend to make menu changes.</MarketText> : null}
    <View role="status" aria-live="polite">{status && !panel ? <MarketText>{status}</MarketText> : null}{query.trim() && !loading ? <MarketText variant="muted">{matches === 1 ? '1 dish matches' : `${matches} dishes match`} “{query.trim()}”.</MarketText> : null}</View>
    {!panel ? loadStatus : null}
    {!panel ? noticeStatus : null}
    {loading ? <MarketStatus kind="loading" title="Loading menu" /> : null}
    {!loading && !loadError && !categories.length ? <MarketStatus kind="empty" title="Add a category first" message="Dishes are grouped into categories such as Thalis or Snacks." action={<MarketButton label="Add category" disabled={demo} onPress={() => openCategories({ kind: 'edit' })} />} /> : null}
    {!loading && !loadError && categories.length > 0 && !items.length ? <MarketStatus kind="empty" title="No dishes yet" message="Add a dish to get started." /> : null}
    {!loadError && query.trim() && !sections.length ? <MarketStatus kind="empty" title="No matching dishes" message="Try another name, or clear the search." action={<MarketButton label="Clear search" variant="secondary" onPress={() => { setQuery(''); focusById('admin-menu-search'); }} />} /> : null}
    {!loadError ? sections.map(section => {
      const total = items.filter(item => item.categoryId === section.category.id).length;
      const ids = section.items.map(item => item.id);
      const active = drag && drag.categoryId === section.category.id ? drag : null;
      const target = active ? dragTarget(active.start, active.dy, active.height, ids.length) : 0;
      const shown = active ? (moveId(ids, active.id, target) ?? ids) : ids;
      return <View key={section.category.id} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, paddingTop: 6 }}>
          <Text accessibilityRole="header" style={{ flexShrink: 1, fontSize: 21, fontWeight: '700', color: colors.ink }}>{section.category.name}</Text>
          <Text style={{ fontSize: 13, color: colors.muted }}>{sectionSummary(total, section.unavailable)}</Text>
        </View>
        <View style={{ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 16 }}>
          {!section.items.length ? <View style={{ padding: 16 }}><MarketText variant="muted">No dishes in this category yet.</MarketText></View> : null}
          {shown.map((id, index) => {
            const item = section.items.find(entry => entry.id === id)!;
            const position = ids.indexOf(id);
            return <DishRow key={id} item={item} error={rowError?.id === item.id ? rowError.text : undefined} feature={feature} first={index === 0} isFirst={position === 0} isLast={position === ids.length - 1}
              offset={active?.id === id ? active.dy - (target - active.start) * active.height : null}
              canArrange={canArrange} arranging={arrangeId === id} switchDisabled={demo || pending.has(id)} editDisabled={demo || !!drag}
              onLayout={height => rowHeights.current.set(id, height)}
              onArrange={() => { if (Date.now() - lastDragEnd.current > 400) setArrangeId(current => current === id ? null : id); }}
              onMove={delta => moveDish(item, delta)} onToggle={value => void toggleAvailability(item, value)} onEdit={() => openEditor(item)}
              onDragStart={() => dragStart(item)} onDragMove={dy => setDrag(current => current ? { ...current, dy } : current)} onDragEnd={dragEnd} />;
          })}
        </View>
        {query.trim() && section.items.length ? <MarketText variant="muted">Clear the search to change the order.</MarketText> : null}
      </View>;
    }) : null}
    {!loading || categories.length ? <View style={{ gap: 10, paddingTop: 8 }}>
      <MarketButton label="Manage categories" variant="secondary" disabled={demo || !!loadError} onPress={() => openCategories()} />
      <MarketButton label={cleanupBusy ? 'Cleaning up photos…' : 'Retry photo cleanup'} variant="secondary" disabled={demo || cleanupBusy} onPress={retryCleanup} />
    </View> : null}

    {editor ? <DishEditor item={editor.item} items={items} categories={categories} services={services} reload={load} onClose={closeEditor}
      onSaved={async note => { await load(); setStatus(note); closeSaved(); }}
      onDeleted={async name => { await load(); setEditor(null); setStatus(`${name} deleted.`); focusTop(); }} /> : null}

    {panel?.kind === 'list' ? <AccessiblePanel key="categories" fullScreen title="Categories" onClose={closeCategories} footer={<MarketButton label="Done" onPress={closeCategories} />}>
      <MarketText variant="muted">Customers see categories in this order. A category can be deleted once it has no dishes.</MarketText>
      <View role="status" aria-live="polite">{status ? <MarketText>{status}</MarketText> : null}</View>
      {loadStatus}{noticeStatus}
      <MarketButton label="Add category" variant="secondary" disabled={demo || reordering || !!loadError} onPress={() => { setStatus(''); setPanel({ kind: 'edit' }); }} />
      {categories.map((category, index) => {
        const inCategory = items.filter(item => item.categoryId === category.id);
        const canMove = !demo && !reordering && !loadError;
        return <View key={category.id} style={{ gap: 10, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 14, backgroundColor: colors.surface }}>
          <View><Text style={{ fontSize: 17, fontWeight: '700', color: colors.ink }}>{category.name}</Text><Text style={{ fontSize: 13, color: colors.muted }}>{sectionSummary(inCategory.length, inCategory.filter(item => !item.isAvailable).length)}</Text></View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <SmallButton nativeID={`move-category-${category.id}-up`} label="↑ Up" accessibilityLabel={`Move category ${category.name} up`} disabled={!canMove || index === 0} onPress={() => moveCategory(category, -1)} />
            <SmallButton nativeID={`move-category-${category.id}-down`} label="↓ Down" accessibilityLabel={`Move category ${category.name} down`} disabled={!canMove || index === categories.length - 1} onPress={() => moveCategory(category, 1)} />
            <SmallButton label="Rename" accessibilityLabel={`Rename category ${category.name}`} disabled={!canMove} onPress={() => { setStatus(''); setPanel({ kind: 'edit', category }); }} />
            <SmallButton label="Delete" accessibilityLabel={`Delete category ${category.name}`} disabled={!canMove || inCategory.length > 0} onPress={() => { setStatus(''); setPanel({ kind: 'delete', category }); }} />
          </View>
        </View>;
      })}
    </AccessiblePanel> : null}
    {panel?.kind === 'edit' ? <CategoryForm key={`edit-${panel.category?.id ?? 'new'}`} category={panel.category} services={services}
      sortOrder={panel.category ? categories.find(entry => entry.id === panel.category!.id)?.sortOrder ?? panel.category.sortOrder : nextCategoryOrder(categories)}
      onCancel={() => setPanel({ kind: 'list' })} onSaved={async () => { await load(); setStatus('Category saved.'); setPanel({ kind: 'list' }); }} /> : null}
    {panel?.kind === 'delete' ? <CategoryDelete key={`delete-${panel.category.id}`} category={panel.category} services={services}
      onCancel={() => setPanel({ kind: 'list' })} onDeleted={async () => { if (await load()) setStatus('Category deleted.'); setPanel({ kind: 'list' }); }} /> : null}
  </View>;
}

/** The "+ Add dish" action, for the menu's own header or the owners' app header (header-right slot). */
export function AddDishButton({ action }: { action: AdminMenuAddDish }) {
  const { colors } = useMarketTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel="Add dish" disabled={action.disabled} accessibilityState={{ disabled: action.disabled }} onPress={action.open}
    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.primary, opacity: action.disabled ? 0.5 : pressed ? 0.8 : 1 })}>
    <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: '700' }}>+ Add dish</Text>
  </Pressable>;
}

function DishRow({ error, item, feature, first, isFirst, isLast, offset, canArrange, arranging, switchDisabled, editDisabled, onLayout, onArrange, onMove, onToggle, onEdit, onDragStart, onDragMove, onDragEnd }: {
  error?: string;
  item: MenuItem; feature: string; first: boolean; isFirst: boolean; isLast: boolean; offset: number | null; canArrange: boolean; arranging: boolean; switchDisabled: boolean; editDisabled: boolean;
  onLayout: (height: number) => void; onArrange: () => void; onMove: (delta: -1 | 1) => void; onToggle: (value: boolean) => void; onEdit: () => void;
  onDragStart: () => void; onDragMove: (dy: number) => void; onDragEnd: (dy: number, commit: boolean) => void;
}) {
  const { colors } = useMarketTheme();
  const latest = useRef({ canArrange, onDragStart, onDragMove, onDragEnd });
  latest.current = { canArrange, onDragStart, onDragMove, onDragEnd };
  // The handle's button handles taps and keyboard; a vertical move takes over as a drag.
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => latest.current.canArrange && Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onMoveShouldSetPanResponder: (_event, gesture) => latest.current.canArrange && Math.abs(gesture.dy) > 6,
    onPanResponderGrant: () => latest.current.onDragStart(),
    onPanResponderMove: (_event, gesture) => latest.current.onDragMove(gesture.dy),
    onPanResponderRelease: (_event, gesture) => latest.current.onDragEnd(gesture.dy, true),
    onPanResponderTerminate: (_event, gesture) => latest.current.onDragEnd(gesture.dy, false),
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  })).current;
  const [failed, setFailed] = useState<string | null>(null);
  const off = !item.isAvailable;
  const dragging = offset !== null;
  const details = `dish-${item.id}-details`;
  return <View onLayout={event => onLayout(event.nativeEvent.layout.height)}
    style={[{ borderTopWidth: first ? 0 : 1, borderTopColor: colors.border }, dragging ? { transform: [{ translateY: offset }], zIndex: 2, elevation: 6, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.primary, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } } : null]}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingLeft: 2, paddingRight: 12 }}>
      <View {...pan.panHandlers} style={webOnly({ touchAction: 'none', userSelect: 'none', cursor: canArrange ? 'grab' : 'default' })}>
        <Pressable nativeID={`arrange-${item.id}`} accessibilityRole="button" accessibilityLabel={`Reorder ${item.name}`} aria-expanded={arranging} accessibilityState={{ expanded: arranging, disabled: !canArrange }} disabled={!canArrange} onPress={onArrange}
          style={{ width: 36, height: 48, alignItems: 'center', justifyContent: 'center', opacity: canArrange ? 1 : 0.4 }}>
          <Text accessible={false} aria-hidden style={{ fontSize: 20, color: colors.muted }}>⠿</Text>
        </Pressable>
      </View>
      <Pressable nativeID={`edit-${item.id}`} accessibilityRole="button" accessibilityLabel={`Edit ${item.name}`} {...(Platform.OS === 'web' ? { 'aria-describedby': details } : {})} disabled={editDisabled} accessibilityState={{ disabled: editDisabled }} onPress={onEdit}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.7 : 1 })}>
        <View style={{ width: 52, height: 52, borderRadius: 10, overflow: 'hidden', backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.55 : 1 }}>
          {item.imageUrl && failed !== item.imageUrl
            ? <Image accessible={false} source={{ uri: item.imageUrl }} onError={() => setFailed(item.imageUrl!)} resizeMode="cover" style={{ width: 52, height: 52 }} />
            : <View accessible={false} style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.surface }} />}
        </View>
        <View nativeID={details} style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <DietMark diet={item.diet} compact />
            <Text numberOfLines={2} style={{ flexShrink: 1, fontSize: 16, fontWeight: '700', color: off ? colors.muted : colors.ink }}>{item.name}</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: off ? colors.muted : colors.ink }}>{formatINRFromPaise(item.pricePaise)}</Text>
            {item.isFeatured ? <Badge background={colors.tint} color={colors.primary} star>{feature}</Badge> : null}
            {off ? <Badge background="#ECE6E2" color="#3F3633">Currently unavailable</Badge> : null}
            {item.isDemo ? <Badge background={colors.surface} color={colors.muted} border={colors.inputBorder}>Sample</Badge> : null}
            {!item.imageUrl ? <Text style={{ fontSize: 12, color: colors.muted }}>No photo</Text> : null}
          </View>
        </View>
      </Pressable>
      <MarketSwitch label={`Available: ${item.name}`} value={item.isAvailable} disabled={switchDisabled} onValueChange={onToggle} />
    </View>
    {error ? <Text accessibilityRole="alert" style={{ paddingHorizontal: 12, paddingBottom: 10, color: colors.danger, fontSize: 14, fontWeight: '700' }}>{error}</Text> : null}
    {arranging ? <View style={{ flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
      <SmallButton nativeID={`move-${item.id}-up`} label="↑ Move up" accessibilityLabel={`Move ${item.name} up`} disabled={!canArrange || isFirst} onPress={() => onMove(-1)} />
      <SmallButton nativeID={`move-${item.id}-down`} label="↓ Move down" accessibilityLabel={`Move ${item.name} down`} disabled={!canArrange || isLast} onPress={() => onMove(1)} />
    </View> : null}
  </View>;
}

function Badge({ children, background, color, border, star = false }: { children: string; background: string; color: string; border?: string; star?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: background, borderWidth: border ? 1 : 0, borderColor: border }}>
    {star ? <Text accessible={false} aria-hidden style={{ fontSize: 11, color }}>★</Text> : null}
    <Text style={{ fontSize: 12, lineHeight: 18, fontWeight: '700', color }}>{children}</Text>
  </View>;
}

function SmallButton({ label, accessibilityLabel, onPress, disabled = false, nativeID }: { label: string; accessibilityLabel: string; onPress: () => void; disabled?: boolean; nativeID?: string }) {
  const { colors } = useMarketTheme();
  return <Pressable nativeID={nativeID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.surface, justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}>
    <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '700' }}>{label}</Text>
  </Pressable>;
}

function CategoryForm({ category, sortOrder, services, onCancel, onSaved }: { category?: MenuCategory; sortOrder: number; services: MarketServices; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(category?.name ?? '');
  const [validation, setValidation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const invalid = !name.trim() || [...name.trim()].length > 100;
  const save = async () => {
    if (invalid) { setValidation(true); return; }
    setBusy(true); setError('');
    try { await services.saveCategory({ id: category?.id, name: name.trim(), sortOrder }); await onSaved(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <AccessiblePanel title={category ? `Rename category ${category.name}` : 'Add category'} onClose={() => { if (!busy) onCancel(); }}>
    {error ? <MarketStatus kind="error" title="Could not save category" message={error} /> : null}
    <MarketField label="Category name" value={name} editable={!busy} onChangeText={setName} error={validation && invalid ? 'Enter a name from 1 to 100 characters.' : undefined} />
    {category ? null : <MarketText variant="muted">New categories are added at the end. Move them from the category list.</MarketText>}
    <MarketButton label={busy ? 'Saving…' : 'Save category'} disabled={busy} onPress={() => void save()} />
    <MarketButton label="Cancel" variant="secondary" disabled={busy} onPress={onCancel} />
  </AccessiblePanel>;
}

function CategoryDelete({ category, services, onCancel, onDeleted }: { category: MenuCategory; services: MarketServices; onCancel: () => void; onDeleted: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    setBusy(true); setError('');
    try { await services.deleteCategory(category.id); await onDeleted(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <AccessiblePanel title={`Delete category ${category.name}?`} onClose={() => { if (!busy) onCancel(); }}>
    <MarketText>This removes the empty category from the menu.</MarketText>
    {error ? <MarketStatus kind="error" title="Could not delete category" message={error} /> : null}
    <MarketButton label={busy ? 'Deleting…' : 'Confirm delete category'} disabled={busy} onPress={() => void remove()} />
    <MarketButton label="Keep category" variant="secondary" disabled={busy} onPress={onCancel} />
  </AccessiblePanel>;
}
