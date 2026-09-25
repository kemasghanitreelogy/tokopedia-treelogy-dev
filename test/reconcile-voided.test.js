import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * An invoice deleted on purpose is supposed to be absent.
 *
 * Reconcile's rule is "Jurnal wins": an entry naming an invoice Jurnal does not hold is
 * forgotten, so the sweep writes the sale again. That is right for an invoice that went
 * missing and wrong for one we voided ourselves when the buyer cancelled - there the
 * absence is the point, and the entry is the only record that the decision was made.
 *
 * Five of those were erased on 25 September, after the duplicate cleanup. Nothing was
 * re-posted, because a cancelled order fails the stage test as well; the guard that was
 * lost is the one that would hold if a platform ever un-cancelled an order.
 */

const { reconcileLedger } = await import('../src/mekari/reconcile.js');

test('a voided entry survives a reconcile, an ordinary missing one does not', async () => {
  const order = (channel, id, stage) => ({ channel, id, stage, total: 100, lines: [] });

  const result = await reconcileLedger({
    from: '2026-08-01',
    dryRun: true,
    readOrders: async () => [
      order('tokopedia', '586239872792692099', 'cancelled'),
      order('shopee', '260101LIVE', 'completed'),
      order('shopee', '260102GONE', 'completed'),
    ],
    readInvoices: async () => new Map([['TRL-shopee-260101LIVE', { id: 501, total: 100 }]]),
    readLedger: async () => ({
      version: 1,
      orders: {
        'TRL-tokopedia-586239872792692099': { invoice_id: 1983791038, voided: true, voided_at: '2026-09-20T00:00:00Z' },
        'TRL-shopee-260101LIVE': { invoice_id: 999 },
        'TRL-shopee-260102GONE': { invoice_id: 777 },
      },
    }),
  });

  assert.deepEqual(result.kept.map((k) => k.customId), ['TRL-tokopedia-586239872792692099']);
  assert.equal(result.kept[0].why, 'voided');
  assert.deepEqual(result.forgotten.map((f) => f.customId), ['TRL-shopee-260102GONE'], 'yang benar-benar hilang tetap dilupakan');
  assert.deepEqual(result.corrected.map((c) => c.customId), ['TRL-shopee-260101LIVE']);
});

test('an entry held for review is kept too - it names a problem somebody owes an answer for', async () => {
  const result = await reconcileLedger({
    from: '2026-08-01',
    dryRun: true,
    readOrders: async () => [{ channel: 'shopee', id: '260103REVIEW', stage: 'cancelled', total: 100, lines: [] }],
    readInvoices: async () => new Map(),
    readLedger: async () => ({
      version: 1,
      orders: { 'TRL-shopee-260103REVIEW': { invoice_id: 888, needs_review: 'faktur sudah menerima pembayaran' } },
    }),
  });

  assert.equal(result.forgotten.length, 0);
  assert.equal(result.kept[0].why, 'needs_review');
});

test('nothing is written when the reconcile only looks', async () => {
  let wrote = false;
  await reconcileLedger({
    from: '2026-08-01',
    dryRun: true,
    readOrders: async () => [{ channel: 'shopee', id: '260104X', stage: 'completed', total: 100, lines: [] }],
    readInvoices: async () => new Map(),
    readLedger: async () => ({ version: 1, orders: { 'TRL-shopee-260104X': { invoice_id: 1 } } }),
    forget: async () => { wrote = true; },
    save: async () => { wrote = true; },
  });
  assert.equal(wrote, false);
});
