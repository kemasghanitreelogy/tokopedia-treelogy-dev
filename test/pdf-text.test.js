import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText, printable, printableDeep } from '../src/pdf-text.js';
import { buildShopifyLabels, PICK_DOC } from '../src/shopify/label.js';
import { buildFaktur } from '../src/faktur.js';
import { buildLabelSheet } from '../src/labels.js';
import { buildManualOrder } from '../src/mekari/manual.js';
import { deleteDoc, closeStore } from '../src/store/index.js';

/**
 * 17 Oct: DP-261017-00006WH was saved with its phone pasted from WhatsApp,
 * "+62 822‑7000‑7777" - non-breaking hyphens. Helvetica cannot draw U+2011, pdf-lib
 * threw, and the seven labels printed with it all failed.
 */
const PASTED = '+62 822‑7000‑7777';

test.after(async () => { await closeStore(); });

const order = (over = {}) => ({
  channel: 'manual', id: 'DP-261017-00006WH', source: 'DP', createdAt: 1792209600, total: 250000,
  buyer: 'Bu Sinta', buyerPhone: PASTED, shipTo: 'Jl. Kertha Dalem IV No 10, Denpasar',
  lines: [{ sku: 'OMC-90-001', name: 'Kapsul 90', variant: '', qty: 1 }],
  ...over,
});

test('look-alikes become plain text, and what Helvetica cannot draw is left out', () => {
  assert.equal(plainText(PASTED), '+62 822-7000-7777');
  assert.equal(plainText('a b​c−d'), 'a bc-d');
  assert.equal(printable('Bu Sinta 🎁 ‑ Café – “ok”'), 'Bu Sinta  - Café – “ok”', 'WinAnsi keeps é, en dash and curly quotes');
  assert.equal(printable(undefined), '');
  const deep = printableDeep({ buyerPhone: PASTED, total: 5, lines: [{ name: 'A‑B', qty: 2 }], at: null });
  assert.deepEqual(deep, { buyerPhone: '+62 822-7000-7777', total: 5, lines: [{ name: 'A-B', qty: 2 }], at: null });
});

test('the label and the invoice draw an order carrying the pasted number', async () => {
  const label = await buildShopifyLabels([{ order: order(), pick: '000000001' }]);
  assert.ok(label.length > 1000);
  const faktur = await buildFaktur({ ...order(), finance: {}, lines: [{ sku: 'OMC-90-001', name: 'Kapsul 90', qty: 1, unitPrice: 250000 }] });
  assert.ok(faktur.length > 1000);
});

test('a WhatsApp number is stored plain, so it never reaches a label or Jurnal as typed', () => {
  const built = buildManualOrder({
    source: 'DP', code: 'DP-261017-00006WH', date: '2026-10-17', buyer: 'Bu Sinta', buyerPhone: PASTED,
    shipTo: 'Jl. Kertha Dalem IV No 10', note: '', shipping: 0,
    lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 250000, unitDiscount: 0 }],
    now: Date.parse('2026-10-17T04:00:00Z'),
  });
  assert.equal(built.buyerPhone, '+62 822-7000-7777');
  assert.equal(built.buyer, 'Bu Sinta');
  assert.equal(built.shipTo, 'Jl. Kertha Dalem IV No 10');
});

test('one order the drawing chokes on fails alone; the rest of the run prints', async () => {
  await deleteDoc(PICK_DOC);
  const broken = order({ id: 'DP-261017-00006XX' });
  Object.defineProperty(broken.lines[0], 'name', { enumerable: true, get() { throw new Error('rusak'); } });
  const good = [order({ id: 'DP-261017-00006YK' }), order({ id: 'DP-261017-00006XJ' })];
  const sheet = await buildLabelSheet({
    orders: [...good, broken].map(({ channel, id }) => ({ channel, id })),
    resolveShopify: async () => [...good, broken],
  });
  assert.equal(sheet.pageCount, 2);
  assert.deepEqual(sheet.printed.sort(), ['manual:DP-261017-00006XJ', 'manual:DP-261017-00006YK']);
  assert.equal(sheet.failures.length, 1);
  assert.equal(sheet.failures[0].id, 'DP-261017-00006XX');
  assert.match(sheet.failures[0].reason, /rusak/);
});
