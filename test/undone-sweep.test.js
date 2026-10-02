import test from 'node:test';
import assert from 'node:assert/strict';

import { stillBooked, sweepUndone, UNDONE_WINDOW_DAYS } from '../src/mekari/undone.js';

/**
 * The net under the realtime cancellation.
 *
 * A push that arrives while the cancellation is still a request writes nothing - the buyer
 * can be refused - and nothing necessarily pushes again when it goes final. The sweep was
 * the backstop and only looked seven days back, which is the posting window and not this
 * one: Tokopedia 586104376321148443 was cancelled fifteen days in and sat in the books.
 */

const order = (id, stage, channel = 'tokopedia') => ({ channel, id, stage, status: 'CANCELLED', total: 766800 });
const ledger = (entries) => ({ orders: entries });

test('a cancelled order with a live invoice is the only thing it picks up', () => {
  const orders = [
    order('A', 'cancelled'),
    order('B', 'returned'),
    order('C', 'shipping'),      // not undone at all
    order('D', 'cancelled'),     // never invoiced
    order('E', 'cancelled'),     // already voided
    order('F', 'cancelled'),     // waiting for a person
  ];
  const found = stillBooked(orders, ledger({
    'TRL-tokopedia-A': { invoice_id: 1 },
    'TRL-tokopedia-B': { invoice_id: 2 },
    'TRL-tokopedia-C': { invoice_id: 3 },
    'TRL-tokopedia-E': { invoice_id: 5, voided: true },
    'TRL-tokopedia-F': { invoice_id: 6, needs_review: 'sudah dibayar' },
  }));

  assert.deepEqual(found.map((f) => f.order.id), ['A', 'B']);
});

test('nothing to remove costs nothing at all', async () => {
  let asked = 0;
  const out = await sweepUndone({
    dryRun: false,
    readOrders: async () => [order('C', 'shipping')],
    loadLedger: async () => ledger({ 'TRL-tokopedia-C': { invoice_id: 3 } }),
    saveLedger: async () => {},
    undo: async () => { asked += 1; return {}; },
    charge: async () => { asked += 1; return { allowed: true }; },
    notify: async () => {},
  });
  assert.equal(out.found, 0);
  assert.equal(asked, 0, 'Jurnal tidak disentuh sama sekali');
});

test('it looks far enough back to find the one that slipped', async () => {
  let windowDays = null;
  await sweepUndone({
    dryRun: true,
    readOrders: async ({ since, until }) => { windowDays = Math.round((until - since) / 86400); return []; },
    loadLedger: async () => ledger({}),
  });
  assert.equal(windowDays, UNDONE_WINDOW_DAYS);
  assert.ok(UNDONE_WINDOW_DAYS > 7, 'lebih lebar dari jendela posting yang membiarkannya lolos');
});

test('each removal is charged as essential, so a thin month cannot leave a dead sale booked', async () => {
  const charged = [];
  const saved = [];
  const out = await sweepUndone({
    dryRun: false,
    readOrders: async () => [order('A', 'cancelled')],
    loadLedger: async () => ledger({ 'TRL-tokopedia-A': { invoice_id: 1973920590 } }),
    saveLedger: async (l) => saved.push(structuredClone(l)),
    charge: async (n, opts) => { charged.push([n, opts]); return { allowed: true }; },
    undo: async () => ({ customId: 'TRL-tokopedia-A', outcome: 'voided', invoiceId: 1973920590 }),
    notify: async () => {},
  });

  assert.deepEqual(charged, [[2, { essential: true }]], 'satu baca dan satu hapus, dan tidak tertahan cadangan');
  assert.equal(out.voided, 1);
  assert.equal(saved[0].orders['TRL-tokopedia-A'].voided, true);
  assert.ok(saved[0].orders['TRL-tokopedia-A'].voided_at);
});

test('an exhausted quota stops the run rather than failing every order in it', async () => {
  let tries = 0;
  const out = await sweepUndone({
    dryRun: false,
    readOrders: async () => [order('A', 'cancelled'), order('B', 'cancelled')],
    loadLedger: async () => ledger({ 'TRL-tokopedia-A': { invoice_id: 1 }, 'TRL-tokopedia-B': { invoice_id: 2 } }),
    saveLedger: async () => {},
    charge: async () => ({ allowed: false, reason: 'kuota bulanan Jurnal habis (0 tersisa)' }),
    undo: async () => { tries += 1; return {}; },
    notify: async () => {},
  });
  assert.equal(tries, 0);
  assert.equal(out.failed, 1, 'berhenti setelah yang pertama, bukan mengulang kegagalan yang sama');
});

test('an invoice somebody has paid against is handed to a person, not deleted', async () => {
  const told = [];
  const saved = [];
  const out = await sweepUndone({
    dryRun: false,
    readOrders: async () => [order('A', 'cancelled')],
    loadLedger: async () => ledger({ 'TRL-tokopedia-A': { invoice_id: 7 } }),
    saveLedger: async (l) => saved.push(structuredClone(l)),
    charge: async () => ({ allowed: true }),
    undo: async () => ({ customId: 'TRL-tokopedia-A', outcome: 'needs_review', reason: 'sudah menerima pembayaran Rp766.800' }),
    notify: async (payload) => told.push(payload),
  });

  assert.equal(out.review, 1);
  assert.equal(out.voided, 0);
  assert.match(saved[0].orders['TRL-tokopedia-A'].needs_review, /sudah menerima pembayaran/);
  assert.equal(told.length, 1, 'bukan hanya satu baris di log yang tidak dibaca siapa-siapa');
  assert.match(told[0].results[0].error, /pembayaran/);
});

test('a cancellation that is not final yet is left alone, and leaves no mark', async () => {
  const saved = [];
  const out = await sweepUndone({
    dryRun: false,
    readOrders: async () => [order('A', 'cancelled')],
    loadLedger: async () => ledger({ 'TRL-tokopedia-A': { invoice_id: 7 } }),
    saveLedger: async (l) => saved.push(l),
    charge: async () => ({ allowed: true }),
    undo: async () => ({ customId: 'TRL-tokopedia-A', outcome: 'pending', reason: 'IN_CANCEL' }),
    notify: async () => {},
  });
  assert.equal(out.pending, 1);
  // Nothing written: a mark would latch it out of every later run, which is the bug the
  // realtime path was careful about and this must not reintroduce.
  assert.equal(saved.length, 0);
});
