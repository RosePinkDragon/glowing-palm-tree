// Pure owner-app navigation model shared by the owner shell and later owner screens (#58–#61).
export const ownerTabIds = ['orders', 'menu', 'today', 'settings'] as const;
export type OwnerTabId = typeof ownerTabIds[number];
export type OwnerTab = { id: OwnerTabId; label: string };

export const ownerTabs: readonly OwnerTab[] = [
  { id: 'orders', label: 'Orders' },
  { id: 'menu', label: 'Menu' },
  { id: 'today', label: 'Today' },
  { id: 'settings', label: 'Settings' },
];
export const defaultOwnerTab: OwnerTabId = 'orders';

export function isOwnerTabId(value: unknown): value is OwnerTabId {
  return typeof value === 'string' && (ownerTabIds as readonly string[]).includes(value);
}

/** Returns the requested tab when it exists, otherwise the default tab, so selection is always valid. */
export function selectOwnerTab(value: unknown): OwnerTabId {
  return isOwnerTabId(value) ? value : defaultOwnerTab;
}

export function ownerTabLabel(id: OwnerTabId): string {
  return ownerTabs.find(tab => tab.id === id)?.label ?? id;
}

/** Visible badge text: hidden (null) for missing, zero, negative or non-integer counts; capped at 99+. */
export function formatBadgeCount(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}

/** Accessible name for a tab; the badge is spoken because it is drawn as a separate visual element. */
export function ownerTabAccessibilityLabel(id: OwnerTabId, count?: number | null): string {
  const badge = formatBadgeCount(count);
  return badge ? `${ownerTabLabel(id)}, ${badge} new` : ownerTabLabel(id);
}
