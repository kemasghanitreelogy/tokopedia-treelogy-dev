import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShopeeLabels, SHOPEE_BATCH_MAX } from '../src/labels.js';

/**
 * 19 Oct: a print run of 56 Shopee orders failed whole, each "dokumen belum siap", while
 * Shopee had all 56 READY. get_shipping_document_result takes at most 50 orders and
 * refuses more with error_param; the refusal was swallowed and read as "not ready".
 */
const tooMany = () => {
  const error = new Error('/api/v2/logistics/get_shipping_document_result failed: Wrong parameters, detail: order_list must contain at maximum 50 items. (error_param)');
  error.code = 'error_param';
  return error;
};

const shopee = ({ ready = () => true, refuse } = {}) => {
  const calls = [];
  const call = async (config, path, auth, params, body) => {
    calls.push({ path, size: body?.order_list?.length ?? 0 });
    if (refuse) throw refuse;
    if ((body?.order_list?.length ?? 0) > SHOPEE_BATCH_MAX) throw tooMany();
    if (path.endsWith('get_shipping_document_result')) {
      return { response: { result_list: body.order_list.map(({ order_sn }) => ({ order_sn, status: ready(order_sn) ? 'READY' : 'PROCESSING' })) } };
    }
    if (path.endsWith('create_shipping_document')) return { response: { result_list: [] } };
    if (path.endsWith('get_tracking_number')) return { response: { tracking_number: `SPX${params.order_sn}` } };
    throw new Error(`unexpected ${path}`);
  };
  const downloads = [];
  const download = async (config, auth, sns) => {
    downloads.push(sns.length);
    return { pages: [{ covers: sns.map((id) => ({ channel: 'shopee', id })), bytes: new Uint8Array(1) }], failures: [] };
  };
  return { calls, downloads, deps: { session: async () => ({ config: {}, auth: {} }), call, download, wait: async () => {} } };
};

const orders = (n) => Array.from({ length: n }, (_, i) => ({ channel: 'shopee', id: `261019${String(i).padStart(8, '0')}`, tracking: `SPX${i}` }));

test('a run of 56 READY documents prints all 56, asked of Shopee 50 at a time', async () => {
  const { calls, downloads, deps } = shopee();
  const out = await fetchShopeeLabels(orders(56), 'THERMAL_AIR_WAYBILL', deps);
  assert.deepEqual(out.failures, []);
  assert.equal(out.pages.flatMap((p) => p.covers).length, 56);
  assert.ok(calls.every((c) => c.size <= SHOPEE_BATCH_MAX), 'no call over the limit');
  assert.deepEqual(downloads, [50, 6]);
});

test('documents still to be made are created and polled in groups of 50 too', async () => {
  let created = false;
  const { calls, deps } = shopee({ ready: () => created });
  const call = deps.call;
  deps.call = async (...args) => { const r = await call(...args); if (args[1].endsWith('create_shipping_document')) created = true; return r; };
  const out = await fetchShopeeLabels(orders(120), 'THERMAL_AIR_WAYBILL', deps);
  assert.deepEqual(out.failures, []);
  assert.equal(out.pages.flatMap((p) => p.covers).length, 120);
  assert.deepEqual(calls.filter((c) => c.path.endsWith('create_shipping_document')).map((c) => c.size), [50, 50, 20]);
});

test('a status read Shopee refuses is reported as itself, not as "not ready yet"', async () => {
  const { deps } = shopee({ refuse: Object.assign(new Error('Wrong parameters (error_param)'), { code: 'error_param' }) });
  const out = await fetchShopeeLabels(orders(3), 'THERMAL_AIR_WAYBILL', deps);
  assert.equal(out.failures.length, 3);
  for (const f of out.failures) assert.doesNotMatch(f.reason, /belum siap/);
});
