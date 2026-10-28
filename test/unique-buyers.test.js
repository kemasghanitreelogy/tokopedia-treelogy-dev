import test from 'node:test';
import assert from 'node:assert/strict';
import { buyerKey, countUniqueBuyers, publishUniqueBuyers, METAFIELD } from '../src/unique-buyers.js';

const NOW = Date.UTC(2026, 1, 15);
const STARTS = { shopify: '2026-01', shopee: '2026-01', tiktok: '2026-01' };

test('one buyer per channel key: Shopify email, Shopee username, Tokopedia relay', () => {
  assert.equal(buyerKey({ channel: 'shopify', buyerEmail: ' A@b.co ', buyerPhone: '+62 81' }), 'a@b.co');
  assert.equal(buyerKey({ channel: 'shopify', buyerEmail: '', buyerPhone: '+62 812-1' }), '628121');
  assert.equal(buyerKey({ channel: 'shopee', buyer: 'Rl3go' }), 'rl3go');
  assert.equal(buyerKey({ channel: 'tokopedia', buyerEmail: 'x@scs2.tiktok.com', buyer: 'Y***i' }), 'x@scs2.tiktok.com');
});

test('repeat buyers count once, cancelled orders and keyless orders not at all', async () => {
  const months = {
    'shopify 2026-01': [
      { channel: 'shopify', stage: 'completed', buyerEmail: 'a@x' },
      { channel: 'shopify', stage: 'cancelled', buyerEmail: 'b@x' },
    ],
    'shopify 2026-02': [{ channel: 'shopify', stage: 'to_ship', buyerEmail: 'A@x' }],
    'shopee 2026-01': [{ channel: 'shopee', stage: 'delivered', buyer: '' }],
    'tiktok 2026-02': [
      { channel: 'tokopedia', stage: 'completed', buyerEmail: 'r1@scs2' },
      { channel: 'tiktok_shop', stage: 'shipping', buyerEmail: 'r1@scs2' },
    ],
  };
  const result = await countUniqueBuyers({ now: NOW, starts: STARTS, pull: async (s, m) => months[`${s} ${m}`] ?? [] });
  assert.deepEqual(result.channels, {
    shopify: { orders: 2, buyers: 1 },
    tokopedia: { orders: 1, buyers: 1 },
    tiktok_shop: { orders: 1, buyers: 1 },
  });
  assert.equal(result.total, 3);
  assert.deepEqual(result.failed, []);
});

test('a month that never answers is reported after three tries, and nothing is published', async () => {
  let tries = 0;
  const result = await countUniqueBuyers({ now: NOW, starts: { shopee: '2026-02' }, pull: async () => { tries++; throw new Error('down'); } });
  assert.equal(tries, 3);
  assert.deepEqual(result.failed, ['shopee 2026-02']);
  const calls = [];
  await assert.rejects(() => publishUniqueBuyers({ ...result, total: 5 }, { graphql: async (q) => { calls.push(q); return {}; } }), /tidak terbaca/);
  assert.equal(calls.length, 0);
});

const shop = (value) => async (query, variables) => {
  shop.calls.push({ query, variables });
  if (/^query/.test(query)) return { shop: { id: 'gid://shopify/Shop/1', metafield: value === null ? null : { value: String(value) } } };
  return { metafieldsSet: { metafields: [], userErrors: [] } };
};

test('the count is written to the shop metafield as an integer', async () => {
  shop.calls = [];
  const out = await publishUniqueBuyers({ total: 21135, failed: [] }, { graphql: shop(null) });
  assert.deepEqual(out, { before: 0, after: 21135, changed: true });
  const write = shop.calls[1].variables.metafields[0];
  assert.deepEqual(write, { ownerId: 'gid://shopify/Shop/1', ...METAFIELD, type: 'number_integer', value: '21135' });
});

test('an unchanged count writes nothing, and a sudden fall is refused', async () => {
  shop.calls = [];
  assert.equal((await publishUniqueBuyers({ total: 21135, failed: [] }, { graphql: shop(21135) })).changed, false);
  await assert.rejects(() => publishUniqueBuyers({ total: 15000, failed: [] }, { graphql: shop(21135) }), /tidak ditulis/);
  assert.ok(shop.calls.every((c) => /^query/.test(c.query)));
});

test('read-only mode refuses before the write is sent', async () => {
  shop.calls = [];
  process.env.TREELOGY_READONLY = '1';
  try {
    await assert.rejects(() => publishUniqueBuyers({ total: 22000, failed: [] }, { graphql: shop(21135) }), /READ-ONLY/);
  } finally {
    delete process.env.TREELOGY_READONLY;
  }
  assert.ok(shop.calls.every((c) => /^query/.test(c.query)));
});
