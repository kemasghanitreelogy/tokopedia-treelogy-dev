import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmCatalog, confirmListing } from '../src/confirm-writes.js';
import { invoiceGone } from '../src/mekari/discard.js';
import { refundOrder } from '../src/mekari/refund.js';
import { customIdFor } from '../src/mekari/invoice.js';

const noWait = { waits: [1, 1], wait: async () => {} };
const catalog = (field, ...values) => ({ skus: [{ sku: 'A', tiktok: { rows: values.map((v) => ({ [field]: v })) } }], errors: {} });
const written = (field, to) => ({ sku: 'A', channel: 'tiktok', field, to, status: 'ok' });
const reads = (...answers) => async () => answers.length > 1 ? answers.shift() : answers[0];

test('a price is confirmed only when every listing reads the new figure', async () => {
  const [good] = await confirmCatalog([written('price', 100)], { read: reads(catalog('price', 100, 100)), ...noWait });
  assert.equal(good.status, 'ok');
  const [bad] = await confirmCatalog([written('price', 100)], { read: reads(catalog('price', 100, 90)), ...noWait });
  assert.equal(bad.status, 'unconfirmed');
  assert.match(bad.error, /harga masih terbaca 90, seharusnya 100/);
});

test('a figure that lands a moment later is confirmed, a refused write keeps its own words', async () => {
  const refused = { ...written('qty', 5), status: 'failed', error: 'TikTok menolak' };
  const results = await confirmCatalog([written('qty', 5), refused], { read: reads(catalog('qty', 4), catalog('qty', 5)), ...noWait });
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[1], refused);
});

test('a channel that cannot be read, or a listing not found, is never a success', async () => {
  const down = { skus: [], errors: { tiktok: 'timeout' } };
  const [a] = await confirmCatalog([written('qty', 5)], { read: reads(down), ...noWait });
  assert.match(a.error, /tidak terbaca \(timeout\)/);
  const [b] = await confirmCatalog([written('qty', 5)], { read: reads({ skus: [], errors: {} }), ...noWait });
  assert.equal(b.status, 'unconfirmed');
  const [c] = await confirmCatalog([written('qty', 5)], { read: async () => { throw new Error('putus'); }, ...noWait });
  assert.match(c.error, /putus/);
});

test('a listing edit is compared field by field, whitespace aside', async () => {
  const read = async () => ({ title: 'Baru', description: 'satu\n\ndua', weightGram: 200, dims: { l: 1, w: 2, h: 3 } });
  const same = { title: 'Baru', description: 'satu dua', weightGram: '200', dims: { l: '1', w: '2', h: '3' } };
  assert.equal((await confirmListing('shopee', {}, { patch: same }, { read, ...noWait })).status, 'ok');
  const out = await confirmListing('shopee', {}, { patch: { ...same, title: 'Lain', weightGram: 300 } }, { read, ...noWait });
  assert.equal(out.status, 'unconfirmed');
  assert.match(out.error, /judul, berat belum berubah/);
});

test('on and off are read from the listing status of each channel', async () => {
  const says = (status) => async () => ({ status });
  assert.equal((await confirmListing('shopee', {}, { active: true }, { read: says('NORMAL'), ...noWait })).status, 'ok');
  assert.equal((await confirmListing('tiktok', {}, { active: false }, { read: says('SELLER_DEACTIVATED'), ...noWait })).status, 'ok');
  const pending = await confirmListing('tiktok', {}, { active: true }, { read: says('PENDING'), ...noWait });
  assert.match(pending.error, /status \(PENDING\) belum berubah/);
  const down = await confirmListing('shopee', {}, { active: true }, { read: async () => { throw new Error('putus'); }, ...noWait });
  assert.match(down.error, /tidak terbaca \(putus\)/);
});

test('an invoice is gone only when Jurnal says so', async () => {
  const missing = Object.assign(new Error('not found'), { status: 404 });
  assert.equal(await invoiceGone(async () => { throw missing; }, 1), true);
  assert.equal(await invoiceGone(async () => ({ sales_invoice: { id: 1 } }), 1), false);
  assert.equal(await invoiceGone(async () => { throw new Error('timeout'); }, 1), false);
});

test('a refund says whether the invoice really went', async () => {
  let deletedYet = false;
  const call = async ({ method }) => {
    if (method === 'DELETE') { deletedYet = true; return {}; }
    if (deletedYet) throw Object.assign(new Error('nf'), { status: 404 });
    return { sales_invoice: { id: 9, transaction_no: 'INV-9', payment_received_amount: 0, deletable: true } };
  };
  const order = { id: '#1', channel: 'shopify', total: 10 };
  const deps = {
    read: async () => order, call, saveLedger: async () => {}, update: async () => {},
    loadLedger: async () => ({ orders: { [customIdFor(order)]: { invoice_id: 9 } } }),
  };
  const out = await refundOrder({ channel: 'shopify', id: '#1' }, deps);
  assert.equal(out.deleted, true);
  assert.equal(out.gone, true);
});
