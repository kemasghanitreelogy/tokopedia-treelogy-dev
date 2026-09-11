import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendTelegram, formatFailures, notifySyncFailures, notifyCrash, escapeHtml, isTelegramConfigured, resetDedupe,
} from '../src/notify/telegram.js';

const config = { token: 'tok', chatId: '42' };
const capture = () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  return { calls, fetchImpl };
};

test('an unconfigured bot is silence, never an error', async () => {
  assert.equal(isTelegramConfigured({ token: '', chatId: '' }), false);
  const result = await sendTelegram('x', { config: { token: 'tok', chatId: '' }, fetchImpl: async () => { throw new Error('tidak boleh dipanggil'); } });
  assert.equal(result.sent, false);
});

test('the message goes to the configured chat as HTML', async () => {
  resetDedupe();
  const { calls, fetchImpl } = capture();
  const result = await sendTelegram('<b>hai</b>', { config, fetchImpl, key: 'k1' });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bottok\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(calls[0].body.parse_mode, 'HTML');
});

test('the same failure is reported once an hour, not once a sweep', async () => {
  resetDedupe();
  const { calls, fetchImpl } = capture();
  await sendTelegram('a', { config, fetchImpl, key: 'sama' });
  const again = await sendTelegram('a', { config, fetchImpl, key: 'sama' });
  await sendTelegram('b', { config, fetchImpl, key: 'beda' });
  assert.equal(again.sent, false);
  assert.equal(calls.length, 2, 'dua kunci berbeda, dua pesan');
});

test('a Telegram error or outage is swallowed and reported back, never thrown', async () => {
  resetDedupe();
  const bad = await sendTelegram('x', { config, key: 'e1', fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: 'chat not found' }) }) });
  assert.deepEqual(bad, { sent: false, reason: 'chat not found' });
  const down = await sendTelegram('x', { config, key: 'e2', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(down.sent, false);
});

test('failures are grouped by reason, with order codes as examples', () => {
  const html = formatFailures({
    source: 'sapuan otomatis',
    failures: [
      { customId: 'TRL-shopee-A', error: 'HTTP 422: product not available' },
      { customId: 'TRL-shopee-B', error: 'HTTP 422: product not available' },
      { customId: 'TRL-shopify-#1', error: 'HTTP 429' },
    ],
    channelErrors: { tiktok: 'Invalid credentials' },
  });
  assert.match(html, /3 faktur tidak masuk/);
  assert.match(html, /product not available\n\s+<code>TRL-shopee-A<\/code>, <code>TRL-shopee-B<\/code>/);
  assert.match(html, /HTTP 429/);
  assert.match(html, /Kanal <b>tiktok<\/b> tidak bisa dibaca: Invalid credentials/);
  assert.match(html, /view=jurnal/);
});

test('user data is escaped so a product name cannot break the message', () => {
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
  const html = formatFailures({ source: 's', failures: [{ customId: 'X', error: 'SKU <Whisk> & co' }] });
  assert.match(html, /SKU &lt;Whisk&gt; &amp; co/);
});

test('a clean run sends nothing at all', async () => {
  const { calls, fetchImpl } = capture();
  const result = await notifySyncFailures({ source: 's', results: [{ status: 'created' }, { status: 'exists' }] }, { config, fetchImpl });
  assert.equal(result.sent, false);
  assert.equal(calls.length, 0);
});

test('a batch with failures sends one message, keyed on the reasons', async () => {
  resetDedupe();
  const { calls, fetchImpl } = capture();
  const results = [{ status: 'failed', customId: 'A', error: 'x' }, { status: 'failed', customId: 'B', error: 'x' }];
  await notifySyncFailures({ source: 's', results }, { config, fetchImpl });
  // Next sweep, new order, same outage: no second message.
  await notifySyncFailures({ source: 's', results: [...results, { status: 'failed', customId: 'C', error: 'x' }] }, { config, fetchImpl });
  assert.equal(calls.length, 1);
});

test('a crash is reported with its message', async () => {
  resetDedupe();
  const { calls, fetchImpl } = capture();
  await notifyCrash({ source: 's', error: new Error('kredensial Mekari belum diisi') }, { config, fetchImpl });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /berhenti/);
  assert.match(calls[0].body.text, /kredensial Mekari belum diisi/);
});
