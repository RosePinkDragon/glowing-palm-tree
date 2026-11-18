import { isDiet, type BusinessSlug, type Diet, type MenuItem } from '@market/core';

/** `customer` names the group (carousel heading); `admin` and `dish` name one dish (editor, dish sheet badge). */
export function featuredLabel(businessId: BusinessSlug, audience: 'admin' | 'customer' | 'dish'): string {
  return businessId === 'ammu-sammu' ? "Today's special" : audience === 'customer' ? 'Signature dishes' : 'Signature dish';
}

export function parseItemOrder(input: string): number | null {
  if (!/^-?\d+$/.test(input.trim())) return null;
  const value = Number(input.trim());
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;
}

export function sortCategories<T extends { id: string; name: string; sortOrder: number }>(categories: readonly T[]): T[] {
  return [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
}

// Both menus use category order, then item order, with stable name/id ties.
export function sortMenuItems(items: readonly MenuItem[]): MenuItem[] {
  return [...items].sort((a, b) => a.categorySortOrder - b.categorySortOrder || a.category.localeCompare(b.category, 'en') || a.categoryId.localeCompare(b.categoryId, 'en') ||
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
}

export function featuredMenuItems(items: readonly MenuItem[]): MenuItem[] {
  return sortMenuItems(items.filter(item => item.isAvailable && item.isFeatured));
}

export type MenuSection<C> = { category: C; items: MenuItem[]; unavailable: number };
/** Owner menu: every category in order (empty ones too, unless searching), dishes in saved order. */
export function menuSections<C extends { id: string; name: string; sortOrder: number }>(items: readonly MenuItem[], categories: readonly C[], query = ''): MenuSection<C>[] {
  const needle = query.trim().toLocaleLowerCase('en');
  const sorted = sortMenuItems(items);
  return sortCategories(categories).map(category => {
    const inCategory = sorted.filter(item => item.categoryId === category.id);
    const matching = needle ? inCategory.filter(item => item.name.toLocaleLowerCase('en').includes(needle) || category.name.toLocaleLowerCase('en').includes(needle)) : inCategory;
    return { category, items: matching, unavailable: inCategory.filter(item => !item.isAvailable).length };
  }).filter(section => !needle || section.items.length > 0);
}

/** Move one id to a new index; returns null when the move changes nothing or is out of range. */
export function moveId(ids: readonly string[], id: string, to: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Replace one dish after a saved change without disturbing the rest of the list. */
export function replaceMenuItem(items: readonly MenuItem[], updated: MenuItem): MenuItem[] {
  return items.map(item => item.id === updated.id ? updated : item);
}

const maxOrder = 2147483647;
/** Saved dish position: an edit keeps its place; a new dish, or one moved to another category, joins the end. */
export function dishSortOrder(items: readonly MenuItem[], categoryId: string, current?: MenuItem): number {
  if (current && current.categoryId === categoryId) return current.sortOrder;
  const orders = items.filter(item => item.categoryId === categoryId && item.id !== current?.id).map(item => item.sortOrder);
  return orders.length ? Math.min(Math.max(...orders) + 1, maxOrder) : 0;
}

/** A new category is listed last. */
export function nextCategoryOrder(categories: readonly { sortOrder: number }[]): number {
  return categories.length ? Math.min(Math.max(...categories.map(category => category.sortOrder)) + 1, maxOrder) : 0;
}

/** Positions written by the reorder RPCs, applied locally while the save is in flight. */
export function applyItemOrder(items: readonly MenuItem[], ids: readonly string[]): MenuItem[] {
  return items.map(item => { const index = ids.indexOf(item.id); return index < 0 || item.sortOrder === index ? item : { ...item, sortOrder: index }; });
}
export function applyCategoryOrder<C extends { id: string; sortOrder: number }>(categories: readonly C[], ids: readonly string[]): C[] {
  return categories.map(category => { const index = ids.indexOf(category.id); return index < 0 || category.sortOrder === index ? category : { ...category, sortOrder: index }; });
}

export function sectionSummary(total: number, unavailable: number): string {
  return `${total} ${total === 1 ? 'dish' : 'dishes'}${unavailable ? ` · ${unavailable} off` : ''}`;
}

/** Row a dragged dish lands on: whole rows travelled, rounded, kept inside the list. */
export function dragTarget(start: number, dy: number, rowHeight: number, count: number): number {
  if (count < 1 || !(rowHeight > 0) || !Number.isFinite(dy)) return Math.max(0, Math.min(start, count - 1));
  return Math.max(0, Math.min(count - 1, start + Math.round(dy / rowHeight)));
}

export type DishDraft = { id?: string; name: string; description: string; categoryId: string; price: string; diet: Diet | null; isAvailable: boolean; isFeatured: boolean; isDemo: boolean };
export type DishDraftErrors = Partial<Record<'name' | 'category' | 'price' | 'description' | 'diet', string>>;
/** Mirrors saveMenuItem's limits so the owner sees field messages before a request is sent. `price` is parseRupees(draft.price). */
export function dishDraftErrors(draft: DishDraft, categoryIds: readonly string[], price: number | null): DishDraftErrors {
  const errors: DishDraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = 'Enter a dish name.';
  else if (name.length > 100) errors.name = 'Use up to 100 characters.';
  if (!categoryIds.includes(draft.categoryId)) errors.category = 'Choose a category. Reload the menu if it is no longer available.';
  if (price === null || price <= 0 || price > maxOrder) errors.price = 'Enter a positive amount up to 21,474,836.47 with up to two decimal places.';
  if (draft.description.trim().length > 1000) errors.description = 'Use up to 1,000 characters.';
  if (!draft.id && !isDiet(draft.diet)) errors.diet = 'Choose a diet classification.';
  return errors;
}

export type CustomerSection = { id: string; name: string; items: MenuItem[] };
const fold = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
/** Customer search: dishes whose name contains the typed text (case and repeated spaces ignored). An empty query keeps everything. */
export function searchMenuItems(items: readonly MenuItem[], query: string): MenuItem[] {
  const needle = fold(query);
  return needle ? items.filter(item => fold(item.name).includes(needle)) : [...items];
}
/** Customer menu sections: matching dishes grouped by category, in menu order. Categories without a match are left out. */
export function customerSections(items: readonly MenuItem[], query = ''): CustomerSection[] {
  const sections = new Map<string, CustomerSection>();
  for (const item of searchMenuItems(sortMenuItems(items), query)) {
    const section = sections.get(item.categoryId) ?? { id: item.categoryId, name: item.category, items: [] };
    section.items.push(item); sections.set(item.categoryId, section);
  }
  return [...sections.values()];
}
/** The section a scroll position is in: the last one that starts at or above `probe`; null above the first (the "All" chip). */
export function activeSectionId(tops: readonly { id: string; top: number }[], probe: number): string | null {
  let active: string | null = null;
  for (const { id, top } of [...tops].sort((a, b) => a.top - b.top)) { if (top <= probe) active = id; }
  return active;
}
/** Dish grid columns: two on phones (design), more as the screen widens. */
export function gridColumns(width: number): number { return width >= 1000 ? 4 : width >= 760 ? 3 : 2; }
/** Signature carousel card width: about two-thirds of the column so the next card peeks in (swipe cue), within 220-280. */
export function carouselCardWidth(contentWidth: number): number { return Math.max(220, Math.min(280, Math.round(contentWidth * 0.62))); }
