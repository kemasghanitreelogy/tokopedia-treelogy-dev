import crypto from 'node:crypto';

/**
 * Proving a push really came from the platform it claims to.
 *
 * Each marketplace signs differently, and none of them agrees with the others on the
 * header, the base string, or the encoding. What they do agree on is that the secret is
 * one we already hold, so a forged push is detectable - and none of these verifiers
 * decides what gets booked. The push only carries an order id; the order itself is
 * always re-read over our own signed connection before a single rupiah reaches Jurnal.
 */

/** Length-safe comparison - `timingSafeEqual` throws on a length mismatch. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const hmacHex = (key, message) => crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
const hmacBase64 = (key, message) => crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64');

/**
 * Shopify: base64 HMAC-SHA256 of the raw body, keyed with the app's client secret,
 * in X-Shopify-Hmac-Sha256.
 */
export function verifyShopify({ rawBody, header, secret }) {
  if (!secret || !header) return { ok: false, reason: 'tanda tangan atau rahasia tidak ada' };
  return { ok: safeEqual(header, hmacBase64(secret, rawBody)) };
}

/**
 * TikTok Shop (and therefore Tokopedia): lowercase hex HMAC-SHA256 keyed with the app
 * secret, over app_key immediately followed by the raw body, in the Authorization header
 * with no scheme prefix.
 */
export function verifyTikTok({ rawBody, header, appKey, appSecret }) {
  if (!appSecret || !header) return { ok: false, reason: 'tanda tangan atau rahasia tidak ada' };
  return { ok: safeEqual(header.trim(), hmacTikTok({ rawBody, appKey, appSecret })) };
}

export const hmacTikTok = ({ rawBody, appKey, appSecret }) => hmacHex(appSecret, `${appKey}${rawBody}`);

/**
 * Shopee, where the exact base string is the one thing I could not confirm.
 *
 * Shopee's own documentation is behind a login the build cannot reach, and the public
 * examples disagree with each other and with Shopee's v2 console - some sign the body
 * alone, some the callback URL followed by the body. Rather than pick one and hope, every
 * documented shape is computed and the one that matches is reported back, so the first
 * genuine push tells us the answer instead of us guessing it.
 *
 * This is safe to run in that state precisely because a push is only a trigger: the order
 * is re-read from Shopee over a signed connection before anything is booked.
 */
export const SHOPEE_CANDIDATES = {
  'url+body': ({ url, rawBody }) => `${url}${rawBody}`,
  'url|body': ({ url, rawBody }) => `${url}|${rawBody}`,
  body: ({ rawBody }) => rawBody,
  url: ({ url }) => url,
};

export function verifyShopee({ rawBody, header, url, partnerKey }) {
  if (!partnerKey || !header) return { ok: false, reason: 'tanda tangan atau partner key tidak ada' };
  const provided = header.replace(/^SHA256\s+/i, '').trim();

  for (const [shape, build] of Object.entries(SHOPEE_CANDIDATES)) {
    if (safeEqual(provided, hmacHex(partnerKey, build({ url, rawBody })))) return { ok: true, shape };
  }
  return { ok: false, reason: 'tidak ada bentuk tanda tangan yang cocok' };
}

/**
 * The exact bytes the platform signed.
 *
 * Re-serialising parsed JSON changes whitespace and key order and breaks every HMAC
 * above, so the body is read off the stream and kept as a string. If something upstream
 * already consumed it the read comes back empty, which is reported rather than papered
 * over - an empty body would silently fail verification and look like an attack.
 */
export async function readRawBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body terlalu besar');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
