import test from 'node:test';
import assert from 'node:assert/strict';
import { renderExpressLog, VALID_VIEWS } from '../src/dashboard-page.js';

/**
 * The bell used to ring one alert on purpose to prove the chime worked.
 *
 * That answered a question nobody had twice a day and left the one they did have
 * unanswered: which instant orders came in, and when. An instant courier means a driver
 * was dispatched, so this is also the list of every time somebody had to drop what they
 * were doing.
 */

const now = Math.floor(Date.now() / 1000);
const order = (id, over = {}) => ({
  channel: 'shopee', id, carrier: 'GoSend Instant Prioritas', stage: 'to_ship',
  status: 'READY_TO_SHIP', buyer: 'budi', total: 100000, createdAt: now - 600, lines: [], ...over,
});

const page = (orders) => renderExpressLog({
  orders, range: { from: '2026-09-22', to: '2026-09-29', label: '7 hari' },
  errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'TOKEN', flash: null,
  user: { name: 'Kemas', email: 'k@t.com', role: 'owner' },
});

test('the log is reachable by its own url', () => {
  assert.equal(VALID_VIEWS.express, 'Pickup Instant');
});

test('only instant couriers are history worth keeping here', () => {
  const html = page([
    order('INSTANT'),
    order('GRAB', { carrier: 'GrabExpress Instant', buyer: 'grabbuyer' }),
    order('REGULER', { carrier: 'JNE Reguler', buyer: 'jnebuyer' }),
    order('SAMEDAY', { carrier: 'Paxel', buyer: 'paxelbuyer' }),
  ]);
  assert.match(html, /INSTANT/);
  assert.match(html, /grabbuyer/);
  // A drop-off and a same-day pickup are not what the bell is about.
  assert.doesNotMatch(html, /jnebuyer/);
  assert.doesNotMatch(html, /paxelbuyer/);
});

test('every stage is kept, because this is a record and not a worklist', () => {
  // The chime is only for a paid order waiting to be packed; the log is the whole story.
  const html = page([
    order('A', { stage: 'to_ship', buyer: 'menunggu' }),
    order('B', { stage: 'shipping', buyer: 'jalan' }),
    order('C', { stage: 'completed', buyer: 'selesai' }),
    order('D', { stage: 'cancelled', buyer: 'batal' }),
  ]);
  for (const who of ['menunggu', 'jalan', 'selesai', 'batal']) assert.match(html, new RegExp(who));
});

test('newest first, because that is the one being asked about', () => {
  const html = page([
    order('OLD', { createdAt: now - 86400, buyer: 'kemarin' }),
    order('NEW', { createdAt: now - 60, buyer: 'barusan' }),
  ]);
  assert.ok(html.indexOf('barusan') < html.indexOf('kemarin'));
});

test('it counts what is still waiting to be packed, which is what anybody acts on', () => {
  const html = page([
    order('A', { stage: 'to_ship' }),
    order('B', { stage: 'to_ship' }),
    order('C', { stage: 'completed' }),
  ]);
  assert.match(html, /<span class="stat__n flag">2<\/span>\s*<span class="stat__l">Belum dipacking/);
});

test('the couriers are counted, so a pattern is visible without reading rows', () => {
  const html = page([
    order('A', { carrier: 'GoSend Instant Prioritas' }),
    order('B', { carrier: 'GoSend Instant Prioritas' }),
    order('C', { carrier: 'GrabExpress Instant' }),
  ]);
  assert.match(html, /GoSend Instant Prioritas <b>2<\/b>/);
  assert.match(html, /GrabExpress Instant <b>1<\/b>/);
});

test('the test button lives here now, not in the chrome of every page', () => {
  // A button about alerts belongs on the page about alerts.
  const html = page([order('A')]);
  assert.match(html, /id="alerttest" data-csrf="TOKEN"/);
  // And the bell in the bar is a link to this page rather than a button that rings.
  assert.match(html, /<a class="iconbtn is-on" href="\?view=express"/);
});

test('an empty range still offers the test, because that is when it is asked for', () => {
  const html = page([order('A', { carrier: 'JNE Reguler' })]);
  assert.match(html, /Belum ada pesanan instant/);
  assert.match(html, /id="alerttest"/);
});
