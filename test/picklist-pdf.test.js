import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { picklistPdf } from '../src/picklist-pdf.js';
import { buildPicklist } from '../src/picklist.js';

/** The batch sheet is a real PDF, survives text a standard font cannot draw, and never fetches for long. */

const orders = Array.from({ length: 30 }, (_, i) => ({
  channel: ['shopee', 'shopify', 'tokopedia', 'manual'][i % 4], id: `X${i}`, stage: 'to_ship', buyer: i % 2 ? 'Dewi Ayu 🌸' : '李华',
  lines: [{ sku: 'OMC-90-001', qty: 1 + (i % 3), name: 'Capsules' }, { sku: 'TIDAK-ADA', qty: 1, name: 'Produk ✨ baru' }],
}));

test('a batch becomes an A4 PDF, over as many pages as it needs', async () => {
  const bytes = await picklistPdf({ date: '2026-10-08', orders, picklist: buildPicklist(orders), images: { 'OMC-90-001': { url: 'https://x/a.jpg' } }, fetcher: async () => ({ ok: false }) });
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);
  assert.deepEqual(doc.getPage(0).getSize().width.toFixed(0), '595');
});

test('an empty batch is one page that says so', async () => {
  const doc = await PDFDocument.load(await picklistPdf({ date: '2026-10-08', orders: [], picklist: buildPicklist([]) }));
  assert.equal(doc.getPageCount(), 1);
});
