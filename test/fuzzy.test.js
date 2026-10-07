import test from 'node:test';
import assert from 'node:assert/strict';
import { searchOrders, phonetic, distance } from '../src/fuzzy.js';
import { filterOrders } from '../src/omni.js';

/**
 * The order search forgives the way people type: a slip of the finger, the old spelling
 * of a name, a phone number written any way. It must never bury the exact answer under
 * lookalikes, and never invent a match for a short word.
 */

const orders = [
  { id: '#11288', channel: 'shopify', buyer: 'Widya Putri', buyerPhone: '+6281932247763', tracking: '' },
  { id: '261003MT5BUKTW', channel: 'shopee', buyer: 'Noor Widyani', buyerPhone: '', tracking: 'CM49107179384' },
  { id: '#11176', channel: 'shopify', buyer: 'Windi Widyawati', buyerPhone: '0812-1111-2222', tracking: '11LP1791014497092' },
  { id: '#11134', channel: 'shopify', buyer: 'Lufi Widyastuti', buyerPhone: '081398151516', tracking: '' },
  { id: 'SHF-0042', channel: 'manual', buyer: 'Djoko Santoso', buyerPhone: '', tracking: '' },
  { id: '#11300', channel: 'shopify', buyer: 'Siti Fatimah', buyerPhone: '085700001111', tracking: '' },
  { id: '#11301', channel: 'shopify', buyer: 'Ika', buyerPhone: '', tracking: '' },
];
const find = (q) => { const r = searchOrders(orders, q); return { ids: r.orders.map((o) => o.id), fuzzy: r.fuzzy }; };

test('a phone number is found however it is written', () => {
  for (const q of ['+6281932247763', '081932247763', '0819-3224-7763', '62 819 3224 7763', '(0819) 3224 7763', '3224 7763']) {
    assert.deepEqual(find(q), { ids: ['#11288'], fuzzy: false }, q);
  }
});

test('one digit wrong, missing, extra or swapped in a phone number still finds it, flagged as near', () => {
  for (const q of ['081932247764', '08193224763', '0819322477763', '081932427763']) {
    assert.deepEqual(find(q), { ids: ['#11288'], fuzzy: true }, q);
  }
});

test('typos in a name find it, best match first', () => {
  assert.deepEqual(find('widay putri').ids[0], '#11288', 'huruf tertukar');
  assert.deepEqual(find('widya putro').ids[0], '#11288', 'huruf salah');
  assert.deepEqual(find('lufi widyastti').ids, ['#11134'], 'huruf kurang');
  assert.equal(find('widay putri').fuzzy, true);
});

test('names written in another Indonesian spelling are the same name', () => {
  assert.deepEqual(find('nur widyani').ids, ['261003MT5BUKTW'], 'Noor = Nur');
  assert.deepEqual(find('joko').ids, ['SHF-0042'], 'Djoko = Joko');
  assert.deepEqual(find('widia putri').ids, ['#11288'], 'Widia = Widya');
  assert.deepEqual(find('siti fatima').ids, ['#11300'], 'Fatimah = Fatima');
  assert.equal(phonetic('Djoko'), phonetic('Joko'));
});

test('an exact answer is never buried under lookalikes', () => {
  assert.deepEqual(find('widya'), { ids: ['#11288', '261003MT5BUKTW', '#11176', '#11134'], fuzzy: false }, 'awalan kata: semua Widya*');
  assert.deepEqual(find('putri widya'), { ids: ['#11288'], fuzzy: false }, 'urutan kata bebas');
  assert.deepEqual(find('ika'), { ids: ['#11301'], fuzzy: false });
});

test('a short word gets no typo allowance, so it cannot match half the list', () => {
  assert.deepEqual(find('iko'), { ids: [], fuzzy: false });
});

test('order ids and tracking numbers ignore their separators and forgive one slip when long', () => {
  assert.deepEqual(find('11288').ids, ['#11288']);
  assert.deepEqual(find('shf 0042').ids, ['SHF-0042']);
  assert.deepEqual(find('cm49107179384').ids, ['261003MT5BUKTW']);
  assert.deepEqual(find('CM49107179385'), { ids: ['261003MT5BUKTW'], fuzzy: true });
});

test('the distance is Damerau-Levenshtein and stops early', () => {
  assert.equal(distance('widya', 'widay', 2), 1);
  assert.equal(distance('kitten', 'sitting', 3), 3);
  assert.equal(distance('abcdef', 'uvwxyz', 1), 2, 'abandoned at max + 1');
});

test('the list filter keeps channel and stage and carries the near flag', () => {
  const r = filterOrders(orders.map((o) => ({ ...o, stage: 'to_ship' })), { channel: 'shopify', q: 'widay putri' });
  assert.deepEqual(r.map((o) => o.id), ['#11288']);
  assert.equal(r.fuzzy, true);
});
