import test from 'node:test';
import assert from 'node:assert/strict';
import { expressService, isExpress, isInstant, INSTANT, SAME_DAY } from '../src/express.js';
import { expressAlert } from '../src/alerts-express.js';
import { raiseAlert, alertsSince, clearAlerts, alertBus, ALERT_TTL_MS } from '../src/alerts.js';
import { closeStore } from '../src/store/index.js';

/**
 * A driver is on the way for some of these parcels and not for others.
 *
 * Every courier string below is one that appears in the live database - 3,802 orders
 * since August - rather than one imagined for a test. That matters most for the ones
 * that must NOT match.
 */

test.after(async () => { await closeStore(); });

const order = (carrier, extra = {}) => ({ channel: 'shopee', id: 'X', carrier, ...extra });

test('the couriers that dispatch a driver now', () => {
  for (const carrier of ['GrabExpress Instant', 'GoSend Instant Prioritas', 'Gosend Instant', 'Grab Express Instant']) {
    assert.equal(expressService(order(carrier))?.tier, INSTANT, carrier);
  }
  // Tokopedia writes its instant couriers under their bare names; the live fulfilment
  // API returns PICKUP for both, against DROP_OFF for J&T and JNE.
  assert.equal(expressService(order('Grab'))?.tier, INSTANT);
  assert.equal(expressService(order('Gojek'))?.tier, INSTANT);
});

test('same day is still classified, and deliberately does not ring', () => {
  // Paxel is a pickup and the classifier says so; a driver coming at some point today is
  // not something to drop a box for. 60 of the 134 pickups in the database are Paxel, so
  // ringing for it was close to half the noise for the least of the urgency.
  assert.equal(expressService(order('Paxel'))?.tier, SAME_DAY);
  assert.equal(isExpress(order('Paxel')), true);
  assert.equal(isInstant(order('Paxel')), false);
  assert.equal(expressAlert({ channel: 'tokopedia', id: 'P', carrier: 'Paxel' }), null, 'tidak ada popup');
});

test('DHL Express is not a motorbike, and matching on "express" would have said it was', () => {
  // One order in the database carries it. An alert that fires on an international air
  // service teaches people to dismiss the popup without reading it.
  assert.equal(expressService(order('DHL Express')), null);
});

test('the ordinary couriers stay silent', () => {
  for (const carrier of ['JNE Reguler', 'J&T Express', 'Lion Parcel', 'Other', 'J&T-MP', 'JNE-MP', 'Anteraja', 'JNE YES', '']) {
    assert.equal(expressService(order(carrier)), null, carrier);
  }
  assert.equal(expressService({ channel: 'shopee', id: 'X' }), null, 'tanpa kurir sama sekali');
});

test('a whole word, so a future Grabmart is not swept in silently', () => {
  assert.equal(expressService(order('Grabmart')), null);
  assert.equal(expressService(order('Gojek Kilat')), null);
});

test('the alert says which sale, whose, how much and when it landed', () => {
  const alert = expressAlert({
    channel: 'shopee', id: '2609250PBNRM4E', carrier: 'GoSend Instant Prioritas',
    buyer: 'Dewi', total: 395000, createdAt: Date.parse('2026-09-25T08:26:00Z') / 1000,
    lines: [{ qty: 2 }, { qty: 1 }],
  });

  assert.equal(alert.key, 'express:shopee:2609250PBNRM4E');
  assert.equal(alert.kind, 'express');
  assert.equal(alert.data.tier, INSTANT);
  assert.equal(alert.data.channelName, 'Shopee');
  assert.equal(alert.data.courier, 'GoSend Instant Prioritas');
  assert.equal(alert.data.buyer, 'Dewi');
  assert.equal(alert.data.total, 'Rp395.000');
  assert.equal(alert.data.items, 3);
  // On the bench clock, so "16.26" means what the person standing at the printer thinks.
  assert.equal(alert.data.placedAt, '16.26');
});

test('an ordinary order produces no alert at all', () => {
  assert.equal(expressAlert({ channel: 'shopee', id: 'A', carrier: 'JNE Reguler' }), null);
});

