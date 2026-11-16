import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOwnerTab, formatBadgeCount, isOwnerTabId, ownerTabAccessibilityLabel, ownerTabIds, ownerTabLabel, ownerTabs, selectOwnerTab, ownerInitials } from './owner-navigation.ts';

test('owner tabs are Orders, Menu, Today and Settings in a stable order', () => {
  assert.deepEqual([...ownerTabIds], ['orders', 'menu', 'today', 'settings']);
  assert.deepEqual(ownerTabs.map(tab => tab.id), [...ownerTabIds]);
  assert.deepEqual(ownerTabs.map(tab => tab.label), ['Orders', 'Menu', 'Today', 'Settings']);
  assert.equal(new Set(ownerTabs.map(tab => tab.label)).size, ownerTabs.length);
  assert.equal(defaultOwnerTab, 'orders');
  assert.equal(ownerTabLabel('today'), 'Today');
});

test('selection only accepts known tab IDs and falls back to Orders', () => {
  for (const id of ownerTabIds) { assert.equal(isOwnerTabId(id), true); assert.equal(selectOwnerTab(id), id); }
  for (const value of ['', 'Orders', 'admin', 'toString', '__proto__', null, undefined, 1, {}]) {
    assert.equal(isOwnerTabId(value), false);
    assert.equal(selectOwnerTab(value), 'orders');
  }
});

test('badge counts hide zero and invalid values and cap at 99+', () => {
  for (const value of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatBadgeCount(value), null);
  assert.equal(formatBadgeCount(1), '1');
  assert.equal(formatBadgeCount(99), '99');
  assert.equal(formatBadgeCount(100), '99+');
  assert.equal(formatBadgeCount(2500), '99+');
});

test('tab accessible names keep the visible label and speak a shown badge', () => {
  assert.equal(ownerTabAccessibilityLabel('orders'), 'Orders');
  assert.equal(ownerTabAccessibilityLabel('orders', 0), 'Orders');
  assert.equal(ownerTabAccessibilityLabel('orders', 2), 'Orders, 2 new');
  assert.equal(ownerTabAccessibilityLabel('orders', 120), 'Orders, 99+ new');
  assert.equal(ownerTabAccessibilityLabel('settings'), 'Settings');
});

test('owner card initials use the first and last words, or the account identifier', () => {
  assert.equal(ownerInitials('Suresh Pawar'), 'SP');
  assert.equal(ownerInitials('Asha Kumari Kadam'), 'AK');
  assert.equal(ownerInitials('ravi'), 'R');
  assert.equal(ownerInitials('owner@example.test'), 'OT');
  assert.equal(ownerInitials('सुरेश पवार'), 'सप');
  assert.equal(ownerInitials('   '), '?');
});
