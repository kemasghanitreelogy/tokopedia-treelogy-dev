import test from 'node:test';
import assert from 'node:assert/strict';
import { openWarehouse, applyOrders as readOrders, manualMove, verifyWarehouse, emptyWarehouse, OPENING_AT, OPENING_ITEMS, itemsForOrder } from '../src/warehouse.js';
// Taking an order off the shelf is a picklist confirmation (`admit`); these cases are about
// what happens once it is taken.
const applyOrders = (doc, orders, options = {}) => readOrders(doc, orders, { admit: true, ...options });
import { syncWarehouse, recordMove } from '../src/warehouse-run.js';
import { applyOrders as followOrders } from '../src/stock-follow.js';

/**
 * The warehouse must never drift from the truth by a single unit. These tests attack it
 * the way production does: pushes repeated and out of order, orders edited, cancelled
 * and re-sent, reads that come back empty, a button pressed twice, and many writers at
 * once against a store that makes them collide.
 */

// A small seeded generator, so a failure is reproducible from its seed.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}
const SKUS = ['OMC-90-001', 'OMC-180-001', 'OMC-270-001', 'OMO-30-001', 'MRS-002', 'Discovery-Pack', 'Inside-Out-Protocol', 'Bamboo-Scoop', 'OMP-45-001', 'MRS-001'];
const CODES = OPENING_ITEMS.map((i) => i[0]);
const opened = () => openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });

function scenario(seed, steps = 400) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const orders = Array.from({ length: 25 }, (_, i) => ({ id: `O${i}`, channel: pick(['shopee', 'tiktok', 'manual']), createdAt: OPENING_AT + 100 + i, lines: [[pick(SKUS), 1 + Math.floor(r() * 3)]] }));
  const events = [];
  const tokens = [];
  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.62) {
      const o = pick(orders);
      if (r() < 0.12) o.lines = [[pick(SKUS), 1 + Math.floor(r() * 3)]]; // the order is edited
      const stage = pick(['unpaid', 'to_ship', 'shipping', 'shipping', 'delivered', 'completed', 'cancelled', 'returned']);
      const empty = r() < 0.05; // a read that came back with no lines
      events.push({ t: 'order', order: { ...o, stage, lines: empty ? [] : o.lines.map(([sku, qty]) => ({ sku, qty })) } });
      if (r() < 0.25) events.push(events[events.length - 1]); // the same push again
    } else {
      const token = r() < 0.2 && tokens.length ? pick(tokens) : `tok-${seed}-${i}-xxxxxxxxxx`; // a double press reuses a token
      tokens.push(token);
      events.push({ t: 'move', input: { code: pick(CODES), kind: pick(['in', 'out', 'count']), qty: Math.floor(r() * 40) + (r() < 0.5 ? 1 : 0), by: 'qa', token } });
    }
  }
  return events;
}

function run(events, doc = opened()) {
  let t = OPENING_AT + 1000;
  for (const e of events) {
    t += 1;
    if (e.t === 'order') doc = applyOrders(doc, [e.order], { now: t * 1000 }).doc;
    else {
      try { doc = manualMove(doc, e.input, { now: t * 1000 }).doc; } catch { /* a rejected input changes nothing */ }
    }
  }
  return doc;
}

test('fuzz: quantity always equals folded + the sum of its movements, to the unit', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const doc = run(scenario(seed));
    assert.deepEqual(verifyWarehouse(doc), [], `seed ${seed}`);
  }
});

test('fuzz: every order nets to exactly what its last effective state says', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const events = scenario(seed);
    const doc = run(events);
    for (const [key, row] of Object.entries(doc.orders)) {
      const net = {};
      for (const m of doc.moves) if (m.ref === key) net[m.code] = (net[m.code] ?? 0) + m.delta;
      const expected = row.undone ? {} : Object.fromEntries(Object.entries(row.items).map(([c, q]) => [c, -q]));
      for (const code of new Set([...Object.keys(net), ...Object.keys(expected)])) {
        assert.equal(net[code] ?? 0, expected[code] ?? 0, `seed ${seed} ${key} ${code}`);
      }
    }
  }
});

test('fuzz: every push applied twice ends exactly where once does', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const events = scenario(seed).filter((e) => e.t === 'order');
    const once = run(events);
    const twice = run(events.flatMap((e) => [e, e]));
    for (const code of CODES) assert.equal(twice.items[code].qty, once.items[code].qty, `seed ${seed} ${code}`);
  }
});

test('different orders commute: the order they are read in changes nothing', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed * 7);
    const events = scenario(seed).filter((e) => e.t === 'order');
    // Keep each order's own sequence, interleave orders differently.
    const byOrder = new Map();
    for (const e of events) byOrder.set(e.order.id, [...(byOrder.get(e.order.id) ?? []), e]);
    const queues = [...byOrder.values()].map((q) => [...q]);
    const shuffled = [];
    while (queues.some((q) => q.length)) {
      const live = queues.filter((q) => q.length);
      shuffled.push(live[Math.floor(r() * live.length)].shift());
    }
    const a = run(events); const b = run(shuffled);
    for (const code of CODES) assert.equal(b.items[code].qty, a.items[code].qty, `seed ${seed} ${code}`);
  }
});

