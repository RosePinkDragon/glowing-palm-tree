import type { BusinessSlug, MenuItem } from '@market/core';

export function featuredLabel(businessId: BusinessSlug, audience: 'admin' | 'customer'): string {
  return businessId === 'ammu-sammu' ? "Today's special" : audience === 'admin' ? 'Signature dish' : 'Signature dishes';
}

export function parseItemOrder(input: string): number | null {
  if (!/^-?\d+$/.test(input.trim())) return null;
  const value = Number(input.trim());
  return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;
}

// Category ordering remains alphabetical until category management is introduced.
export function sortMenuItems(items: readonly MenuItem[]): MenuItem[] {
  return [...items].sort((a, b) => a.category.localeCompare(b.category, 'en') ||
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id, 'en'));
}

export function featuredMenuItems(items: readonly MenuItem[]): MenuItem[] {
  return sortMenuItems(items.filter(item => item.isAvailable && item.isFeatured));
}