test('every alert that is raised is an instant one', () => {
  for (const carrier of ['GrabExpress Instant', 'GoSend Instant Prioritas', 'Grab', 'Gojek']) {
    assert.equal(expressAlert({ channel: 'shopee', id: 'A', carrier })?.data.tier, INSTANT, carrier);
  }
  for (const carrier of ['Paxel', 'JNE Reguler', 'DHL Express', 'J&T Express']) {
    assert.equal(expressAlert({ channel: 'shopee', id: 'A', carrier }), null, carrier);
  }
});

test('the doorbell rings once however many times the platform pushes', async () => {
  await clearAlerts();
  const alert = { key: 'express:shopee:PUSH', kind: 'express', title: 'Instant' };

  const first = await raiseAlert(alert);
  assert.ok(first?.id, 'pertama berbunyi');
  assert.equal(await raiseAlert(alert), null, 'push kedua tidak berbunyi lagi');
  assert.equal((await alertsSince(0)).length, 1);
});

test('a browser that was away catches up from where it left off', async () => {
  await clearAlerts();
  const a = await raiseAlert({ key: 'k1', kind: 'express', title: 'satu' });
  const b = await raiseAlert({ key: 'k2', kind: 'express', title: 'dua' });

  assert.deepEqual((await alertsSince(0)).map((x) => x.title), ['satu', 'dua'], 'tab dingin dapat yang masih hidup');
  assert.deepEqual((await alertsSince(a.id)).map((x) => x.title), ['dua'], 'yang sudah dilihat tidak diulang');
  assert.deepEqual(await alertsSince(b.id), [], 'sudah mutakhir');
});

test('nothing stale ever pops up', async () => {
  await clearAlerts();
  const now = Date.now();
  await raiseAlert({ key: 'lama', kind: 'express', title: 'lama' }, { now: now - ALERT_TTL_MS - 1000 });
  await raiseAlert({ key: 'baru', kind: 'express', title: 'baru' }, { now });

  assert.deepEqual((await alertsSince(0, { now })).map((x) => x.title), ['baru']);
});

test('the in-process bus carries it to a listener immediately', async () => {
  await clearAlerts();
  const heard = [];
  const listen = (a) => heard.push(a.title);
  alertBus.on('alert', listen);
  try {
    await raiseAlert({ key: 'bus', kind: 'express', title: 'sekarang' });
  } finally {
    alertBus.off('alert', listen);
  }
  assert.deepEqual(heard, ['sekarang']);
});

test('an alert with no key is a bug, not a silent no-op', async () => {
  await assert.rejects(() => raiseAlert({ kind: 'express' }), /key/);
});

/* ------------------------------------------------- what the browser actually gets */

const { renderLabels } = await import('../src/dashboard-page.js');

const pageFor = (user) => renderLabels({
  orders: [], range: { from: '2026-09-18', to: '2026-09-25', label: '7 hari' },
  errors: {}, shopeeShop: null, generatedAt: 1790300000, csrf: 'x', flash: null,
  sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', user,
});

const scriptsIn = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('every script the page emits actually parses', () => {
  /*
   * This whole block is written inside a template literal, which eats backslashes. A
   * regular expression like /^\/[\w-]*$/ in the source arrives in the browser as
   * something that does not parse, and the failure is silent: the script dies, the
   * doorbell never connects, and the page looks fine. It has happened twice - once to an
   * emoji filter, once to this alert's own link check.
   *
   * Compiling is enough to catch it, and needs no browser.
   */
  for (const src of scriptsIn(pageFor({ name: 'K', email: 'k@t.com', role: 'owner' }))) {
    assert.doesNotThrow(() => new Function(src), `script tidak bisa diurai: ${src.slice(0, 120)}`);
  }
});

