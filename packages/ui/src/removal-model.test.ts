import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuItem } from '../../../tests/fixtures/menu.ts';
import type { BusinessSlug, CartLine } from '@market/core';
import { restoreLine, soleRemoval } from './removal-model.ts';

const business: BusinessSlug = 'ammu-sammu';
const dish = (id: string, isAvailable = true) => menuItem({ id, businessId: business, name: id, description: 'Fresh', category: 'Meals', pricePaise: 10000, isAvailable, isDemo: false, isFeatured: false, sortOrder: 0, diet: 'veg' });
const line = (id: string, quantity = 1, isAvailable = true): CartLine => ({ item: dish(id, isAvailable), quantity });

test('only the last unit of one available dish is undoable, with its place in the cart', () => {
  const before = [line('a'), line('b'), line('c', 3)];
  assert.deepEqual(soleRemoval(before, [before[0], before[2]]), { line: before[1], index: 1 });
  assert.equal(soleRemoval(before, [before[0], before[1], { ...before[2], quantity: 2 }]), null, 'a smaller quantity is not a removal');
  assert.equal(soleRemoval(before, [before[0]]), null, 'two dishes gone at once');
  assert.equal(soleRemoval(before, []), null);
  assert.equal(soleRemoval([line('x', 1, false)], []), null, 'an unavailable dish cannot come back');
  assert.equal(soleRemoval([line('c', 3)], []), null, 'removing a bigger line is not the last-unit gesture');
});

test('restoring puts the dish back in place and never overwrites a newer line', () => {
  const [a, b, c] = [line('a'), line('b'), line('c')];
  assert.deepEqual(restoreLine([a, c], b, 1).map(entry => entry.item.id), ['a', 'b', 'c']);
  assert.deepEqual(restoreLine([a], b, 5).map(entry => entry.item.id), ['a', 'b']);
  const again = { ...b, quantity: 4 };
  assert.deepEqual(restoreLine([a, again], b, 1), [a, again]);
});
