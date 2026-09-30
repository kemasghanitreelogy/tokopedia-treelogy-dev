import test from 'node:test';
import assert from 'node:assert/strict';

import { isTransientShopeeError } from '../src/shopee/client.js';
import { createShopeeDocuments, CREATE_SPLIT_BUDGET } from '../src/labels.js';
import { ShopeeError } from '../src/shopee/auth.js';

const refusal = (code) => new ShopeeError('/api/v2/logistics/create_shipping_document', {
  error: code, message: 'Something wrong. Please try later.',
});

test('a namespaced server error is recognised as worth asking again', () => {
  // The bug: Shopee answers `common.error_server` and the retry set held `error_server`,
  // so every transient fault was treated as a final answer and the backoff never ran.
  assert.equal(isTransientShopeeError(refusal('common.error_server')), true);
  assert.equal(isTransientShopeeError(refusal('error_server')), true);
  assert.equal(isTransientShopeeError(refusal('logistics.error_rate_limit')), true);
  // A real answer stays a real answer: asking again cannot make a parameter valid.
  assert.equal(isTransientShopeeError(refusal('logistics.error_param')), false);
  assert.equal(isTransientShopeeError(refusal('common.error_auth')), false);
});

test('a 5xx or a dropped connection is transient without any code at all', () => {
  assert.equal(isTransientShopeeError({ httpStatus: 503 }), true);
  assert.equal(isTransientShopeeError({ name: 'AbortError' }), true);
  assert.equal(isTransientShopeeError({ httpStatus: 400 }), false);
  assert.equal(isTransientShopeeError(undefined), false);
});

const list = (...sns) => sns.map((order_sn) => ({ order_sn }));

test('a batch refused with no detail is halved, and only the bad order is blamed', async () => {
  // Shopee refuses the whole request whenever one particular order is in it, and never
  // says which. Seventeen labels were reported failed on 30 Sep for exactly this.
  const calls = [];
  const call = async (_config, _path, _auth, _params, body) => {
    const sns = body.order_list.map((i) => i.order_sn);
    calls.push(sns);
    if (sns.includes('BAD')) throw refusal('common.error_server');
    return { response: { result_list: sns.map((order_sn) => ({ order_sn })) } };
  };

  const failures = [];
  await createShopeeDocuments({}, {}, list('A', 'B', 'BAD', 'D'), (id, reason) => failures.push({ id, reason }),
    { left: CREATE_SPLIT_BUDGET }, { call });

  assert.deepEqual(failures.map((f) => f.id), ['BAD'], 'hanya pesanan bermasalah yang gagal');
  assert.ok(calls.length <= 7, `pembagian tetap murah, ${calls.length} panggilan`);
});

test('per-order answers are passed through untouched, and the batch is not split for them', async () => {
  const calls = [];
  const call = async (_c, _p, _a, _q, body) => {
    calls.push(body.order_list.length);
    return {
      response: {
        result_list: body.order_list.map(({ order_sn }) => (order_sn === 'B'
          ? { order_sn, fail_error: 'logistics.error_param', fail_message: 'The tracking number is invalid.' }
          : { order_sn })),
      },
    };
  };

  const failures = [];
  await createShopeeDocuments({}, {}, list('A', 'B', 'C'), (id, reason) => failures.push({ id, reason }),
    { left: CREATE_SPLIT_BUDGET }, { call });

  assert.deepEqual(calls, [3], 'satu panggilan saja');
  assert.deepEqual(failures, [{ id: 'B', reason: 'The tracking number is invalid.' }]);
});

test('when Shopee is simply down the split stops, and says so in words the bench can act on', async () => {
  let calls = 0;
  const call = async () => { calls += 1; throw refusal('common.error_server'); };

  const failures = [];
  await createShopeeDocuments({}, {}, list('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'),
    (id, reason) => failures.push({ id, reason }), { left: CREATE_SPLIT_BUDGET }, { call });

  assert.equal(failures.length, 8, 'setiap pesanan tetap dilaporkan');
  // Bounded: an outage must not cost a call per order, nor a minute of the bench's time.
  assert.ok(calls <= CREATE_SPLIT_BUDGET + 2, `panggilan dibatasi, terpakai ${calls}`);
  for (const failure of failures) {
    assert.match(failure.reason, /coba cetak lagi sebentar lagi/);
    assert.match(failure.reason, /common\.error_server/);
  }
});

test('the transport actually retries a namespaced server error, and succeeds on the second ask', async (t) => {
  // The predicate above is only half the fix; this is the half that shows the backoff is
  // now reachable at all. Before, a `common.error_server` threw straight out of the
  // first attempt and the caller saw a failed print run.
  const { callShopApi } = await import('../src/shopee/client.js');
  const config = { host: 'https://partner.example.com', partnerId: 1, partnerKey: 'k' };

  let asks = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    asks += 1;
    const body = asks === 1
      ? { error: 'common.error_server', message: 'Something wrong. Please try later.' }
      : { error: '', response: { result_list: [{ order_sn: 'A' }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });

  const out = await callShopApi(config, '/api/v2/logistics/create_shipping_document',
    { accessToken: 't', shopId: 1 }, {}, { order_list: [{ order_sn: 'A' }] });

  assert.equal(asks, 2, 'ditanya ulang sekali, bukan langsung menyerah');
  assert.deepEqual(out.response.result_list, [{ order_sn: 'A' }]);
});

test('a passing fault at the document host is waited out, not turned into failed labels', async (t) => {
  // The download answers with a PDF, so it never went through the transport's backoff:
  // one 502 used to fail the whole group on the first ask. Splitting cannot help a fault
  // that belongs to Shopee, so it waits first.
  const { downloadShopeeBatch } = await import('../src/labels.js');
  const pdf = new TextEncoder().encode('%PDF-1.4 label');

  let asks = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    asks += 1;
    if (asks === 1) return new Response('upstream', { status: 502 });
    // A 200 carrying JSON is Shopee's other way of saying the same thing.
    if (asks === 2) return new Response(JSON.stringify({ error: 'common.error_server', message: 'try later' }), { status: 200 });
    return new Response(pdf, { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });

  const out = await downloadShopeeBatch(
    { host: 'https://partner.example.com', partnerId: 1, partnerKey: 'k' },
    { accessToken: 't', shopId: 1 },
    ['A', 'B', 'C'],
    'THERMAL_AIR_WAYBILL',
  );

  assert.equal(asks, 3, 'ditanya ulang dua kali sebelum berhasil');
  assert.deepEqual(out.failures, [], 'tidak ada label yang dikorbankan');
  assert.equal(out.pages.length, 1);
  assert.equal(out.pages[0].count, 3);
});
