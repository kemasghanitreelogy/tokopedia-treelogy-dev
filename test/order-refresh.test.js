import test from 'node:test';
import assert from 'node:assert/strict';

import { diffOrder, refreshOneOrder, RESHIPS } from '../src/orders-refresh.js';
import { renderDashboard } from '../src/dashboard-page.js';
import { summarize } from '../src/omni.js';
import { afterWrite } from '../api/dashboard.js';

/**
 * Reading one order again, because somebody in the Shopify admin changed it.
 *
 * The sweep and the webhooks keep the table in line on their own. What they cannot
 * anticipate is this shop's own staff editing an order after it was placed, which is why
 * the button exists and why the answer it gives is "here is what changed".
 */

const stored = {
  channel: 'shopify', id: '#11107', gid: 'gid://shopify/Order/123',
  status: 'PAID/UNFULFILLED', stage: 'to_ship', total: 1145000,
  buyer: 'Fika Safei', buyerPhone: '087893179888', shipTo: 'Jalan Opi Raya, Palembang',
  carrier: '', tracking: '', note: '',
  lines: [{ sku: 'OMC-270-001', qty: 1 }, { sku: 'GFT-MYST-001', qty: 1 }],
};

test('the diff speaks in the words on the screen, and stays quiet about the rest', () => {
  const after = { ...stored, total: 1335000, lines: [{ sku: 'OMC-270-001', qty: 1 }, { sku: 'OMP-45-001', qty: 1 }] };
  const changes = diffOrder(stored, after);

  assert.deepEqual(changes.map((c) => c.field), ['total', 'produk']);
  assert.equal(changes[0].to, '1335000');
  assert.match(changes[1].from, /GFT-MYST-001/);
  assert.match(changes[1].to, /OMP-45-001/);

  // A re-read that changed nothing says nothing, rather than inventing a difference out
  // of the moment it was read at.
  assert.deepEqual(diffOrder(stored, { ...stored, fetchedAt: Date.now() }), []);
});

test('the same lines in a different order are the same lines', () => {
  const swapped = { ...stored, lines: [...stored.lines].reverse() };
  assert.deepEqual(diffOrder(stored, swapped), []);
});

test('a Shopify order is read by its id, not by scanning sixty days of history', async () => {
  const asked = [];
  const saved = [];
  const out = await refreshOneOrder({ channel: 'shopify', id: '#11107' }, {
    readStored: async () => [stored],
    readShopify: async (gid) => { asked.push(gid); return { ...stored, status: 'PAID/FULFILLED' }; },
    readAny: async () => { throw new Error('jangan memindai enam puluh hari untuk satu pesanan'); },
    save: async (orders, options) => { saved.push([orders, options]); },
  });

  assert.deepEqual(asked, ['gid://shopify/Order/123']);
  assert.deepEqual(saved[0][0].map((o) => o.id), ['#11107']);
  assert.equal(saved[0][1].source, 'refresh');
  assert.deepEqual(out.changes.map((c) => c.field), ['status platform']);
});

test('a channel with no stored GID falls back to the by-id read', async () => {
  const fresh = { channel: 'shopee', id: '260930ABC', status: 'PROCESSED', lines: [] };
  const out = await refreshOneOrder({ channel: 'shopee', id: '260930ABC' }, {
    readStored: async () => [],
    readShopify: async () => { throw new Error('bukan Shopify'); },
    readAny: async () => ({ orders: [fresh] }),
    save: async () => {},
  });
  assert.equal(out.after.status, 'PROCESSED');
  // Nothing was held before, so there is nothing to have changed - not a list of every
  // field appearing out of nowhere.
  assert.deepEqual(out.changes, []);
});

test('an order the platform will not hand back fails loudly instead of storing nothing', async () => {
  await assert.rejects(
    () => refreshOneOrder({ channel: 'shopify', id: '#404' }, {
      readStored: async () => [],
      readAny: async () => ({ orders: [] }),
      save: async () => { throw new Error('tidak boleh menyimpan apa pun'); },
    }),
    /tidak ditemukan di platform/,
  );
});

