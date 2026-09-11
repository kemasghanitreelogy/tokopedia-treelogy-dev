import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, DEFAULT_GUARDS } from '../src/stock-sync.js';
import { seedLedger, emptyLedger, masterQty, setSku } from '../src/ledger.js';

const channel = (qty, extra = {}) => ({ qty, rows: [{ qty, ...extra }], ignored: [], conflict: false });
const catalogOf = (...entries) => ({ skus: entries, errors: {}, readAt: Date.now() });
const ledgerOf = (skus) => ({ ...emptyLedger(), skus });

test('a SKU absent from the ledger is never written', () => {
  const plan = planSync({
    ledger: ledgerOf({}),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(10), shopee: channel(5) }),
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.unmanaged.length, 1);
});

test('a SKU not listed on a channel is never created there', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 10 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(8), shopee: null }),
  });
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].channel, 'tiktok');
});

test('writing zero is held for review, never applied automatically', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 0 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(20), shopee: null }),
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.review.length, 1);
  assert.match(plan.review[0].reason, /0/);
});

test('a change larger than the threshold is held for review', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 200 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(100), shopee: null }),
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.review.length, 1);
});

test('small absolute moves on low stock are not treated as huge ratios', () => {
  // 2 -> 4 doubles, but on a floor of 10 it is a 2-unit move and should pass.
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 4 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(2), shopee: null }),
  });
  assert.equal(plan.changes.length, 1);
});

test('negative stock is blocked outright', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: -1 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(5), shopee: null }),
  });
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.changes.length, 0);
});

test('a SKU already matching the ledger produces no write', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 10 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(10), shopee: channel(10) }),
  });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.unchanged.length, 2);
});

test('one SKU on several live listings gets a write for each', () => {
  const entry = {
    sku: 'A', title: 'A',
    tiktok: { qty: 5, rows: [{ qty: 5, skuId: 'x' }, { qty: 5, skuId: 'y' }], ignored: [], conflict: false },
    shopee: null,
  };
  const plan = planSync({ ledger: ledgerOf({ A: { qty: 7 } }), catalog: catalogOf(entry) });
  assert.equal(plan.changes.length, 2);
  assert.deepEqual(plan.changes.map((c) => c.ref.skuId).sort(), ['x', 'y']);
});

test('ledger rows with no listing anywhere are reported as missing', () => {
  const plan = planSync({
    ledger: ledgerOf({ A: { qty: 1 }, GONE: { qty: 3 } }),
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(1), shopee: null }),
  });
  assert.deepEqual(plan.missing, ['GONE']);
});

test('seeding takes the lower value when channels disagree, and flags it', () => {
  const { ledger, conflicts } = seedLedger(
    catalogOf({ sku: 'A', title: 'A', tiktok: channel(117), shopee: channel(99) }),
  );
  assert.equal(ledger.skus.A.qty, 99);
  assert.equal(ledger.skus.A.needs_review, true);
  assert.deepEqual(conflicts[0], { sku: 'A', tiktok: 117, shopee: 99, chosen: 99 });
});

test('seeding never overwrites a row a human already set', () => {
  const existing = ledgerOf({ A: { qty: 42, source: 'manual' } });
  const { ledger, seeded } = seedLedger(catalogOf({ sku: 'A', title: 'A', tiktok: channel(5), shopee: null }), existing);
  assert.equal(ledger.skus.A.qty, 42);
  assert.deepEqual(seeded, []);
});

test('an alias follows its master quantity', () => {
  const ledger = ledgerOf({ MASTER: { qty: 30 }, ALIAS: { alias_of: 'MASTER' } });
  assert.equal(masterQty(ledger, 'ALIAS'), 30);
});

test('a circular alias resolves to null instead of looping forever', () => {
  const ledger = ledgerOf({ A: { alias_of: 'B' }, B: { alias_of: 'A' } });
  assert.equal(masterQty(ledger, 'A'), null);
});

