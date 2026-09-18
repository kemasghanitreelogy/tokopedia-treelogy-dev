import test from 'node:test';
import assert from 'node:assert/strict';
import { ordersForPrinting } from '../src/orders-by-id.js';

const order = (channel, id) => ({ channel, id, total: 1000, lines: [] });

test('what the database holds is never asked of the platforms again', async () => {
  let asked = null;
  const result = await ordersForPrinting(
    [{ channel: 'shopify', id: '#10926' }, { channel: 'shopee', id: '260918ABC' }],
    {
      hasDatabase: () => true,
      readStored: async () => [order('shopify', '#10926'), order('shopee', '260918ABC')],
      readLive: async (rows) => { asked = rows; return { orders: [], errors: {} }; },
    },
  );
  assert.equal(result.orders.length, 2);
  assert.equal(result.fromDb, 2);
  assert.equal(result.fromPlatform, 0);
  assert.equal(asked, null, 'tidak ada panggilan ke marketplace sama sekali');
});

test('only what is missing is fetched, and only from the channel that is missing it', async () => {
  let asked = [];
  const result = await ordersForPrinting(
    [{ channel: 'shopify', id: '#10926' }, { channel: 'shopify', id: '#99999' }],
    {
      hasDatabase: () => true,
      readStored: async () => [order('shopify', '#10926')],
      readLive: async (rows) => { asked = rows; return { orders: [order('shopify', '#99999')], errors: {} }; },
    },
  );
  assert.deepEqual(asked, [{ channel: 'shopify', id: '#99999' }]);
  assert.equal(result.orders.length, 2);
  assert.equal(result.fromDb, 1);
  assert.equal(result.fromPlatform, 1);
});

test('a database that is down is a slow print, never a failed one', async () => {
  const result = await ordersForPrinting([{ channel: 'shopify', id: '#10926' }], {
    hasDatabase: () => true,
    readStored: async () => { throw new Error('supabase mati'); },
    readLive: async () => ({ orders: [order('shopify', '#10926')], errors: {} }),
  });
  assert.equal(result.orders.length, 1);
  assert.equal(result.fromPlatform, 1);
});

test('with no database at all it behaves exactly as it did before', async () => {
  let asked = null;
  const result = await ordersForPrinting([{ channel: 'shopee', id: 'X' }], {
    hasDatabase: () => false,
    readStored: async () => { throw new Error('tidak boleh dipanggil'); },
    readLive: async (rows) => { asked = rows; return { orders: [order('shopee', 'X')], errors: {} }; },
  });
  assert.deepEqual(asked, [{ channel: 'shopee', id: 'X' }]);
  assert.equal(result.orders.length, 1);
});

test('a platform that refuses is reported rather than thrown, and nothing is invented', async () => {
  const result = await ordersForPrinting([{ channel: 'shopify', id: '#1' }], {
    hasDatabase: () => true,
    readStored: async () => [],
    readLive: async () => { throw new Error('token kedaluwarsa'); },
  });
  assert.deepEqual(result.orders, []);
  assert.match(result.errors.all, /token kedaluwarsa/);
});

test('an empty or malformed selection asks nobody anything', async () => {
  const never = async () => { throw new Error('tidak boleh dipanggil'); };
  for (const selection of [[], [{ channel: '', id: '' }], [{ channel: 'shopify' }]]) {
    const result = await ordersForPrinting(selection, { hasDatabase: () => true, readStored: never, readLive: never });
    assert.deepEqual(result.orders, []);
  }
});
