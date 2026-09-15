import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The scan must never describe an invoice as its own duplicate.
 *
 * Paging through Jurnal's invoice list while deleting from it shifts rows between pages,
 * so the same invoice is read twice. Collected into a list, that reads as two copies -
 * and "delete the second copy" deletes the only one. It removed around five hundred
 * invoices before it was caught, which is why the grouping is keyed by invoice id and the
 * whole scan now completes before anything is deleted.
 */

/** The grouping, extracted from findDuplicates so it can be tested without an API. */
function group(rows) {
  const byCustomId = new Map();
  for (const row of rows) {
    const seen = byCustomId.get(row.custom_id) ?? new Map();
    seen.set(row.id, { id: row.id });
    byCustomId.set(row.custom_id, seen);
  }
  return [...byCustomId.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([customId, seen]) => {
      const sorted = [...seen.values()].sort((a, b) => a.id - b.id);
      return { customId, keep: sorted[0], drop: sorted.slice(1) };
    })
    .filter((g) => g.drop.length > 0 && g.drop.every((d) => d.id !== g.keep.id));
}

test('one invoice read twice is not a duplicate', () => {
  // Exactly what a shifting page produces: the same id, twice.
  assert.deepEqual(group([
    { custom_id: 'TRL-shopee-A', id: 100 },
    { custom_id: 'TRL-shopee-A', id: 100 },
  ]), []);
});

test('two genuinely different invoices for one order keep the oldest', () => {
  const [g] = group([
    { custom_id: 'TRL-shopee-A', id: 200 },
    { custom_id: 'TRL-shopee-A', id: 100 },
    { custom_id: 'TRL-shopee-A', id: 300 },
  ]);
  assert.equal(g.keep.id, 100, 'yang tertua disimpan - itu yang mungkin sudah dirujuk');
  assert.deepEqual(g.drop.map((d) => d.id), [200, 300]);
});

test('a repeated read of a real duplicate still drops only the extra', () => {
  // Both invoices seen twice by a shifting page. One is still the keeper, one still goes.
  const [g] = group([
    { custom_id: 'TRL-shopee-A', id: 100 },
    { custom_id: 'TRL-shopee-A', id: 200 },
    { custom_id: 'TRL-shopee-A', id: 100 },
    { custom_id: 'TRL-shopee-A', id: 200 },
  ]);
  assert.equal(g.keep.id, 100);
  assert.deepEqual(g.drop.map((d) => d.id), [200]);
});

test('an order with one invoice is left alone', () => {
  assert.deepEqual(group([{ custom_id: 'TRL-shopee-A', id: 100 }, { custom_id: 'TRL-shopee-B', id: 101 }]), []);
});
