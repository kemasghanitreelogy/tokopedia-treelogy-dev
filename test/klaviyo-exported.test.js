import test from 'node:test';
import assert from 'node:assert/strict';
import { notExported, markExported, lastBatch } from '../src/klaviyo/exported.js';
import { klaviyoButtons } from '../src/dashboard-page.js';

const r = (id, channel = 'shopee') => ({ id, channel, rating: 5, text: '' });

test('a review that went out in any file is not new again, whichever channel it is from', () => {
  let ledger = markExported(null, [r(1), r(2, 'tokopedia')], { at: 100 });
  assert.deepEqual(notExported([r(1), r(2, 'tokopedia'), r(2), r(3)], ledger).map((x) => `${x.channel}:${x.id}`), ['shopee:2', 'shopee:3']);
  ledger = markExported(ledger, [r(3)], { at: 200, only: 'new' });
  assert.equal(notExported([r(1), r(3)], ledger).length, 0);
  assert.equal(ledger.keys['shopee:1'], 100, 'first download is kept, not overwritten');
  assert.deepEqual(lastBatch(ledger), { at: 200, count: 1, only: 'new', actor: null });
});

test('a late review is new however old the date it carries', () => {
  const ledger = markExported(null, [r(1)], { at: 1_800_000_000 });
  const late = { ...r(9), createdAtEpoch: 1_700_000_000 };
  assert.equal(notExported([late], ledger).length, 1);
});

test('the buttons say how many are new, and say so when there are none', () => {
  const some = klaviyoButtons({ baseQuery: 'view=reviews', klaviyo: { fresh: 67, last: { at: 1789970412, count: 2065 } } });
  assert.match(some, /export=klaviyo&amp;only=new/);
  assert.match(some, /Unduh baru untuk Klaviyo · 67/);
  assert.match(some, /Terakhir diunduh .* · 2065 ulasan/);
  const none = klaviyoButtons({ baseQuery: 'view=reviews', klaviyo: { fresh: 0, last: null } });
  assert.doesNotMatch(none, /only=new/);
  assert.match(none, /Tidak ada ulasan baru/);
});
