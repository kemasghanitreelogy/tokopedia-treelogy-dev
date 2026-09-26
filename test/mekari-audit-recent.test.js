import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRecent, MAX_PROBES, SETTLE_MS } from '../src/mekari/audit.js';

/**
 * The narrow question, asked cheaply.
 *
 * The nightly check used to walk Jurnal's whole invoice list - around fifty requests out
 * of a monthly package - and re-report the same 979 August orders that a half-finished
 * backfill never posted. None of them was ever going to be fixed by a message at 02:30,
 * and they buried the thing worth watching: September ran 1,148 postable orders and
 * 1,148 invoices. So this asks only about new data, and asks the ledger first.
 */

const HOUR = 3600;
const now = Date.parse('2026-09-26T04:00:00Z');
const seconds = (ms) => Math.floor(ms / 1000);

const order = (id, over = {}) => ({
  channel: 'shopee', id, stage: 'completed', total: 100000,
  createdAt: seconds(now) - 4 * HOUR,
  finance: { lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 100000, unitDiscount: 0 }], shipping: 0 },
  ...over,
});

const run = (orders, ledgerKeys = [], { probe, ...rest } = {}) => auditRecent({
  now,
  readOrders: async () => orders,
  readLedger: async () => ({ orders: Object.fromEntries(ledgerKeys.map((k) => [k, { invoice_id: 1 }])) }),
  probe: probe ?? (async () => null),
  ...rest,
});

test('an order the ledger already knows costs Jurnal nothing', async () => {
  const asked = [];
  const r = await run([order('A'), order('B')], ['TRL-shopee-A', 'TRL-shopee-B'], {
    probe: async (o) => { asked.push(o.id); return null; },
  });

  assert.equal(r.checked, 2);
  assert.equal(r.ledgered, 2);
  assert.equal(r.probed, 0, 'hari biasa: nol permintaan ke Jurnal');
  assert.deepEqual(asked, []);
  assert.deepEqual(r.missingOrders, []);
});

test('the ledger is a cache of the books, so Jurnal gets the last word', async () => {
  // An entry can be missing while the invoice exists - a lost write, a reconcile that
  // forgot. Nobody is told a sale went unrecorded on the strength of a local file.
  const r = await run([order('A')], [], { probe: async () => ({ id: 77, transaction_no: 'SI-77' }) });
  assert.equal(r.probed, 1);
  assert.deepEqual(r.missingOrders, []);
});

test('an order neither the ledger nor Jurnal has is the one worth reporting', async () => {
  const r = await run([order('GONE', {
    // `total` is what the buyer paid, after platform coins and vouchers. The report has
    // to name what the invoice would be worth instead - goods at selling price plus any
    // shipping the invoice carries - or the figure in the message and the figure in
    // Jurnal disagree. On a marketplace order that shipping is 0 and the two coincide;
    // this one is shaped so they cannot.
    total: 250000,
    finance: { lines: [{ sku: 'OMC-90-001', qty: 2, unitPrice: 100000, unitDiscount: 0 }], shipping: 30000 },
  })], []);

  assert.deepEqual(r.missingOrders.map((o) => o.id), ['GONE']);
  assert.equal(r.missingValue, 230000, 'nilai faktur, bukan yang dibayar pembeli');
  assert.equal(r.missingOrders[0].channel, 'shopee');
  assert.equal(r.missingOrders[0].stage, 'completed');
});

test('a sale still in flight has not failed to reach the books', async () => {
  // The sweep runs every fifteen minutes. Reporting an order placed two minutes ago would
  // make the alert mean "something recent exists" rather than "the sweep had its chance".
  const r = await run([
    order('JUSTIN', { createdAt: seconds(now - SETTLE_MS + 60_000) }),
    order('SETTLED', { createdAt: seconds(now - SETTLE_MS - 60_000) }),
  ], []);
  assert.deepEqual(r.missingOrders.map((o) => o.id), ['SETTLED']);
  assert.equal(r.checked, 1, 'yang masih terbang tidak ikut dihitung');
});

test('what was never a sale is not a missing invoice', async () => {
  const r = await run([
    order('UNPAID', { stage: 'to_pay' }),
    order('VOID', { stage: 'cancelled' }),
    order('REAL'),
  ], ['TRL-shopee-REAL']);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.missingOrders, []);
});

test('an order with no priced lines is separated, not accused', async () => {
  const r = await run([order('EMPTY', { finance: { lines: [], shipping: 0 } })], []);
  assert.deepEqual(r.missingOrders, []);
  assert.deepEqual(r.uninvoiceable.map((o) => o.id), ['EMPTY']);
  assert.match(r.uninvoiceable[0].reason, /tanpa baris keuangan/);
});

test('a bad day cannot become the thing that spends the month', async () => {
  // A database outage or a mangled window could put hundreds of orders outside the
  // ledger at once; the audit must not then make hundreds of requests.
  const many = Array.from({ length: MAX_PROBES + 25 }, (_, i) => order(`M${i}`));
  let asked = 0;
  const r = await run(many, [], { probe: async () => { asked += 1; return null; } });

  assert.equal(asked, MAX_PROBES);
  assert.equal(r.probed, MAX_PROBES);
  assert.equal(r.capped, true, 'dan mengatakannya, bukan diam-diam memotong');
});

test('a probe that throws is not read as a missing invoice', async () => {
  // Jurnal being unreachable means we do not know, and "we do not know" must never be
  // reported as "this sale is not in the books".
  const r = await run([order('X')], [], { probe: async () => { throw new Error('tidak terjangkau'); } });
  assert.deepEqual(r.missingOrders.map((o) => o.id), ['X']);
  // ...which is the one case this deliberately gets wrong, so it is written down: a
  // failed probe reports the order. The alternative - silence - hides a real gap, and
  // the dedupe on the Telegram side means an outage says it once, not every night.
});