test('a typed-in sale has no platform to ask', async () => {
  await assert.rejects(
    () => refreshOneOrder({ channel: 'manual', id: 'CS-260929-001' }, {}),
    /tidak punya platform/,
  );
});

test('changes that make a printed label wrong are the ones worth warning about', () => {
  // A phone number or a status moving does not send anybody back to the printer.
  assert.ok(RESHIPS.has('produk'));
  assert.ok(RESHIPS.has('alamat'));
  assert.ok(!RESHIPS.has('status platform'));
  assert.ok(!RESHIPS.has('telepon'));
});

/* ----------------------------------------------------------------- the button */

const page = (orders, over = {}) => renderDashboard({
  orders,
  summary: summarize(orders),
  errors: {}, shopeeShop: null,
  range: { preset: '7d', from: '2026-09-23', to: '2026-09-30', label: '7 hari', since: 1, until: 2, clamped: false },
  generatedAt: Date.now(), baseQuery: 'view=orders&preset=7d', csrf: 'tok', ...over,
});

const order = (channel, id) => ({
  channel, id, status: 'PAID/UNFULFILLED', stage: 'to_ship', createdAt: 1790000000,
  buyer: 'Fika', total: 1145000, carrier: '', tracking: '', lines: [{ sku: 'OMC-270-001', qty: 1 }],
});

test('only a Shopify order offers the button, because only Shopify is edited by us', () => {
  const html = page([order('shopify', '#11107'), order('shopee', '260930ABC')]);

  assert.match(html, /name="action" value="refresh_order"/);
  assert.match(html, /<input type="hidden" name="order" value="#11107">/);
  assert.match(html, /Ambil data terbaru/);
  // One form, not two: a marketplace announces its own changes.
  assert.equal((html.match(/value="refresh_order"/g) ?? []).length, 1);
  assert.ok(!/name="order" value="260930ABC"/.test(html));
});

test('the button comes back to the filter the operator was standing on', () => {
  const html = page([order('shopify', '#11107')]);
  assert.match(html, /name="back" value="view=orders&amp;preset=7d"/);
});

test('without a token there is no button to press', () => {
  const html = page([order('shopify', '#11107')], { csrf: null });
  assert.ok(!/refresh_order/.test(html));
});

/* --------------------------------------------------------------- the way back */

test('a write lands back on the page it was sent from, with the answer on it', () => {
  const form = new URLSearchParams({ back: 'view=orders&preset=7d&channel=shopify&q=fika' });

  const url = new URL(afterWrite({ view: 'orders', message: '#11107: 1 perubahan (total)' }, form), 'https://x');
  assert.equal(url.searchParams.get('preset'), '7d');
  assert.equal(url.searchParams.get('channel'), 'shopify');
  assert.equal(url.searchParams.get('q'), 'fika');
  assert.equal(url.searchParams.get('done'), '#11107: 1 perubahan (total)');
  // One view parameter, and it is the outcome's: a page reads the first it finds, and a
  // stale one concatenated on the front would be the one it read.
  assert.deepEqual(url.searchParams.getAll('view'), ['orders']);
});

test('the previous answer does not travel with the next one', () => {
  // Otherwise pressing the button twice shows the first result under the second.
  const form = new URLSearchParams({ back: 'view=orders&done=pesan+lama&yay=1' });
  const url = new URL(afterWrite({ view: 'orders', kind: 'error', message: 'gagal' }, form), 'https://x');
  assert.equal(url.searchParams.get('error'), 'gagal');
  assert.equal(url.searchParams.get('done'), null);
  assert.equal(url.searchParams.get('yay'), null);
});

test('a form with nothing to go back to still goes somewhere sensible', () => {
  const url = new URL(afterWrite({ view: 'labels', message: 'ok' }, new URLSearchParams()), 'https://x');
  assert.equal(url.pathname, '/api/dashboard');
  assert.equal(url.searchParams.get('view'), 'labels');
});

test('back cannot send anybody off this host', () => {
  const form = new URLSearchParams({ back: '//evil.example.com/?view=orders' });
  const out = afterWrite({ view: 'orders', message: 'ok' }, form);
  assert.ok(out.startsWith('/api/dashboard?'), out);
  assert.ok(!out.includes('evil.example.com/'), out);
});
