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

test('a second process cannot post an order this one is already posting', async () => {
  const { postOrder, resetPostGuard } = await import('../src/mekari/sync.js');
  const { claimInvoice, releaseInvoice } = await import('../src/mekari/claim.js');
  const { closeStore } = await import('../src/store/index.js');
  resetPostGuard();

  // Stand in for the sweep, running as its own process, holding the claim right now.
  const held = await claimInvoice('TRL-shopee-260924UVXBBSDM', { owner: 'sweep' });
  assert.equal(held.claimed, true);

  // Nothing may leave this machine. A test that reached Jurnal would be asserting about
  // production's books, and the point here is precisely that no request is made to create.
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetched.push(`${init?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };

  let outcome;
  try {
    outcome = await postOrder(order(), { dryRun: false });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(!fetched.some((call) => call.startsWith('POST')), `tidak ada create: ${fetched.join(', ')}`);
  assert.equal(outcome.status, 'deferred', 'ditunda, bukan bikin faktur kedua');
  assert.equal(outcome.busy, true);
  assert.equal(outcome.customId, 'TRL-shopee-260924UVXBBSDM');

  await releaseInvoice('TRL-shopee-260924UVXBBSDM', { owner: 'sweep' });
  await closeStore();
});

test('a create that gets no answer is never sent twice', async () => {
  const { postOrder, resetPostGuard } = await import('../src/mekari/sync.js');
  const { closeStore, deleteDoc } = await import('../src/store/index.js');
  const { CLAIMS_DOC } = await import('../src/mekari/claim.js');
  resetPostGuard();
  await deleteDoc(CLAIMS_DOC);

  /*
   * The second way a duplicate is made, and the one nobody was looking for.
   *
   * The create used to opt back into the client's retry, on the belief that a repeated
   * custom_id would be refused with 409. It is not - 13728 and 13729 prove that - so a
   * timeout after Jurnal had already stored the invoice would have retried straight into
   * a second copy. Now it asks instead.
   */
  let creates = 0;
  let stored = false;
  const realFetch = globalThis.fetch;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = String(url);
    if (method === 'POST' && path.includes('/contacts')) return json({ message: 'sudah ada' }, 409);
    if (method === 'POST' && path.endsWith('/sales_invoices')) {
      creates += 1;
      // Jurnal took it; the answer is what went missing.
      stored = true;
      throw new Error('socket hang up');
    }
    if (method === 'GET' && path.includes('/sales_invoices/TRL-')) {
      return stored
        ? json({ sales_invoice: { id: 99123, transaction_no: 'SI-99123', original_amount: 395000 } })
        : json({ message: 'not found' }, 404);
    }
    return json({});
  };

  let outcome;
  try {
    outcome = await postOrder(order('NOANSWER'), { dryRun: false });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(creates, 1, 'satu kali kirim, apa pun yang terjadi');
  assert.equal(outcome.status, 'exists');
  assert.equal(outcome.invoiceId, 99123);
  await closeStore();
});
