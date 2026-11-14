import type { MenuItem } from '../../packages/core/src/domain.ts';

export function menuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'dish', businessId: 'ammu-sammu', name: 'Dish', description: '', category: 'Food',
    pricePaise: 100, isAvailable: true, isDemo: false, isFeatured: false, sortOrder: 0,
    ...overrides,
  };
}