test('a log longer than it keeps is folded, never summarised away', () => {
  let doc = opened();
  for (let i = 0; i < 5400; i++) doc = manualMove(doc, { code: 'M-036', kind: i % 2 ? 'out' : 'in', qty: 1 + (i % 3), by: 'qa', token: `fold-${i}-xxxxxxxxxxxx` }, { now: (OPENING_AT + 100 + i) * 1000 }).doc;
  assert.ok(doc.moves.length <= 5000);
  assert.ok(doc.folded['M-036'] !== undefined, 'saldo terlipat tercatat');
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('an empty read never puts an order back on the shelf', () => {
  let { doc } = applyOrders(opened(), [{ id: 'A', channel: 'shopee', stage: 'shipping', createdAt: OPENING_AT + 5, lines: [{ sku: 'MRS-001', qty: 1 }] }]);
  ({ doc } = applyOrders(doc, [{ id: 'A', channel: 'shopee', stage: 'completed', createdAt: OPENING_AT + 5, lines: [] }]));
  assert.equal(doc.items['M-093'].qty, 217);
});

/* --------------------------------------------- many writers against a colliding store */

/**
 * A compare-and-swap store that makes concurrent writers collide on purpose: each read
 * waits a random moment before committing, and a commit only lands if nobody committed
 * in between - otherwise it retries, as Redis WATCH/MULTI does.
 */
function collidingStore(seed) {
  const r = rng(seed);
  let doc = null; let version = 0; let conflicts = 0;
  return {
    async update(key, fn, initial) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const seenVersion = version;
        const base = structuredClone(doc ?? initial);
        await new Promise((res) => setTimeout(res, Math.floor(r() * 3)));
        const next = fn(base);
        if (version !== seenVersion) { conflicts += 1; continue; }
        doc = structuredClone(next); version += 1;
        return doc;
      }
      throw new Error('too many conflicts');
    },
    get doc() { return doc; },
    get conflicts() { return conflicts; },
  };
}

test('200 writers at once - orders, receipts, double presses - land exactly once each', async () => {
  const store = collidingStore(42);
  const now = (OPENING_AT + 5000) * 1000;
  const jobs = [];
  let expectedIn = 0;
  for (let i = 0; i < 120; i++) {
    const token = `rc-${i}-xxxxxxxxxxxxxx`;
    expectedIn += 2;
    jobs.push(recordMove({ code: 'M-094', kind: 'in', qty: 2, by: 'qa', token }, { now, update: store.update.bind(store) }));
    if (i % 4 === 0) jobs.push(recordMove({ code: 'M-094', kind: 'in', qty: 2, by: 'qa', token }, { now, update: store.update.bind(store) })); // the double press
  }
  const orders = Array.from({ length: 50 }, (_, i) => ({ id: `RC${i}`, channel: 'tiktok', stage: 'shipping', createdAt: OPENING_AT + 10, lines: [{ sku: 'MRS-001', qty: 1 }] }));
  for (const o of orders) { jobs.push(syncWarehouse([o], { now, update: store.update.bind(store), printed: { [`${o.channel}:${o.id}`]: { first: OPENING_AT + 1 } } })); jobs.push(syncWarehouse([o], { now, update: store.update.bind(store), printed: { [`${o.channel}:${o.id}`]: { first: OPENING_AT + 1 } } })); }
  await Promise.all(jobs);
  assert.ok(store.conflicts > 0, 'the store really did make writers collide');
  assert.equal(store.doc.items['M-094'].qty, 198 + expectedIn - 50, 'every receipt once, every order once');
  assert.equal(store.doc.items['M-093'].qty, 218 - 50);
  assert.deepEqual(verifyWarehouse(store.doc), []);
});

/* ------------------------------------------------ the marketplace follower, same rules */

test('the stock follower moves an edited order by the difference, and a re-sent one again', () => {
  const T0 = OPENING_AT;
  const ledger = { skus: { 'OMC-90-001': { qty: 150 }, 'OMC-180-001': { qty: 150 } }, applied: {}, follow_started_at: T0 };
  const o = (stage, lines) => ({ id: 'E', channel: 'manual', stage, createdAt: T0 + 5, lines: lines.map(([sku, qty]) => ({ sku, qty })) });
  let { ledger: l } = followOrders(ledger, [o('to_ship', [['OMC-90-001', 2]])]);
  ({ ledger: l } = followOrders(l, [o('to_ship', [['OMC-90-001', 1], ['OMC-180-001', 1]])]));
  assert.deepEqual([l.skus['OMC-90-001'].qty, l.skus['OMC-180-001'].qty], [149, 149], 'hanya selisihnya');
  ({ ledger: l } = followOrders(l, [o('cancelled', [['OMC-90-001', 1], ['OMC-180-001', 1]])]));
  assert.deepEqual([l.skus['OMC-90-001'].qty, l.skus['OMC-180-001'].qty], [150, 150]);
  ({ ledger: l } = followOrders(l, [o('shipping', [['OMC-90-001', 1], ['OMC-180-001', 1]])]));
  assert.deepEqual([l.skus['OMC-90-001'].qty, l.skus['OMC-180-001'].qty], [149, 149], 'dikirim lagi setelah batal');
  ({ ledger: l } = followOrders(l, [o('shipping', [])]));
  assert.equal(l.skus['OMC-90-001'].qty, 149, 'baca kosong tidak mengembalikan');
});

test('the item list for an order is never guessed for an unknown line', () => {
  assert.deepEqual(itemsForOrder({ lines: [{ sku: 'NOPE', qty: 1 }] }), { items: {}, unknown: ['NOPE'] });
});
