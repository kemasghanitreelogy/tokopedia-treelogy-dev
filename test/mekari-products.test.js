import test from 'node:test';
import assert from 'node:assert/strict';
import { MekariError } from '../src/mekari/client.js';
import { PRODUCTS } from '../src/master.js';
import { ensureProducts, stampReady, catalogueKey, explainMissingProduct, uniqueProductName } from '../src/mekari/setup.js';
import { productNameFor } from '../src/mekari/invoice.js';

/**
 * 10 Nov: The-Inside-&-Out180+60 could not be created because the removed
 * The-Inside-&-Out180+30 still held the same name in Jurnal ("Product name has already
 * been taken"). The refusal threw out of ensureProducts, failed the whole sweep, and held
 * back every other order's invoice too.
 */

const NEW = 'MRS-004';
const OTHER = 'MRS-003';

const jurnal = ({ taken = new Set(), refuse = new Map() } = {}) => {
  const posts = [];
  const call = async ({ method = 'GET', body }) => {
    if (method === 'GET') {
      return { total_pages: 1, products: PRODUCTS.filter((p) => p.sku !== NEW && p.sku !== OTHER).map((p) => ({ product_code: p.sku })) };
    }
    const { name, product_code: code } = body.product;
    posts.push({ name, code });
    if (refuse.has(code)) throw refuse.get(code);
    if (taken.has(name)) {
      throw new MekariError('POST /public/jurnal/api/v1/products -> HTTP 422: "full_messages: Product name has already been taken; error_full_messages: Failed to save product"', { status: 422 });
    }
    return { product: { id: 1 } };
  };
  return { posts, call };
};

test('a name held by another Jurnal product is told apart by its SKU, and still created', async () => {
  const plain = productNameFor({ sku: NEW });
  const { posts, call } = jurnal({ taken: new Set([plain]) });
  const out = await ensureProducts({ dryRun: false, call });
  assert.deepEqual(out.created.sort(), [OTHER, NEW].sort());
  assert.deepEqual(out.failed, []);
  assert.deepEqual(posts.filter((p) => p.code === NEW).map((p) => p.name), [plain, uniqueProductName({ name: plain, sku: NEW })]);
});

test('one product Jurnal refuses does not stop the others, and leaves nothing proven', async () => {
  const refusal = new MekariError('POST /public/jurnal/api/v1/products -> HTTP 422: "something else"', { status: 422 });
  const { call } = jurnal({ refuse: new Map([[NEW, refusal]]) });
  const out = await ensureProducts({ dryRun: false, call });
  assert.deepEqual(out.created, [OTHER]);
  assert.deepEqual(out.failed.map((f) => f.sku), [NEW]);

  const ledger = { ready_at: new Date().toISOString(), ready_for: catalogueKey() };
  stampReady(ledger);
  assert.equal(ledger.ready_at, undefined, 'a check that left a product uncreated proves nothing');

  const told = explainMissingProduct('POST /public/jurnal/api/v1/sales_invoices -> HTTP 422: "Product in transaction lines attributes on row 1 not available"');
  assert.match(told, new RegExp(`produk belum bisa dibuat di Jurnal: ${NEW}`));
});

test('running out of quota still stops the check, because every product after it would fail too', async () => {
  const outage = new MekariError('kuota', { status: 429 });
  const { posts, call } = jurnal({ refuse: new Map([[OTHER, outage], [NEW, outage]]) });
  await assert.rejects(ensureProducts({ dryRun: false, call }), /kuota/);
  assert.equal(posts.length, 1);
});

test('an invoice refused for a missing product creates it and is posted again, once', async () => {
  const { postInvoiceCreatingProducts } = await import('../src/mekari/sync.js');
  const missing = new MekariError('POST /public/jurnal/api/v1/sales_invoices -> HTTP 422: "Product in transaction lines attributes on row 1 not available"', { status: 422 });
  let posts = 0;
  const asked = [];
  const post = async () => { posts += 1; if (posts === 1) throw missing; return { sales_invoice: { id: 9 } }; };
  const ensure = async (codes) => { asked.push(...codes); return { created: codes, alreadyThere: [], failed: [] }; };
  const payload = { sales_invoice: { custom_id: 'TRL-shopify-13078', transaction_lines_attributes: [{ product_code: 'The-Inside-&-Out180+60' }, { product_code: 'Travel-Pouch' }] } };
  const out = await postInvoiceCreatingProducts(payload, { post, ensure });
  assert.equal(out.sales_invoice.id, 9);
  assert.equal(posts, 2);
  assert.deepEqual(asked, ['The-Inside-&-Out180+60', 'Travel-Pouch']);
});

test('when no product could be made, the refusal is not posted again and says why', async () => {
  const { postInvoiceCreatingProducts } = await import('../src/mekari/sync.js');
  const missing = new MekariError('POST /public/jurnal/api/v1/sales_invoices -> HTTP 422: "Product in transaction lines attributes on row 1 not available"', { status: 422 });
  let posts = 0;
  const post = async () => { posts += 1; throw missing; };
  const ensure = async () => ({ created: [], alreadyThere: [], failed: [{ sku: 'X-1', error: 'ditolak' }] });
  await assert.rejects(
    postInvoiceCreatingProducts({ sales_invoice: { transaction_lines_attributes: [{ product_code: 'X-1' }] } }, { post, ensure }),
    /produk tidak bisa dibuat di Jurnal: X-1 \(ditolak\)/,
  );
  assert.equal(posts, 1);
});

test('any other refusal is passed through untouched, without creating anything', async () => {
  const { postInvoiceCreatingProducts } = await import('../src/mekari/sync.js');
  const other = new MekariError('HTTP 422: "person not exist"', { status: 422 });
  let ensured = false;
  await assert.rejects(postInvoiceCreatingProducts({ sales_invoice: {} }, { post: async () => { throw other; }, ensure: async () => { ensured = true; } }), /person not exist/);
  assert.equal(ensured, false);
});