test('an alias pointing nowhere yields null, so nothing is written', () => {
  const ledger = ledgerOf({ A: { alias_of: 'MISSING' } });
  assert.equal(masterQty(ledger, 'A'), null);
  const plan = planSync({ ledger, catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(9), shopee: null }) });
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.unmanaged.length, 1);
});

test('setSku records a timestamp with the change', () => {
  const updated = setSku(ledgerOf({ A: { qty: 1 } }), 'A', { qty: 9 });
  assert.equal(updated.skus.A.qty, 9);
  assert.ok(updated.skus.A.updated_at);
});

test('guard defaults are conservative', () => {
  assert.equal(DEFAULT_GUARDS.allowZero, false);
  assert.ok(DEFAULT_GUARDS.maxChangeRatio <= 1);
});

test('a price edit rejects anything that is not a positive integer', async () => {
  const { applyPrice } = await import('../src/stock-sync.js');
  const catalog = catalogOf({ sku: 'A', title: 'A', tiktok: channel(5), shopee: null });
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => applyPrice({ catalog, sku: 'A', price: bad }), /bilangan bulat positif/);
  }
});

test('a price edit for an unknown SKU is refused before any write', async () => {
  const { applyPrice } = await import('../src/stock-sync.js');
  await assert.rejects(
    () => applyPrice({ catalog: catalogOf(), sku: 'NOPE', price: 1000 }),
    /tidak ada di katalog/,
  );
});

test('read-only mode refuses every live write before a request is built', async () => {
  const before = process.env.TREELOGY_READONLY;
  process.env.TREELOGY_READONLY = '1';
  try {
    const { applyPrice, applySync, isReadOnly } = await import('../src/stock-sync.js');
    assert.equal(isReadOnly(), true);
    await assert.rejects(
      () => applyPrice({ catalog: catalogOf(), sku: 'A', price: 1000 }),
      (e) => e.name === 'ReadOnlyError',
    );
    await assert.rejects(
      () => applySync({ changes: [{ sku: 'A', channel: 'tiktok', from: 1, to: 2, ref: {} }], guards: {} }, { dryRun: false }),
      (e) => e.name === 'ReadOnlyError',
    );
  } finally {
    if (before === undefined) delete process.env.TREELOGY_READONLY;
    else process.env.TREELOGY_READONLY = before;
  }
});

test('a dry run is still allowed while read-only', async () => {
  const before = process.env.TREELOGY_READONLY;
  process.env.TREELOGY_READONLY = '1';
  try {
    const { applySync } = await import('../src/stock-sync.js');
    const result = await applySync({ changes: [{ sku: 'A', channel: 'tiktok', from: 1, to: 2, ref: {} }], guards: {} });
    assert.equal(result.dryRun, true);
    assert.equal(result.attempted, 0);
  } finally {
    if (before === undefined) delete process.env.TREELOGY_READONLY;
    else process.env.TREELOGY_READONLY = before;
  }
});

test('a seeded ledger row may lower stock but never raise it unattended', async () => {
  // A seed is a photograph of yesterday: sales since then are invisible to it, so
  // pushing it back up would put goods on sale that are already gone.
  const seeded = { ...emptyLedger(), skus: { A: { qty: 100, source: 'seed' } } };

  const raise = planSync({
    ledger: seeded,
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(90), shopee: null }),
  });
  assert.equal(raise.changes.length, 0, 'an increase from a seed must not auto-apply');
  assert.equal(raise.review.length, 1);
  assert.match(raise.review[0].reason, /menaikkan stok/);

  const lower = planSync({
    ledger: seeded,
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(110), shopee: null }),
  });
  assert.equal(lower.changes.length, 1, 'a decrease can only under-sell, so it is safe');
});

test('an increase a human vouched for is allowed through', async () => {
  const manual = { ...emptyLedger(), skus: { A: { qty: 100, source: 'manual:1.2.3.4' } } };
  const plan = planSync({
    ledger: manual,
    catalog: catalogOf({ sku: 'A', title: 'A', tiktok: channel(90), shopee: null }),
  });
  assert.equal(plan.changes.length, 1);
});
