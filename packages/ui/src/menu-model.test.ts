import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItem } from '@market/core';
import { featuredLabel, featuredMenuItems, parseItemOrder, sortMenuItems } from './menu-model.ts';

const dish: MenuItem = { id: 'b', businessId: 'ammu-sammu', name: 'Rice', category: 'Meals', description: '', pricePaise: 100, diet: null, isAvailable: true, isDemo: false, isFeatured: true, sortOrder: 0 };

test('item ordering is stable by category, integer order, name, then id and preserves input', () => {
  const items = [dish, { ...dish, id: 'a' }, { ...dish, id: 'first', sortOrder: -1, name: 'Z' }, { ...dish, id: 'name', name: 'Dal' }, { ...dish, id: 'category', category: 'Drinks', sortOrder: 9 }];
  assert.deepEqual(sortMenuItems(items).map(item => item.id), ['category', 'first', 'name', 'a', 'b']);
  assert.deepEqual(sortMenuItems([...items].reverse()), sortMenuItems(items));
  assert.equal(items[0], dish);
});

test('only available featured dishes are returned; empty results hide the section', () => {
  for (const businessId of ['ammu-sammu', 'kokani-dine-inn'] as const) {
    const items = [{ ...dish, businessId }, { ...dish, businessId, id: 'unavailable', isAvailable: false }, { ...dish, businessId, id: 'ordinary', isFeatured: false }];
    assert.deepEqual(featuredMenuItems(items), [items[0]]);
    assert.deepEqual(featuredMenuItems(items.slice(1)), []);
    assert.equal(featuredMenuItems(items)[0].diet, null);
  }
});

test('brand labels match owner switch and customer heading', () => {
  assert.equal(featuredLabel('ammu-sammu', 'admin'), "Today's special");
  assert.equal(featuredLabel('ammu-sammu', 'customer'), "Today's special");
  assert.equal(featuredLabel('kokani-dine-inn', 'admin'), 'Signature dish');
  assert.equal(featuredLabel('kokani-dine-inn', 'customer'), 'Signature dishes');
});

test('item order accepts the PostgreSQL integer range without fractional or exponent coercion', () => {
  for (const value of ['0', ' -1 ', '-2147483648', '2147483647']) assert.equal(parseItemOrder(value), Number(value));
  for (const value of ['', ' ', '1.1', '1e2', 'NaN', 'Infinity', '2147483648', '-2147483649']) assert.equal(parseItemOrder(value), null);
});
