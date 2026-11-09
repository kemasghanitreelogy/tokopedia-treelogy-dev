import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShopeeLabels, shopeeNotCreated } from '../src/labels.js';

/**
 * 9 Nov: the first status question of a 100-order run was refused with
 * shipping_document_should_print_first (some orders had no document yet - expected).
 * That refusal stuck, and three orders Shopee was still generating (PROCESSING) were
 * reported as "check the order" with it, instead of "not ready, reprint".
 */
const printFirst = (sns) => {
  const error = new Error(`/api/v2/logistics/get_shipping_document_result failed: The package should print first. Detail: these orders: ${sns.join(',')} should print (logistics.shipping_document_should_print_first)`);
  error.code = 'logistics.shipping_document_should_print_first';
  return error;
};

const run = ({ created = new Set(), readyAt = {}, slow = new Set(), createSkips = new Set() } = {}) => {
  const calls = [];
  const asks = {};
  const call = async (config, path, auth, params, body) => {
    calls.push({ path, sns: (body?.order_list ?? []).map((o) => o.order_sn) });
    if (path.endsWith('get_shipping_document_result')) {
      const sns = body.order_list.map((o) => o.order_sn);
      const unmade = sns.filter((sn) => !created.has(sn));
      if (unmade.length) throw printFirst(unmade);
      return { response: { result_list: sns.map((order_sn) => {
        asks[order_sn] = (asks[order_sn] ?? 0) + 1;
        const ready = !slow.has(order_sn) && asks[order_sn] >= (readyAt[order_sn] ?? 1);
        return { order_sn, status: ready ? 'READY' : 'PROCESSING' };
      }) } };
    }
    if (path.endsWith('create_shipping_document')) {
      for (const o of body.order_list) if (!createSkips.has(o.order_sn)) created.add(o.order_sn);
      return { response: { result_list: [] } };
    }
    if (path.endsWith('get_tracking_number')) return { response: { tracking_number: `SPX${params.order_sn}` } };
    throw new Error(`unexpected ${path}`);
  };
  const download = async (config, auth, sns) => ({ pages: [{ covers: sns.map((id) => ({ channel: 'shopee', id })), bytes: new Uint8Array(1) }], failures: [] });
  return { calls, deps: { session: async () => ({ config: {}, auth: {} }), call, download, wait: async () => {} } };
};

const order = (id) => ({ channel: 'shopee', id });

test('a refused first question does not follow orders that are only still generating', async () => {
  const { deps } = run({ created: new Set(['261109SWWXPM8S']), slow: new Set(['261109SQ1WQEET', '261109RYFSY7T0']) });
  const out = await fetchShopeeLabels(['261109SWWXPM8S', '261109SQ1WQEET', '261109RYFSY7T0', '261109SSW9N810'].map(order), 'THERMAL_AIR_WAYBILL', deps);
  const printed = out.pages.flatMap((p) => p.covers.map((c) => c.id)).sort();
  assert.deepEqual(printed, ['261109SSW9N810', '261109SWWXPM8S']);
  assert.deepEqual(out.failures.map((f) => [f.id, f.kind, f.reason]).sort(), [
    ['261109RYFSY7T0', 'wait', 'dokumen belum siap di kurir setelah menunggu'],
    ['261109SQ1WQEET', 'wait', 'dokumen belum siap di kurir setelah menunggu'],
  ]);
});

test('an order that already has a document is not created again because a neighbour had none', async () => {
  const { calls, deps } = run({ created: new Set(['261109SWWXPM8S']) });
  await fetchShopeeLabels(['261109SWWXPM8S', '261109SSW9N810'].map(order), 'THERMAL_AIR_WAYBILL', deps);
  const createdFor = calls.filter((c) => c.path.endsWith('create_shipping_document')).flatMap((c) => c.sns);
  assert.deepEqual(createdFor, ['261109SSW9N810']);
});

test('an order Shopee still has no document for after creating says reprint, not check', async () => {
  const { deps } = run({ createSkips: new Set(['261109SSFG3QU4']) });
  const out = await fetchShopeeLabels(['261109SSFG3QU4', '261109SQDCUJ20'].map(order), 'THERMAL_AIR_WAYBILL', deps);
  assert.deepEqual(out.pages.flatMap((p) => p.covers.map((c) => c.id)), ['261109SQDCUJ20']);
  assert.deepEqual(out.failures.map((f) => [f.id, f.kind]), [['261109SSFG3QU4', 'retry']]);
});

test('only orders named in the refusal and in the group count as without a document', () => {
  assert.deepEqual(shopeeNotCreated(printFirst(['261109SWWXPM8S', '261109OTHER000']), ['261109SWWXPM8S', '261109SSW9N810']), ['261109SWWXPM8S']);
  const other = new Error('boom'); other.code = 'error_param';
  assert.deepEqual(shopeeNotCreated(other, ['261109SWWXPM8S']), []);
});
