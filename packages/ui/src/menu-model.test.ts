import assert from 'node:assert/strict';
import test from 'node:test';
import type { MenuItem } from '@market/core';
import { activeSectionId, customerSections, gridColumns, carouselCardWidth, searchMenuItems, applyCategoryOrder, applyItemOrder, dishDraftErrors, dishSortOrder, dragTarget, featuredLabel, featuredMenuItems, makeRealDish, sampleDishCopy, menuSections, moveId, nextCategoryOrder, parseItemOrder, replaceMenuItem, sectionSummary, sortCategories, sortMenuItems, type DishDraft } from './menu-model.ts';
import { parseRupees } from './admin-model.ts';
import { readCart } from './cart-state.ts';

const dish: MenuItem = { id: 'b', businessId: 'ammu-sammu', name: 'Rice', category: 'Meals', categoryId: 'meals', categorySortOrder: 0, description: '', pricePaise: 100, diet: null, isAvailable: true, isDemo: false, isFeatured: true, sortOrder: 0 };

test('saved category names use the same 100 Unicode code-point limit as category writes', () => {
  const saved = (category: string) => JSON.stringify({ version: 1, revision: 1, businessId: dish.businessId, ownerId: null, lines: [{ item: { ...dish, category }, quantity: 1 }] });
  // Composed and decomposed names are not normalized: PostgreSQL counts code points,
  // not UTF-16 units or grapheme clusters.
  for (const category of ['a'.repeat(100), '🍛'.repeat(100), 'é'.repeat(100), 'e\u0301'.repeat(50)]) {
    assert.equal(readCart(saved(category), dish.businessId)?.lines[0].item.category, category);
  }
  for (const category of ['a'.repeat(101), '🍛'.repeat(101), 'é'.repeat(101), 'e\u0301'.repeat(50) + 'e']) {
    assert.throws(() => readCart(saved(category), dish.businessId), /Invalid saved cart/);
  }
});

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
  assert.equal(featuredLabel('kokani-dine-inn', 'dish'), 'Signature dish');
  assert.equal(featuredLabel('ammu-sammu', 'dish'), "Today's special");
});

test('item order accepts the PostgreSQL integer range without fractional or exponent coercion', () => {
  for (const value of ['0', ' -1 ', '-2147483648', '2147483647']) assert.equal(parseItemOrder(value), Number(value));
  for (const value of ['', ' ', '1.1', '1e2', 'NaN', 'Infinity', '2147483648', '-2147483649']) assert.equal(parseItemOrder(value), null);
});


test('category rank precedes name; category and item ties remain deterministic', () => {
  const items = [dish, { ...dish, id: 'first-category', categoryId: 'all', category: 'All', categorySortOrder: -1, sortOrder: 100 }, { ...dish, id: 'second-category', categoryId: 'z', category: 'Z', categorySortOrder: -1, sortOrder: -100 }];
  assert.deepEqual(sortMenuItems(items).map(item => item.id), ['first-category', 'second-category', 'b']);
  assert.deepEqual(featuredMenuItems([...items].reverse()), sortMenuItems(items));
});

test('owner category controls share stable rank/name/id ordering', () => {
  const groups = [{ id: 'b', name: 'All', sortOrder: 0 }, { id: 'a', name: 'All', sortOrder: 0 }, { id: 'z', name: 'Z', sortOrder: -1 }];
  assert.deepEqual(sortCategories(groups).map(group => group.id), ['z', 'a', 'b']);
  assert.equal(groups[0].id, 'b');
});

test('owner menu sections keep category and dish order, count unavailable dishes and search by dish or category', () => {
  const categories = [{ id: 'snacks', name: 'Snacks', sortOrder: 1 }, { id: 'thalis', name: 'Thalis', sortOrder: 0 }, { id: 'empty', name: 'Sweets', sortOrder: 2 }];
  const items: MenuItem[] = [
    { ...dish, id: 'veg', name: 'Veg thali', category: 'Thalis', categoryId: 'thalis', sortOrder: 1 },
    { ...dish, id: 'fish', name: 'Fish thali', category: 'Thalis', categoryId: 'thalis', sortOrder: 0 },
    { ...dish, id: 'vadi', name: 'Kothimbir vadi', category: 'Snacks', categoryId: 'snacks', categorySortOrder: 1, isAvailable: false },
  ];
  const sections = menuSections(items, categories);
  assert.deepEqual(sections.map(section => [section.category.id, section.items.map(item => item.id), section.unavailable]), [['thalis', ['fish', 'veg'], 0], ['snacks', ['vadi'], 1], ['empty', [], 0]]);
  assert.deepEqual(menuSections(items, categories, ' VADI ').map(section => [section.category.id, section.items.map(item => item.id)]), [['snacks', ['vadi']]]);
  assert.deepEqual(menuSections(items, categories, 'thalis').map(section => section.items.length), [2], 'category names match too');
  assert.deepEqual(menuSections(items, categories, 'biryani'), []);
});

