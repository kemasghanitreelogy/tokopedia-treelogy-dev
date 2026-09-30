import test from 'node:test';
import assert from 'node:assert/strict';

import { renderLabelReport } from '../src/dashboard-page.js';

/**
 * What the bench does after a run that did not fully print.
 *
 * Before this, the answer was: read a table, go back to the label list, find the same
 * seventeen orders and tick them again. A parcel missed in that count is a parcel that
 * does not ship, so the recovery is the feature, not the table.
 */

const report = (over = {}) => renderLabelReport({
  pageCount: 0, requested: 3, size: 'a6', groups: [], csrf: 'tok', failures: [], ...over,
});

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('failures are sorted by what to do about them, not by what went wrong', () => {
  const html = report({
    requested: 3,
    failures: [
      { id: 'A', channel: 'shopee', reason: 'Shopee menolak dan tetap menolak setelah dicoba ulang', kind: 'retry' },
      { id: 'B', channel: 'shopee', reason: 'nomor resi belum terbit di kurir', kind: 'wait' },
      { id: 'C', channel: 'tiktok_shop', reason: 'status CANCELLED tidak bisa dicetak', kind: 'check' },
    ],
  });

  assert.match(html, /Gangguan sesaat di platform/);
  assert.match(html, /Dokumen belum terbit di kurir/);
  assert.match(html, /Perlu diperiksa dulu/);
  // Ordered by how soon the bench can act: now, in a few minutes, not by printing at all.
  assert.ok(html.indexOf('Gangguan sesaat') < html.indexOf('Dokumen belum terbit'));
  assert.ok(html.indexOf('Dokumen belum terbit') < html.indexOf('Perlu diperiksa'));
});

test('the retry button carries exactly the orders worth asking about again', () => {
  const html = report({
    failures: [
      { id: 'A', channel: 'shopee', reason: 'sesaat', kind: 'retry' },
      { id: 'B', channel: 'shopee', reason: 'belum terbit', kind: 'wait' },
      { id: 'C', channel: 'tiktok_shop', reason: 'dibatalkan', kind: 'check' },
    ],
  });

  assert.match(html, /<input type="hidden" name="order" value="shopee:A">/);
  assert.match(html, /<input type="hidden" name="order" value="shopee:B">/);
  // Reprinting a cancelled order is guaranteed to fail, and the minutes before the
  // courier arrives are the one thing the bench has least of.
  assert.ok(!/value="tiktok_shop:C"/.test(html), 'yang tidak mungkin berhasil tidak ikut');
  assert.match(html, /Coba cetak lagi 2 pesanan/);
  assert.match(html, /name="size" value="a6"/);
  assert.match(html, /name="csrf" value="tok"/);
  // An order that needs a person gets somewhere to go instead of a button.
  assert.match(html, /href="\/api\/dashboard\?view=orders&amp;q=C"/);
});

test('a run with nothing to lose retries itself, once, in the open', () => {
  const html = report({
    failures: [{ id: 'A', channel: 'shopee', reason: 'sesaat', kind: 'retry' }],
  });
  const script = scripts(html).join('\n');

  assert.match(html, /id="retryform"/);
  assert.match(script, /if \(retryForm && true\)/);
  assert.match(script, /mencoba lagi otomatis dalam/);
  assert.match(script, /klik di mana saja untuk membatalkan/);
});

test('a run that produced labels never navigates away from them by itself', () => {
  // The stacks live in this page's memory and nowhere else; leaving takes them with it.
  const html = report({
    pageCount: 4,
    groups: [{ key: 'shopee', label: 'Shopee', pageCount: 4, pdfBase64: 'JVBERi0=' }],
    failures: [{ id: 'A', channel: 'shopee', reason: 'sesaat', kind: 'retry' }],
  });

  assert.match(scripts(html).join('\n'), /if \(retryForm && false\)/);
  assert.match(html, /Coba cetak lagi 1 pesanan/, 'tombolnya tetap ada');
});

test('an automatic retry never happens twice', () => {
  const html = report({
    retried: true,
    failures: [{ id: 'A', channel: 'shopee', reason: 'sesaat', kind: 'retry' }],
  });
  assert.match(scripts(html).join('\n'), /if \(retryForm && false\)/);
  assert.match(html, /name="retried" value="1"/, 'percobaan berikutnya pun menandai dirinya');
});

test('waiting for a courier is not something five seconds fixes', () => {
  const html = report({
    failures: [{ id: 'B', channel: 'shopee', reason: 'nomor resi belum terbit', kind: 'wait' }],
  });
  assert.match(scripts(html).join('\n'), /if \(retryForm && false\)/);
  assert.match(html, /Coba cetak lagi 1 pesanan/);
});

test('a report with no labels at all is still a working page, not a dead end', () => {
  const html = report({
    failures: [{ id: 'A', channel: 'shopee', reason: 'sesaat', kind: 'retry' }],
  });
  assert.ok(!/Buka 0 tab cetak/.test(html), 'tidak menawarkan membuka nol tab');
  assert.match(html, /Kembali/);
  for (const body of scripts(html)) assert.doesNotThrow(() => new Function(body));
});

test('a failure with no kind at all is treated as one for a person to look at', () => {
  // Every raise site names a kind, but a page must not become a retry loop if one forgets.
  const html = report({ failures: [{ id: 'A', channel: 'shopee', reason: 'entah' }] });
  assert.match(html, /Perlu diperiksa dulu/);
  assert.ok(!/name="order"/.test(html));
  assert.match(scripts(html).join('\n'), /if \(retryForm && false\)/);
});

test('without a token the page offers no retry it cannot actually post', () => {
  const html = report({ csrf: null, failures: [{ id: 'A', channel: 'shopee', reason: 'x', kind: 'retry' }] });
  assert.ok(!/id="retryform"/.test(html));
  for (const body of scripts(html)) assert.doesNotThrow(() => new Function(body));
});
