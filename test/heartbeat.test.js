import test from 'node:test';
import assert from 'node:assert/strict';
import { ageOf } from '../src/mekari/heartbeat.js';
import { renderJurnal } from '../src/dashboard-page.js';
import { syncOverview } from '../src/mekari/sync.js';

const now = Date.parse('2026-09-11T10:00:00Z');
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString();

test('an age reads the way a person would say it', () => {
  assert.equal(ageOf(null), null);
  assert.equal(ageOf(minutesAgo(0), now), 'baru saja');
  assert.equal(ageOf(minutesAgo(7), now), '7 menit lalu');
  assert.equal(ageOf(minutesAgo(3 * 60), now), '3 jam lalu');
  assert.equal(ageOf(minutesAgo(3 * 24 * 60), now), '3 hari lalu');
});

const common = {
  range: { preset: '7d', from: '2026-09-01', to: '2026-09-08', label: '7 hari', since: 1, until: 2, clamped: false },
  errors: {}, shopeeShop: null, generatedAt: now, csrf: 't', flash: null,
  overview: syncOverview({ orders: [], ledger: { orders: {} } }),
  live: true, depositTo: null, configured: true,
};

test('the Jurnal tab says when each sync path last did something', () => {
  const html = renderJurnal({
    ...common,
    heartbeat: {
      webhooks: { shopee: { at: minutesAgo(3), status: 'created', id: 'X' } },
      sweep: { at: minutesAgo(12), created: 2, failed: 0 },
    },
  });
  assert.match(html, /Shopee<\/b> \d+ menit lalu/);
  assert.match(html, /\(created\)/);
  assert.match(html, /Sapuan<\/b> \d+ menit lalu/);
  assert.match(html, /2 dibuat, 0 gagal/);
  // Channels that have never pushed are named as such, never left blank.
  assert.match(html, /Tokopedia<\/b> belum ada push/);
  assert.match(html, /Shopify<\/b> belum ada push/);
});

test('silence that is too long is flagged; silence that is normal is not', () => {
  const html = renderJurnal({
    ...common,
    heartbeat: {
      webhooks: {
        shopee: { at: minutesAgo(10), status: 'exists' },        // fine
        tokopedia: { at: minutesAgo(6 * 60), status: 'created' }, // too quiet
      },
      sweep: { at: minutesAgo(90), created: 0, failed: 0 },       // scheduler stopped
    },
  });
  assert.match(html, /hb--ok"><b>Shopee/);
  assert.match(html, /hb--flag"><b>Tokopedia/);
  assert.match(html, /hb--flag"><b>Sapuan/);
  assert.match(html, /hb--muted"><b>Shopify/);
});

test('a page with no heartbeat at all still renders, and says so', () => {
  const html = renderJurnal({ ...common, heartbeat: null });
  assert.match(html, /belum pernah jalan/);
  assert.equal((html.match(/belum ada push/g) ?? []).length, 4);
});