test('moves change only the chosen position and refuse no-op or out-of-range moves', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.equal(moveId(['a', 'b', 'c'], 'a', 0), null);
  assert.equal(moveId(['a', 'b', 'c'], 'a', 3), null);
  assert.equal(moveId(['a', 'b', 'c'], 'a', -1), null);
  assert.equal(moveId(['a', 'b', 'c'], 'z', 1), null);
  const updated = { ...dish, isAvailable: false };
  assert.deepEqual(replaceMenuItem([dish, { ...dish, id: 'c' }], updated).map(item => item.isAvailable), [false, true]);
});

test('saved dishes keep their place; new or recategorised dishes join the end of their category', () => {
  const items: MenuItem[] = [{ ...dish, id: 'a', categoryId: 'thalis', sortOrder: 0 }, { ...dish, id: 'b', categoryId: 'thalis', sortOrder: 4 }, { ...dish, id: 'c', categoryId: 'snacks', sortOrder: 2 }];
  assert.equal(dishSortOrder(items, 'thalis'), 5);
  assert.equal(dishSortOrder(items, 'empty'), 0);
  assert.equal(dishSortOrder(items, 'thalis', items[0]), 0, 'an edit keeps its current position');
  assert.equal(dishSortOrder(items, 'snacks', items[1]), 3, 'a moved dish goes last in its new category');
  assert.equal(dishSortOrder([{ ...dish, categoryId: 'x', sortOrder: 2147483647 }], 'x'), 2147483647, 'never overflows the integer column');
  assert.equal(nextCategoryOrder([]), 0);
  assert.equal(nextCategoryOrder([{ sortOrder: -3 }, { sortOrder: 7 }]), 8);
});

test('local reorder mirrors the RPC positions and leaves other rows untouched', () => {
  const items: MenuItem[] = [{ ...dish, id: 'a', sortOrder: 5 }, { ...dish, id: 'b', sortOrder: 9 }, { ...dish, id: 'other', categoryId: 'x', sortOrder: 3 }];
  const next = applyItemOrder(items, ['b', 'a']);
  assert.deepEqual(next.map(item => [item.id, item.sortOrder]), [['a', 1], ['b', 0], ['other', 3]]);
  assert.equal(next[2], items[2]);
  assert.deepEqual(applyCategoryOrder([{ id: 'x', sortOrder: 4 }, { id: 'y', sortOrder: 0 }], ['x', 'y']), [{ id: 'x', sortOrder: 0 }, { id: 'y', sortOrder: 1 }]);
});

test('section summary counts dishes and switched-off dishes', () => {
  assert.equal(sectionSummary(3, 0), '3 dishes');
  assert.equal(sectionSummary(3, 1), '3 dishes · 1 off');
  assert.equal(sectionSummary(1, 1), '1 dish · 1 off');
  assert.equal(sectionSummary(0, 0), '0 dishes');
});

test('drag target rounds whole rows travelled and stays inside the list', () => {
  assert.equal(dragTarget(1, 0, 72, 3), 1);
  assert.equal(dragTarget(1, 35, 72, 3), 1);
  assert.equal(dragTarget(1, 37, 72, 3), 2);
  assert.equal(dragTarget(1, -40, 72, 3), 0);
  assert.equal(dragTarget(0, 1000, 72, 3), 2);
  assert.equal(dragTarget(2, -1000, 72, 3), 0);
  assert.equal(dragTarget(1, 50, 0, 3), 1, 'unmeasured rows do not move');
  assert.equal(dragTarget(1, Number.NaN, 72, 3), 1);
});

