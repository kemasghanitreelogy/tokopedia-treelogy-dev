import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMasterOverlay, findProduct, PRODUCTS, isRemoved } from '../src/master.js';
import { cleanProduct } from '../src/master-store.js';
import { SELLABLE } from '../src/mekari/manual.js';
import { EXPORT_PRODUCTS } from '../src/export/orders.js';

/**
 * The catalogue edited from the dashboard, laid over the base list in code.
 *
 * The cases that cost something when wrong: a new SKU colliding with an existing
 * spelling, a removed product no longer resolving for its old orders, and a module that
 * built its own copy of the list at load time never seeing the change.
 */

test.afterEach(() => applyMasterOverlay(null));

test('a new product joins the catalogue, and every copy of it follows', () => {
  applyMasterOverlay({ products: { 'OMC-360-001': { name: 'Moringa Capsules', variant: '360 caps', category: 'capsules', aliases: ['OMC360'] } } });
  assert.equal(findProduct('OMC360')?.sku, 'OMC-360-001', 'alias ikut dikenali');
  assert.ok(PRODUCTS.some((p) => p.sku === 'OMC-360-001'));
  assert.ok(SELLABLE.some((p) => p.sku === 'OMC-360-001'), 'form transaksi manual ikut');
  assert.ok(EXPORT_PRODUCTS.some((p) => p.sku === 'OMC-360-001'), 'ekspor ikut');
});

test('a change to a base product replaces only the fields it names', () => {
  applyMasterOverlay({ products: { 'OMC-90-001': { name: 'Kapsul Kelor', category: 'capsules' } } });
  const p = findProduct('OMC90');
  assert.equal(p.name, 'Kapsul Kelor');
  assert.equal(p.variant, '90 caps', 'field yang tidak disebut tetap');
});

test('a removed product leaves the lists but still resolves for the orders that name it', () => {
  applyMasterOverlay({ removed: ['Bamboo-Whisk'] });
  assert.ok(!PRODUCTS.some((p) => p.sku === 'Bamboo-Whisk'));
  assert.ok(!SELLABLE.some((p) => p.sku === 'Bamboo-Whisk'));
  assert.equal(findProduct('Bamboo Whisk - 120 prongs')?.sku, 'Bamboo-Whisk', 'faktur pesanan lama tetap ketemu');
  assert.ok(isRemoved('Bamboo-Whisk'));
});

test('a new SKU cannot take a spelling that already means another product', () => {
  assert.throws(() => cleanProduct({ sku: 'OMC90', name: 'X', category: 'capsules' }, { isNew: true }), /sudah dipakai .*alias OMC-90-001/);
  assert.throws(() => cleanProduct({ sku: 'NEW-1', name: 'X', category: 'capsules', aliases: 'OMP45' }, { isNew: true }), /alias OMP45 sudah dipakai OMP-45-001/);
});

test('a bundle recipe names products that exist, in sane amounts, never itself', () => {
  const ok = cleanProduct({ sku: 'SET-NEW', name: 'Set', category: 'bundle', components: [{ sku: 'OMC90', qty: '2' }] }, { isNew: true });
  assert.deepEqual(ok.entry.components, [{ sku: 'OMC-90-001', qty: 2 }], 'alias diganti SKU master');
  assert.throws(() => cleanProduct({ sku: 'SET-NEW', name: 'Set', category: 'bundle', components: [{ sku: 'NOPE', qty: 1 }] }, { isNew: true }), /tidak ada di master/);
  assert.throws(() => cleanProduct({ sku: 'SET-NEW', name: 'Set', category: 'bundle', components: [{ sku: 'OMC-90-001', qty: 0 }] }, { isNew: true }), /1-99/);
});

test('the form is checked in the words the operator reads', () => {
  assert.throws(() => cleanProduct({ sku: 'a', name: 'X', category: 'capsules' }, { isNew: true }), /SKU 2-50/);
  assert.throws(() => cleanProduct({ sku: 'OK-1', name: '', category: 'capsules' }, { isNew: true }), /nama produk wajib/);
  assert.throws(() => cleanProduct({ sku: 'OK-1', name: 'X', category: 'mainan' }, { isNew: true }), /kategori/);
});
