import type { BusinessSlug, MenuItem } from '@market/core';

export function featuredLabel(businessId: BusinessSlug, audience: 'admin' | 'customer'): string {
  return businessId === 'ammu-sammu' ? "Today's special" : audience === 'admin' ? 'Signature dish' : 'Signature dishes';
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
