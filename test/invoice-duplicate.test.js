import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * One order, one invoice.
 *
 * Shopee sent two pushes for 260924UVXBBSDM a second apart. Both read the ledger before
 * either had written to it, both posted, and Jurnal made invoices 13728 and 13729 - same
 * customer, same Rp395.000, same day, and the same custom_id "TRL-shopee-260924UVXBBSDM"
 * on both. The 409 that was supposed to refuse the second one never came.
 */

const order = (id = '260924UVXBBSDM') => ({
  channel: 'shopee', id, createdAt: 1790261940, stage: 'completed', status: 'COMPLETED',
  buyer: 'nanikyusie', customer: 'nanikyusie', total: 395000, currency: 'IDR',
  lines: [{ sku: 'OMC-90-001', name: 'Moringa Capsules', variant: '90 caps', qty: 1 }],
  finance: { lines: [{ sku: 'OMC-90-001', name: 'Moringa Capsules', variant: '90 caps', qty: 1, unitPrice: 395000, unitDiscount: 0 }], shipping: 0 },
});

test('two pushes a second apart post one invoice between them', async () => {
  const { postOrder, resetPostGuard } = await import('../src/mekari/sync.js');
  resetPostGuard();

  // A dry run reaches the same guard without touching Jurnal, and is enough to prove the
  // two callers share one attempt rather than making two.
  const [a, b] = await Promise.all([
    postOrder(order(), { dryRun: true }),
    postOrder(order(), { dryRun: true }),
  ]);
  assert.equal(a, b, 'panggilan kedua ikut yang pertama, bukan bikin sendiri');
  assert.equal(a.status, 'dry-run');
  assert.equal(a.customId, 'TRL-shopee-260924UVXBBSDM');
});

test('two different orders are never made to wait for each other', async () => {
  const { postOrder, resetPostGuard } = await import('../src/mekari/sync.js');
  resetPostGuard();
  const [a, b] = await Promise.all([
    postOrder(order('AAA'), { dryRun: true }),
    postOrder(order('BBB'), { dryRun: true }),
  ]);
  assert.notEqual(a, b);
  assert.equal(a.customId, 'TRL-shopee-AAA');
  assert.equal(b.customId, 'TRL-shopee-BBB');
});

test('the guard is released, so the next push for the same order is a fresh attempt', async () => {
  const { postOrder, resetPostGuard } = await import('../src/mekari/sync.js');
  resetPostGuard();
  const first = await postOrder(order(), { dryRun: true });
  const second = await postOrder(order(), { dryRun: true });
  // Not the same object: the sweep must be able to retry an order later in the day.
  assert.notEqual(first, second);
  assert.deepEqual(first.customId, second.customId);
});

test('the custom_id carries no character that breaks the lookup', async () => {
  const { customIdFor } = await import('../src/mekari/invoice.js');
  // The '#' once broke both halves of the protection at once: Jurnal routed the lookup to
  // nothing and the uniqueness constraint did not fire either.
  assert.equal(customIdFor({ channel: 'shopify', id: '#10892' }), 'TRL-shopify-10892');
  assert.equal(customIdFor({ channel: 'shopee', id: '260924UVXBBSDM' }), 'TRL-shopee-260924UVXBBSDM');
  for (const channel of ['shopee', 'shopify', 'tokopedia', 'tiktok_shop', 'manual']) {
    assert.ok(!customIdFor({ channel, id: '#1/2' }).includes('#'));
  }
});
