import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingCarrier, pending } from '../src/fulfillment.js';
import { refreshOrders } from '../src/orders-refresh.js';

/**
 * A Shopee order that is arrangeable with no courier on it.
 *
 * Shopee assigns the courier when the buyer pays, and for an instant courier that is a
 * live booking with Grab or Gojek. A push reaching us in those seconds gives a row with
 * an empty carrier, and nothing fills it in afterwards.
 *
 * Order 2609287GUBMJ7N is what that cost: stored as arrangeable with no courier, while
 * Shopee had it CANCELLED with GrabExpress Instant and a LOGISTICS_INVALID package. It
 * sat at the top of the worklist, ticked, waiting to be arranged.
 */

const shopee = (over = {}) => ({ channel: 'shopee', id: 'X', status: 'READY_TO_SHIP', stage: 'to_ship', carrier: '', createdAt: 1, ...over });

test('an arrangeable Shopee order with no courier is a snapshot, not a fact', () => {
  assert.equal(awaitingCarrier(shopee()), true);
  assert.equal(awaitingCarrier(shopee({ status: 'RETRY_SHIP' })), true);
  assert.equal(awaitingCarrier(shopee({ carrier: 'JNE Reguler' })), false, 'sudah lengkap');
});

test('an unpaid order genuinely has no courier, and Shopee agrees', () => {
  // Checked against the live API: four UNPAID orders, all with an empty shipping_carrier
  // on Shopee's side too. Re-reading those would buy nothing.
  assert.equal(awaitingCarrier(shopee({ status: 'UNPAID', stage: 'unpaid' })), false);
});

test('only Shopee, because only Shopee books the courier at payment', () => {
  assert.equal(awaitingCarrier({ channel: 'tokopedia', status: 'AWAITING_SHIPMENT', carrier: '' }), false);
  assert.equal(awaitingCarrier({ channel: 'shopify', stage: 'to_ship', carrier: '' }), false);
  assert.equal(awaitingCarrier({ channel: 'manual', status: 'MANUAL', carrier: '' }), false);
  assert.equal(awaitingCarrier(null), false);
});

test('a cancelled order drops out of the worklist once the row is settled', () => {
  // The whole point. Before the re-read it is ticked and waiting to be arranged; after
  // it, nextAction refuses it and it is simply gone.
  const stale = shopee({ id: '2609287GUBMJ7N' });
  assert.equal(pending([stale]).length, 1, 'sebelum dibaca ulang: masih di daftar');

  const settled = { ...stale, status: 'CANCELLED', stage: 'cancelled', carrier: 'GrabExpress Instant' };
  assert.equal(pending([settled]).length, 0, 'sesudah: hilang sendiri');
});

test('the refresh hands back what it stored, so the page need not read twice', async () => {
  const fresh = [{ channel: 'shopee', id: 'A', status: 'CANCELLED', carrier: 'GrabExpress Instant' }];
  let saved = null;
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => ({ orders: fresh }),
    save: async (orders) => { saved = orders; },
    hasDatabase: () => true,
  });
  assert.equal(out.refreshed, 1);
  assert.deepEqual(out.orders, fresh);
  assert.deepEqual(saved, fresh);
});

test('a platform that will not answer leaves the page drawable', async () => {
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => { throw new Error('shopee tidak menjawab'); },
    save: async () => {},
    hasDatabase: () => true,
  });
  // The worklist is still drawn from what we have; it simply stays as stale as it was.
  assert.deepEqual(out.orders, []);
  assert.match(out.error, /tidak menjawab/);
});

/* ----------------------------------------------- settling a whole worklist */

const { needsSettling, oldestRead, STALE_MS } = await import('../src/fulfillment.js');
const { ageOfData } = await import('../src/dashboard-page.js');

const at = (msAgo, over = {}) => shopee({ fetchedAt: Math.floor((Date.now() - msAgo) / 1000), ...over });

