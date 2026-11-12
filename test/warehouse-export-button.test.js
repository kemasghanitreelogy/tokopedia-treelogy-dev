import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWarehouse } from '../src/pages/warehouse.js';

const warehouse = {
  items: { 'M-038': { name: 'Organic Moringa Oil 30 mL', qty: 10, uom: 'pcs', group: 'goods' } },
  moves: [{ id: 'a', at: 1794000000, code: 'M-038', kind: 'order', delta: -1, after: 10, note: 'Picklist shopify #13500', by: 'otomatis' }],
};
const user = { role: 'owner', name: 'o' };

test('the movement history can be downloaded, every day or a chosen range', () => {
  const html = renderWarehouse({ warehouse, user, csrf: 'x', range: { preset: '7d' }, errors: {}, generatedAt: Date.now(), stockExport: { today: '2026-11-12', first: '2026-10-06', days: { '2026-11-12': [1, 0, 1] } } });
  assert.match(html, /id="stock-export-open"/);
  assert.match(html, /<dialog class="ex ix" id="stock-export"/);
  assert.match(html, /data-preset="all"[^>]*>Semua</);
  assert.match(html, /name="from"/);
  assert.match(html, /name="to"/);
  assert.match(html, /name="dataset" value="inventory"/);
});

test('without the export data the page still renders, just without the button', () => {
  const html = renderWarehouse({ warehouse, user, csrf: 'x', range: { preset: '7d' }, errors: {}, generatedAt: Date.now() });
  assert.doesNotMatch(html, /stock-export-open/);
});
