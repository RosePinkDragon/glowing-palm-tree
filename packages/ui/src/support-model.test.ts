import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Order } from '@market/core';
import { indianPhone, selectedSupportOrder, supportConfig, supportLinks } from './support-model.ts';

test('Indian mobile and landline formats produce normalized dialer links', () => {
  for (const phone of ['98765 43210', '+91 98765-43210', '919876543210', '09876543210']) assert.equal(supportLinks({ phone, whatsapp: phone }).call, 'tel:+919876543210');
  for (const phone of ['02356 222333', '+91 (2356) 222333', '2356222333']) assert.equal(supportLinks({ phone, whatsapp: '' }).call, 'tel:+912356222333');
  assert.equal(supportLinks({ phone: '', whatsapp: '+91 98765 43210' }).whatsapp, 'https://wa.me/919876543210');
});
test('invalid or absent contacts cannot open a dialer/chat; WhatsApp requires mobile format', () => {
  for (const phone of ['', '123', '+1 9876543210', '00919876543210', '0000000000', 'tel:+919876543210', '9876543210?text=x', '9876543210 ext 3', '+9198765432100']) assert.equal(indianPhone(phone), null, phone);
  assert.deepEqual(supportLinks({ phone: '', whatsapp: '' }), { call: null, whatsapp: null });
  assert.equal(supportLinks({ phone: '02356222333', whatsapp: '02356222333' }).whatsapp, null);
  for (const config of Object.values(supportConfig)) {
    assert.deepEqual(supportLinks(config), { call: null, whatsapp: null }, 'defaults contain no dialable unverified contact');
    assert.equal(config.questions.length, 6);
  }
});
test('selection remains on an active order and falls back to newest when it becomes terminal', () => {
  const rows = [{ id: 'new', status: 'placed' }, { id: 'old', status: 'preparing' }] as Order[];
  assert.equal(selectedSupportOrder(rows, null)?.id, 'new');
  assert.equal(selectedSupportOrder(rows, 'old')?.id, 'old');
  assert.equal(selectedSupportOrder([{ ...rows[1], status: 'delivered' }, rows[0]], 'old')?.id, 'new');
  assert.equal(selectedSupportOrder([], 'old'), null);
});