test('the doorbell is wired for a signed-in page and absent from a signed-out one', () => {
  const inside = pageFor({ name: 'K', email: 'k@t.com', role: 'owner' });
  assert.match(inside, /id="alerts"/);
  assert.match(inside, /new EventSource\('\/api\/events\?since=' \+ seen\(\)\)/);

  // The login screen has nothing to be told, and an EventSource there would only retry
  // a 401 for ever.
  // The comment explaining the guard still ships; the connection does not, which is the
  // part that matters - an EventSource on a login page would retry a 401 for ever.
  const outside = pageFor(null);
  assert.doesNotMatch(outside, /id="alerts"/);
  assert.doesNotMatch(outside, /new EventSource\(/);
});

test('values from a marketplace go through the escaper, never straight into innerHTML', () => {
  const [doorbell] = scriptsIn(pageFor({ name: 'K', email: 'k@t.com', role: 'owner' }))
    .filter((s) => s.includes('EventSource'));
  // A buyer's name is typed by a stranger. Caught by a headless browser first: "Dewi
  // <b>x</b>" rendered as markup because the row value was interpolated raw.
  assert.match(doorbell, /\['Kurir', esc\(d\.courier\)\]/);
  assert.match(doorbell, /\['Pembeli', esc\(d\.buyer\)\]/);
  assert.match(doorbell, /esc\(d\.total\)/);
  assert.match(doorbell, /esc\(d\.items\)/);
  // And the link is a path on this site or it is not rendered at all.
  assert.match(doorbell, /samePath\(a\.href\)/);
});

/* ------------------------------------------------ the net behind the webhook */

const { ringExpressBacklog, FRESH_MS } = await import('../src/alerts-express.js');

const parcel = (id, over = {}) => ({
  channel: 'shopee', id, carrier: 'GrabExpress Instant', stage: 'to_ship',
  buyer: 'Budi', total: 100000, createdAt: Math.floor(Date.now() / 1000), lines: [{ qty: 1 }],
  ...over,
});

test('a parcel the webhook never announced still rings', async () => {
  await clearAlerts();
  // Shopee's pushes cannot be verified by signature and are rate limited per shop, so a
  // missed one is ordinary - and a missed push for an instant order is the exact case
  // this whole feature exists for.
  const rung = await ringExpressBacklog([
    parcel('MISSED'),
    parcel('ORDINARY', { carrier: 'JNE Reguler' }),
    parcel('SAMEDAY', { carrier: 'Paxel' }),
  ]);
  assert.deepEqual(rung.map((r) => r.data.id), ['MISSED'], 'sapuan pun hanya instant');
});

test('it never rings twice for what the webhook already caught', async () => {
  await clearAlerts();
  await ringExpressBacklog([parcel('TWICE')]);
  assert.deepEqual(await ringExpressBacklog([parcel('TWICE')]), [], 'kunci yang sama ditolak umpan');
});

test('a parcel the courier already took is not news', async () => {
  await clearAlerts();
  const rung = await ringExpressBacklog([
    parcel('GONE', { stage: 'delivered' }),
    parcel('DONE', { stage: 'completed' }),
    parcel('VOID', { stage: 'cancelled' }),
    parcel('HERE'),
  ]);
  assert.deepEqual(rung.map((r) => r.data.id), ['HERE']);
});

test('the sweep catches up, it does not re-announce history', async () => {
  await clearAlerts();
  const now = Date.now();
  const rung = await ringExpressBacklog([
    parcel('OLD', { createdAt: Math.floor((now - FRESH_MS - 60_000) / 1000) }),
    parcel('FRESH', { createdAt: Math.floor((now - 60_000) / 1000) }),
  ], { now });
  assert.deepEqual(rung.map((r) => r.data.id), ['FRESH']);
});

test('a burst cannot become a wall, and the newest are the ones that ring', async () => {
  await clearAlerts();
  const now = Date.now();
  const many = Array.from({ length: 9 }, (_, i) =>
    parcel(`B${i}`, { createdAt: Math.floor((now - (9 - i) * 60_000) / 1000) }));

  const rung = await ringExpressBacklog(many, { now });
  assert.equal(rung.length, 5, 'nobody reads the seventh popup');
  assert.deepEqual(rung.map((r) => r.data.id), ['B8', 'B7', 'B6', 'B5', 'B4'], 'terbaru dulu');
});