test('dish editor validation mirrors saveMenuItem limits', () => {
  const draft: DishDraft = { name: 'Fish thali', description: '', categoryId: 'thalis', price: '320', diet: 'non_veg', isAvailable: true, isFeatured: false, isDemo: false };
  const check = (changes: Partial<DishDraft>) => { const next = { ...draft, ...changes }; return dishDraftErrors(next, ['thalis'], parseRupees(next.price)); };
  assert.deepEqual(check({}), {});
  assert.deepEqual(Object.keys(check({ name: '  ', categoryId: 'gone', price: '0', diet: null, description: 'x'.repeat(1001) })).sort(), ['category', 'description', 'diet', 'name', 'price']);
  assert.equal(check({ name: 'x'.repeat(101) }).name, 'Use up to 100 characters.');
  assert.equal(check({ name: ` ${'x'.repeat(100)} ` }).name, undefined);
  for (const price of ['', '1.234', '-1', '1e3', '21474836.48']) assert.ok(check({ price }).price, price);
  for (const price of ['0.01', '21474836.47', ' 320.5 ']) assert.equal(check({ price }).price, undefined, price);
  assert.equal(check({ id: 'existing', diet: null }).diet, undefined, 'existing unclassified dishes can still be saved');
});

const named = (id: string, name: string, categoryId: string, category: string, categorySortOrder: number, extra: Partial<MenuItem> = {}): MenuItem => ({ ...dish, id, name, categoryId, category, categorySortOrder, isFeatured: false, ...extra });
const menu = [named('1', 'Veg thali', 'thalis', 'Thalis', 0), named('2', 'Fish thali', 'thalis', 'Thalis', 0, { sortOrder: 1 }), named('3', 'Misal pav', 'snacks', 'Snacks', 1), named('4', 'Sol kadhi', 'drinks', 'Drinks', 2, { isAvailable: false })];

test('customer search matches dish names only, ignoring case and extra spaces', () => {
  assert.deepEqual(searchMenuItems(menu, '  THALI ').map(item => item.id), ['1', '2']);
  assert.deepEqual(searchMenuItems(menu, 'misal   pav').map(item => item.id), ['3']);
  assert.deepEqual(searchMenuItems(menu, 'snacks'), [], 'category names are not searched');
  assert.deepEqual(searchMenuItems(menu, '   ').map(item => item.id), ['1', '2', '3', '4'], 'an empty query keeps every dish');
  assert.deepEqual(searchMenuItems(menu, 'pizza'), []);
});

test('customer sections group by category in menu order, keep unavailable dishes and drop categories without a match', () => {
  assert.deepEqual(customerSections(menu).map(section => [section.name, section.items.map(item => item.id)]), [['Thalis', ['1', '2']], ['Snacks', ['3']], ['Drinks', ['4']]]);
  assert.deepEqual(customerSections([...menu].reverse()).map(section => section.id), ['thalis', 'snacks', 'drinks']);
  assert.deepEqual(customerSections(menu, 'kadhi').map(section => section.id), ['drinks']);
  assert.deepEqual(customerSections(menu, 'zzz'), []);
  assert.deepEqual(customerSections([]), []);
});

test('the highlighted category is the last section that has started', () => {
  const tops = [{ id: 'b', top: 400 }, { id: 'a', top: 100 }, { id: 'c', top: 900 }];
  assert.equal(activeSectionId(tops, 50), null);
  assert.equal(activeSectionId(tops, 100), 'a');
  assert.equal(activeSectionId(tops, 399), 'a');
  assert.equal(activeSectionId(tops, 400), 'b');
  assert.equal(activeSectionId(tops, 5000), 'c');
  assert.equal(activeSectionId([], 10), null);
});

test('the dish grid is two columns on phones and widens on larger screens', () => {
  assert.deepEqual([320, 390, 759, 760, 999, 1000, 1280].map(gridColumns), [2, 2, 2, 3, 3, 4, 4]);
});

test('signature carousel cards show the next card peeking in, within 220-280 wide', () => {
  assert.deepEqual([280, 350, 390, 450, 1040].map(carouselCardWidth), [220, 220, 242, 279, 280]);
  for (let width = 200; width <= 1200; width += 25) { const card = carouselCardWidth(width); assert.ok(card >= 220 && card <= 280); }
});

test('making a sample dish real clears the sample flag and keeps it unavailable (#201)', () => {
  const sample: DishDraft = { id: 'd1', name: 'Sample thali', description: '', categoryId: 'meals', price: '100', diet: 'veg', isAvailable: true, isFeatured: true, isDemo: true };
  assert.deepEqual(makeRealDish(sample), { ...sample, isDemo: false, isAvailable: false });
  assert.equal(makeRealDish({ ...sample, isAvailable: false }).isAvailable, false);
  assert.equal(sample.isDemo, true, 'the draft is not mutated');
  assert.deepEqual(dishDraftErrors(makeRealDish(sample), ['meals'], 10000), {}, 'the converted draft passes the same validation');
  assert.equal(sampleDishCopy.action, 'Make this a real dish');
  assert.match(sampleDishCopy.helper, /Customers can't order sample dishes/);
});
