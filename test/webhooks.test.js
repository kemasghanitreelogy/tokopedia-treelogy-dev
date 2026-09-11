import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import {
  verifyShopify, verifyTikTok, verifyShopee, hmacTikTok, safeEqual, readRawBody, SHOPEE_CANDIDATES,
} from '../src/webhooks/verify.js';
import { statusFor } from '../src/webhooks/handle.js';
import { WEBHOOK_PATHS, SHOPEE_PUSH_CODES, TIKTOK_EVENTS, SHOPIFY_TOPICS, webhookUrl } from '../src/webhooks/register.js';

const body = '{"id":123,"name":"#1001","total_price":"505000.00"}';

test('comparing values of different lengths is false, not a crash', () => {
  // timingSafeEqual throws on a length mismatch, which would turn a malformed signature
  // into a 500 and, on the platforms that suspend noisy endpoints, into lost orders.
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual('', 'x'), false);
  assert.equal(safeEqual('same', 'same'), true);
});

test('Shopify accepts its own base64 HMAC and nothing else', () => {
  const secret = 'shpss_rahasia';
  const header = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');

  assert.equal(verifyShopify({ rawBody: body, header, secret }).ok, true);
  assert.equal(verifyShopify({ rawBody: body, header, secret: 'salah' }).ok, false);
  assert.equal(verifyShopify({ rawBody: `${body} `, header, secret }).ok, false, 'satu spasi pun harus gagal');
  assert.equal(verifyShopify({ rawBody: body, header: null, secret }).ok, false);
  assert.equal(verifyShopify({ rawBody: body, header, secret: '' }).ok, false);
  // Hex instead of base64 is the classic mix-up and must not pass.
  const hex = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  assert.equal(verifyShopify({ rawBody: body, header: hex, secret }).ok, false);
});

test('TikTok signs app_key followed by the body, in that order', () => {
  const appKey = 'kunci', appSecret = 'rahasia';
  const header = hmacTikTok({ rawBody: body, appKey, appSecret });

  assert.equal(verifyTikTok({ rawBody: body, header, appKey, appSecret }).ok, true);
  assert.equal(verifyTikTok({ rawBody: body, header: ` ${header} `, appKey, appSecret }).ok, true, 'spasi di header dimaafkan');

  // Body-then-key, or the body alone, are the two wrong implementations people ship.
  const reversed = crypto.createHmac('sha256', appSecret).update(`${body}${appKey}`).digest('hex');
  const bodyOnly = crypto.createHmac('sha256', appSecret).update(body).digest('hex');
  assert.equal(verifyTikTok({ rawBody: body, header: reversed, appKey, appSecret }).ok, false);
  assert.equal(verifyTikTok({ rawBody: body, header: bodyOnly, appKey, appSecret }).ok, false);
  assert.equal(verifyTikTok({ rawBody: body, header, appKey: 'lain', appSecret }).ok, false);
});

test('Shopee reports which base string matched, so it can be pinned', () => {
  const partnerKey = 'partner-key';
  const url = 'https://treelogy.example/api/webhook/shopee';

  for (const shape of Object.keys(SHOPEE_CANDIDATES)) {
    const header = crypto.createHmac('sha256', partnerKey)
      .update(SHOPEE_CANDIDATES[shape]({ url, rawBody: body }), 'utf8').digest('hex');
    const result = verifyShopee({ rawBody: body, header, url, partnerKey });
    assert.equal(result.ok, true, shape);
    assert.equal(result.shape, shape);
  }
});

test('a Shopee signature from the wrong key matches no shape at all', () => {
  const url = 'https://treelogy.example/api/webhook/shopee';
  const header = crypto.createHmac('sha256', 'kunci-salah').update(`${url}${body}`).digest('hex');
  const result = verifyShopee({ rawBody: body, header, url, partnerKey: 'partner-key' });
  assert.equal(result.ok, false);
  assert.equal(result.shape, undefined);
  assert.equal(verifyShopee({ rawBody: body, header: '', url, partnerKey: 'partner-key' }).ok, false);
});

test('a SHA256-prefixed Shopee header is accepted', () => {
  const partnerKey = 'partner-key';
  const url = 'https://treelogy.example/api/webhook/shopee';
  const hex = crypto.createHmac('sha256', partnerKey).update(`${url}${body}`).digest('hex');
  assert.equal(verifyShopee({ rawBody: body, header: `SHA256 ${hex}`, url, partnerKey }).ok, true);
});

test('the raw body survives byte for byte', async () => {
  // Re-serialising parsed JSON reorders keys and drops whitespace, which breaks every
  // HMAC above; this is the reason the body is never round-tripped through JSON.parse.
  const odd = '{ "b":1,\n  "a" : 2 }';
  const stream = Readable.from([Buffer.from(odd.slice(0, 7)), Buffer.from(odd.slice(7))]);
  assert.equal(await readRawBody(stream), odd);
});

