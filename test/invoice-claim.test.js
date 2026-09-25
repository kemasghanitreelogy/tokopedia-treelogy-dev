import test from 'node:test';
import assert from 'node:assert/strict';
import { claimInvoice, releaseInvoice, heldClaims, CLAIM_TTL_MS, CLAIMS_DOC } from '../src/mekari/claim.js';
import { deleteDoc, resetStore, closeStore } from '../src/store/index.js';

/**
 * The guard that the in-process map cannot be.
 *
 * The web service answers webhooks and a systemd timer runs the sweep as its own process.
 * Two processes, one order, and Jurnal's repeated-custom_id check turned out not to be
 * atomic - invoices 13728 and 13729 both carry "TRL-shopee-260924UVXBBSDM". So the claim
 * lives in the store, where `updateDoc` is a compare-and-set.
 */

test.after(async () => { await closeStore(); });

const clean = () => deleteDoc(CLAIMS_DOC);

test('many callers arriving together, exactly one of them posts', async () => {
  await clean();
  const outcomes = await Promise.all(
    Array.from({ length: 8 }, (_, i) => claimInvoice('TRL-shopee-RACE', { owner: `p${i}` })),
  );
  assert.equal(outcomes.filter((o) => o.claimed).length, 1, 'satu pemenang, bukan delapan');
  for (const lost of outcomes.filter((o) => !o.claimed)) {
    assert.equal(lost.enforced, true);
    assert.ok(lost.owner, 'yang kalah tahu siapa yang pegang');
  }
});

test('two different orders never block each other', async () => {
  await clean();
  const a = await claimInvoice('TRL-shopee-AAA');
  const b = await claimInvoice('TRL-tiktok-BBB');
  assert.equal(a.claimed, true);
  assert.equal(b.claimed, true);
  assert.equal((await heldClaims()).length, 2);
});

test('releasing hands the order to the next process', async () => {
  await clean();
  const mine = await claimInvoice('TRL-shopee-HANDOVER', { owner: 'sweep' });
  assert.equal(mine.claimed, true);
  assert.equal((await claimInvoice('TRL-shopee-HANDOVER', { owner: 'webhook' })).claimed, false);

  await releaseInvoice('TRL-shopee-HANDOVER', { owner: 'sweep' });
  assert.equal((await claimInvoice('TRL-shopee-HANDOVER', { owner: 'webhook' })).claimed, true);
});

test('a release only ever gives back its own claim', async () => {
  await clean();
  await claimInvoice('TRL-shopee-MINE', { owner: 'sweep' });
  // A late release from a process whose claim already expired and was taken by another
  // must not unlock the order out from under its current holder.
  await releaseInvoice('TRL-shopee-MINE', { owner: 'somebody-else' });
  assert.equal((await claimInvoice('TRL-shopee-MINE', { owner: 'webhook' })).claimed, false);
});

test('a claim expires, so a process that died holding one does not lock the books', async () => {
  await clean();
  const now = Date.now();
  await claimInvoice('TRL-shopee-CRASHED', { owner: 'dead', now });

  assert.equal((await claimInvoice('TRL-shopee-CRASHED', { now: now + CLAIM_TTL_MS - 1000 })).claimed, false);
  assert.equal((await claimInvoice('TRL-shopee-CRASHED', { now: now + CLAIM_TTL_MS + 1000 })).claimed, true);
});

test('expired claims are swept, so the document cannot grow forever', async () => {
  await clean();
  const now = Date.now();
  await claimInvoice('TRL-shopee-OLD-1', { now });
  await claimInvoice('TRL-shopee-OLD-2', { now });
  await claimInvoice('TRL-shopee-NEW', { now: now + CLAIM_TTL_MS * 2 });
  assert.deepEqual(
    (await heldClaims({ now: now + CLAIM_TTL_MS * 2 })).map((c) => c.customId),
    ['TRL-shopee-NEW'],
  );
});

test('an unreachable store does not stop the books being written', async () => {
  const before = process.env.STATE_DB_PATH;
  process.env.STATE_DB_PATH = '/dev/null/tidak-ada/treelogy.sqlite';
  resetStore();
  try {
    const outcome = await claimInvoice('TRL-shopee-NOSTORE');
    assert.equal(outcome.claimed, true, 'tetap boleh posting');
    assert.equal(outcome.enforced, false, 'tapi jujur bahwa guard-nya tidak aktif');
  } finally {
    if (before === undefined) delete process.env.STATE_DB_PATH; else process.env.STATE_DB_PATH = before;
    resetStore();
  }
});
