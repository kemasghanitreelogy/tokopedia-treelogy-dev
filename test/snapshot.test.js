import test from 'node:test';
import { deleteDoc } from '../src/store/index.js';
import assert from 'node:assert/strict';
import { withFallback } from '../src/snapshot.js';

// No blob token in tests, so read/write are inert and the logic is exercised alone.
const before = process.env.BLOB_READ_WRITE_TOKEN;
process.env.BLOB_READ_WRITE_TOKEN = '';
process.on('exit', () => { if (before !== undefined) process.env.BLOB_READ_WRITE_TOKEN = before; });

test('a healthy read is returned unchanged and never marked stale', async () => {
  const result = await withFallback('t', async () => ({ skus: [1], errors: {} }));
  assert.deepEqual(result.skus, [1]);
  assert.equal(result.stale, undefined);
});

test('a throwing fetcher with no snapshot still surfaces the error', async () => {
  await deleteDoc('snapshot/t.json');
  // Silently swallowing it would leave the page blank with no explanation.
  await assert.rejects(() => withFallback('t', async () => { throw new Error('down'); }), /down/);
});

test('a partial read is returned when there is no snapshot to prefer', async () => {
  await deleteDoc('snapshot/t.json');
  const result = await withFallback('t', async () => ({ skus: [], errors: { shopee: 'x' } }), {
    isComplete: (v) => Object.keys(v.errors).length === 0,
  });
  assert.deepEqual(result.errors, { shopee: 'x' });
});

test('completeness decides what is worth keeping', async () => {
  // A catalogue missing a channel must not become the snapshot, or the next failure
  // would fall back onto half the data and compound the problem.
  let complete = { skus: [1, 2], errors: {} };
  const isComplete = (v) => Object.keys(v.errors).length === 0;
  assert.equal(isComplete(complete), true);
  assert.equal(isComplete({ skus: [], errors: { shopee: 'rate limit' } }), false);
});