test('an oversized body is refused rather than buffered', async () => {
  const stream = Readable.from([Buffer.alloc(50), Buffer.alloc(60)]);
  await assert.rejects(() => readRawBody(stream, 64), /terlalu besar/);
});

test('only a retryable failure asks the platform to send again', () => {
  // Every other outcome is a 200: a stream of non-2xx gets the push channel suspended,
  // which costs far more orders than the one that could not be booked.
  assert.equal(statusFor({ status: 'failed' }), 500);
  for (const status of ['created', 'exists', 'skipped', 'held', 'ignored', 'dry-run']) {
    assert.equal(statusFor({ status }), 200, status);
  }
});

test('every platform has its own path and the registration constants are the confirmed ones', () => {
  assert.deepEqual(Object.keys(WEBHOOK_PATHS).sort(), ['shopee', 'shopify', 'tiktok']);
  assert.equal(new Set(Object.values(WEBHOOK_PATHS)).size, 3, 'satu URL per platform');
  // 3 is Shopee's order status push; the live get_push_config confirms the name.
  assert.ok(SHOPEE_PUSH_CODES.includes(3));
  assert.deepEqual(TIKTOK_EVENTS, ['ORDER_STATUS_CHANGE']);
  assert.deepEqual(SHOPIFY_TOPICS, ['ORDERS_PAID', 'ORDERS_CREATE']);
  assert.match(webhookUrl('shopee'), /^https:\/\/.+\/api\/webhook\/shopee$/);
});

test("Shopee's verification push is recognised by its content and nothing else is", async () => {
  const { Readable } = await import('node:stream');
  const handler = (await import('../api/webhook/shopee.js')).default;
  const call = async (raw, headers = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers: { host: 'x', ...headers } });
    let out = ''; const res = { statusCode: 0, setHeader() {}, end(b) { out = b ?? ''; } };
    await handler(req, res);
    return [res.statusCode, out];
  };
  // The handshake carries no order and is answered 200 even unsigned.
  const [ok] = await call('{"code":0,"data":{"verify_info":"This is a Verification message.Please respond in the certain format."}}');
  assert.equal(ok, 200);
  // A real push shaped like a verification but naming an order must not slip through.
  const [forged] = await call('{"code":3,"data":{"verify_info":"x","ordersn":"ABC"}}', { authorization: 'deadbeef' });
  assert.equal(forged, 401);
  const [noSig] = await call('{"code":0,"data":{}}');
  assert.equal(noSig, 401, 'code 0 tanpa verify_info bukan handshake');
});

test('an unverifiable Shopee push is trusted only when it is shaped like our own order push', async () => {
  const { looksLikeOrderPush, unverifiedAllowed } = await import('../api/webhook/shopee.js');
  assert.equal(looksLikeOrderPush({ code: 3, data: { ordersn: '260909JG9BJHD9' } }), true);
  assert.equal(looksLikeOrderPush({ code: 4, data: { ordersn: '260909JG9BJHD9', tracking_no: 'CM1' } }), true);
  // Anything that is not an order push, or whose order code is not an order code, is not.
  assert.equal(looksLikeOrderPush({ code: 0, data: { verify_info: 'x' } }), false);
  assert.equal(looksLikeOrderPush({ code: 3, data: {} }), false);
  assert.equal(looksLikeOrderPush({ code: 3, data: { ordersn: '../../etc' } }), false);
  assert.equal(looksLikeOrderPush({ code: 3, data: { ordersn: 'x'.repeat(40) } }), false);

  // A flood of unverified pushes is capped, so a forger cannot spend our Shopee API budget.
  let t = 1_000_000;
  let allowed = 0;
  for (let i = 0; i < 40; i++) if (unverifiedAllowed(t)) allowed++;
  assert.equal(allowed, 30);
  assert.equal(unverifiedAllowed(t + 61_000), true, 'jendela satu menit bergeser');
});

test('a push naming a shop that is not ours is refused even if it looks right', async () => {
  const { Readable } = await import('node:stream');
  const handler = (await import('../api/webhook/shopee.js')).default;
  const raw = JSON.stringify({ shop_id: 999, code: 3, timestamp: 1, data: { ordersn: '260909JG9BJHD9' } });
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers: { host: 'x', authorization: 'deadbeef' } });
  let out = ''; const res = { statusCode: 0, setHeader() {}, end(b) { out = b ?? ''; } };
  await handler(req, res);
  assert.equal(res.statusCode, 401, out);
});
