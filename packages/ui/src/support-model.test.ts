import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Order } from '@market/core';
import { businessContactLinks, indianPhone, selectedSupportOrder, supportConfig, supportLinks } from './support-model.ts';

test('Indian mobile and landline formats produce normalized dialer links', () => {
  for (const phone of ['98765 43210', '+91 98765-43210', '919876543210', '09876543210']) assert.equal(supportLinks({ phone, whatsapp: phone }).call, 'tel:+919876543210');
  for (const phone of ['02356 222333', '+91 (2356) 222333', '2356222333']) assert.equal(supportLinks({ phone, whatsapp: '' }).call, 'tel:+912356222333');
  assert.equal(supportLinks({ phone: '011 23456789', whatsapp: '' }).call, 'tel:+911123456789');
  assert.equal(supportLinks({ phone: '0124 2345678', whatsapp: '' }).call, 'tel:+911242345678');
  assert.equal(supportLinks({ phone: '', whatsapp: '+91 98765 43210' }).whatsapp, 'https://wa.me/919876543210');
});
test('invalid or absent contacts cannot open a dialer/chat; WhatsApp requires mobile format', () => {
  for (const phone of ['', '123', '+1 9876543210', '00919876543210', '0000000000', 'tel:+919876543210', '9876543210?text=x', '9876543210 ext 3', '+9198765432100']) assert.equal(indianPhone(phone), null, phone);
  assert.deepEqual(supportLinks({ phone: '', whatsapp: '' }), { call: null, whatsapp: null });
  assert.equal(supportLinks({ phone: '02356222333', whatsapp: '02356222333' }).whatsapp, null);
  for (const config of Object.values(supportConfig)) assert.equal(config.questions.length, 7);
});
test('business contact data drives the links; missing, invalid or landline-WhatsApp numbers give no action', () => {
  assert.deepEqual(businessContactLinks({ contactPhone: '98765 43210', whatsappPhone: '+91 91234 56789' }), { call: 'tel:+919876543210', whatsapp: 'https://wa.me/919123456789' });
  assert.deepEqual(businessContactLinks({ contactPhone: '02356 222333', whatsappPhone: null }), { call: 'tel:+912356222333', whatsapp: null });
  assert.deepEqual(businessContactLinks({ contactPhone: null, whatsappPhone: '02356222333' }), { call: null, whatsapp: null });
  assert.deepEqual(businessContactLinks({ contactPhone: 'abc', whatsappPhone: '' }), { call: null, whatsapp: null });
  assert.deepEqual(businessContactLinks(null), { call: null, whatsapp: null });
  assert.deepEqual(businessContactLinks(undefined), { call: null, whatsapp: null });
});
test('FAQ matches the shipped login, address, payment and coupon behavior', () => {
  const text = (id: string) => supportConfig['ammu-sammu'].questions.find(q => q.id === id)!.answer;
  assert.equal(text('code'), 'Sign in with your mobile number; we send a 6-digit code on WhatsApp that works for 10 minutes.');
  assert.match(text('delivery'), /saved and shared across both restaurants.*first eligible address.*change it at checkout/);
  assert.match(text('payment'), /cash on delivery/);
  assert.match(text('coupon'), /cart/);
  for (const config of Object.values(supportConfig)) assert.doesNotMatch(JSON.stringify(config.questions), /email and password|Forgot password|current location/i);
});
test('selection remains on an active order and falls back to newest when it becomes terminal', () => {
  const rows = [{ id: 'new', status: 'placed' }, { id: 'old', status: 'preparing' }] as Order[];
  assert.equal(selectedSupportOrder(rows, null)?.id, 'new');
  assert.equal(selectedSupportOrder(rows, 'old')?.id, 'old');
  assert.equal(selectedSupportOrder([{ ...rows[1], status: 'delivered' }, rows[0]], 'old')?.id, 'new');
  assert.equal(selectedSupportOrder([], 'old'), null);
});