test('only rows somebody is about to act on are worth a read', () => {
  const now = Date.now();
  const rows = [
    at(STALE_MS * 2, { id: 'ACTIONABLE', carrier: 'JNE Reguler' }),
    // Nobody can arrange a cancelled or delivered order, so it costs nothing unread.
    at(STALE_MS * 5, { id: 'DONE', status: 'COMPLETED', stage: 'completed', carrier: 'JNE Reguler' }),
    { channel: 'manual', id: 'WALKIN', status: 'MANUAL', fetchedAt: 0 },
  ];
  assert.deepEqual(needsSettling(rows, {}, { now }).map((o) => o.id), ['ACTIONABLE']);
});

test('a row read a minute ago is left alone', () => {
  assert.deepEqual(needsSettling([at(60_000, { carrier: 'JNE Reguler' })], {}, { now: Date.now() }), []);
});

test('the known-incomplete come first, and regardless of how fresh they are', () => {
  const now = Date.now();
  const rows = [
    at(STALE_MS * 9, { id: 'OLDEST', carrier: 'JNE Reguler' }),
    at(1000, { id: 'NO-CARRIER' }),
  ];
  // An empty carrier is a fact about our copy, not about the order, whatever its age.
  assert.deepEqual(needsSettling(rows, {}, { now }).map((o) => o.id), ['NO-CARRIER', 'OLDEST']);
});

test('when the cap bites it bites the freshest', () => {
  const now = Date.now();
  const rows = [1, 2, 3, 4].map((n) => at(STALE_MS * n, { id: `R${n}`, carrier: 'JNE Reguler' }));
  assert.deepEqual(needsSettling(rows, {}, { now, max: 2 }).map((o) => o.id), ['R4', 'R3']);
});

test('the oldest read behind a page is what the page should admit to', () => {
  assert.equal(oldestRead([{ fetchedAt: 300 }, { fetchedAt: 100 }, { fetchedAt: 200 }]), 100);
  assert.equal(oldestRead([{ fetchedAt: 0 }, {}]), null, 'tidak ada yang bisa dikatakan');
  assert.equal(oldestRead([]), null);
});

test('the page says nothing while the data is keeping up, and speaks when it is not', () => {
  const now = Date.now();
  const ago = (min) => Math.floor((now - min * 60_000) / 1000);
  // A line that always says "fine" is a line nobody reads.
  assert.equal(ageOfData(ago(2), now), null);
  assert.equal(ageOfData(ago(40), now).tone, 'flag');
  assert.equal(ageOfData(ago(300), now).tone, 'bad');
  assert.match(ageOfData(ago(300), now).text, /5 jam/);
});

test('a failed re-read outranks any age, because the screen is knowingly behind', () => {
  const out = ageOfData(Math.floor(Date.now() / 1000), Date.now(), true);
  assert.equal(out.tone, 'bad');
  assert.match(out.text, /tidak bisa dibaca ulang/);
});

test('the age reported is of the rows the page acts on, not everything it loaded', async () => {
  const { settleable } = await import('../src/fulfillment.js');
  const now = Date.now();
  const rows = [
    at(5 * 3600_000, { id: 'MOVING', status: 'SHIPPED', stage: 'shipping', carrier: 'JNE Reguler' }),
    at(120_000, { id: 'TODO', carrier: 'JNE Reguler' }),
  ];
  /*
   * The first cut took the oldest of all 216 outstanding orders and announced "baris
   * tertua dibaca 5 jam lalu" on a page whose every actionable row was minutes old. A
   * parcel already in transit is as stale as it likes; warning about it trains people to
   * ignore the banner, which is the failure this whole change exists to avoid.
   */
  assert.deepEqual(settleable(rows).map((o) => o.id), ['TODO']);
  assert.equal(ageOfData(oldestRead(settleable(rows)), now), null, 'diam, karena yang dikerjakan masih segar');
  assert.match(ageOfData(oldestRead(rows), now).text, /5 jam/, 'sedangkan seluruh muatan memang tua');
});
