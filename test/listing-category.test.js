import test from 'node:test';
import assert from 'node:assert/strict';
import { attributesFromForm, houseDefaults } from '../src/listing-category.js';
import { handleWrite } from '../api/dashboard.js';

/**
 * A category chosen for the product, and its attributes as the form sends them. The
 * values must be ones the channel publishes; anything else is refused before a listing
 * is attempted.
 */

const schema = [
  { id: '100037', name: 'Negara Asal', required: true, multiple: false, custom: false, input: 'select', numeric: false, units: [], values: [{ id: '1', name: 'Indonesia' }, { id: '2', name: 'Jepang' }] },
  { id: '100134', name: 'Bahan', required: false, multiple: true, custom: true, input: 'select', numeric: false, units: [], values: [{ id: '7', name: 'Bambu' }, { id: '8', name: 'Kayu' }] },
  { id: '100278', name: 'Kapasitas', required: false, multiple: false, custom: true, input: 'text', numeric: true, units: ['ml', 'L'], values: [] },
  { id: '102254', name: 'Imported goods', required: false, multiple: false, custom: false, input: 'select', numeric: false, units: [], values: [{ id: '5', name: 'Ya' }, { id: '6', name: 'Tidak' }] },
];
const reader = (pairs) => (key) => pairs.filter(([k]) => k === key).map(([, v]) => v);

test('form values become each channel\'s own attribute shape', () => {
  const read = reader([['attr:100037', '1'], ['attr:100134', '7'], ['attr:100134', '8'], ['attrtext:100134', 'Benang'], ['attrtext:100278', '250'], ['attrunit:100278', 'ml']]);
  assert.deepEqual(attributesFromForm('shopee', schema, read), [
    { attribute_id: 100037, attribute_value_list: [{ value_id: 1 }] },
    { attribute_id: 100134, attribute_value_list: [{ value_id: 7 }, { value_id: 8 }, { value_id: 0, original_value_name: 'Benang' }] },
    { attribute_id: 100278, attribute_value_list: [{ value_id: 0, original_value_name: '250', value_unit: 'ml' }] },
  ]);
  assert.deepEqual(attributesFromForm('tiktok', schema, read).slice(0, 2), [
    { id: '100037', values: [{ id: '1' }] },
    { id: '100134', values: [{ id: '7' }, { id: '8' }, { name: 'Benang' }] },
  ]);
});

test('a missing required attribute, an unlisted value, free text where none is taken, or a bad unit is refused', () => {
  assert.throws(() => attributesFromForm('shopee', schema, reader([])), /wajib belum diisi: Negara Asal/);
  assert.throws(() => attributesFromForm('shopee', schema, reader([['attr:100037', '99']])), /tidak dikenal/);
  assert.throws(() => attributesFromForm('shopee', schema, reader([['attr:100037', '1'], ['attrtext:102254', 'mungkin']])), /isian bebas/);
  assert.throws(() => attributesFromForm('shopee', schema, reader([['attr:100037', '1'], ['attrtext:100278', '5'], ['attrunit:100278', 'galon']])), /satuan/);
  assert.throws(() => attributesFromForm('shopee', schema, reader([['attr:100037', '1'], ['attrtext:100278', 'banyak']])), /harus angka/);
});

test('a single-choice attribute keeps one value even if more are sent', () => {
  const out = attributesFromForm('tiktok', schema, reader([['attr:100037', '1'], ['attr:100037', '2']]));
  assert.deepEqual(out[0], { id: '100037', values: [{ id: '1' }] });
});

test('house defaults answer origin and import from the channel\'s own values only', () => {
  assert.deepEqual(houseDefaults(schema), { 100037: { ids: ['1'], text: '', unit: '' }, 102254: { ids: ['6'], text: '', unit: '' } });
  assert.deepEqual(houseDefaults([{ ...schema[0], values: [{ id: '2', name: 'Jepang' }] }]), {}, 'tanpa Indonesia di daftar, tidak menebak');
});

test('a publish naming a malformed category is refused before any channel is asked', async () => {
  const f = new URLSearchParams([['action', 'product_publish'], ['sku', 'Bamboo-Whisk'], ['channel', 'shopee'], ['category', '12ab']]);
  await assert.rejects(() => handleWrite(f, '127.0.0.1', { id: 'o', email: 'o@x', name: 'O', role: 'owner', status: 'active' }, 'csrf'), /kategori tidak valid/);
});
