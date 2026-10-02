import test from 'node:test';
import assert from 'node:assert/strict';
import { ordersMatchingId, ID_SEARCH_MIN } from '../src/db/orders.js';

test('a fragment too short to mean one order is not searched at all', async () => {
  assert.equal(ID_SEARCH_MIN, 4);
  // Returns before any request: "1" would match the whole table.
  assert.deepEqual(await ordersMatchingId('123'), []);
  // Characters that are not part of an order id do not count towards the length, and never
  // reach the PostgREST filter: "*,)" would otherwise rewrite it.
  assert.deepEqual(await ordersMatchingId('#*,)1'), []);
});
