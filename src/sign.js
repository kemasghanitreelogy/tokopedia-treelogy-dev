import crypto from 'node:crypto';

/**
 * TikTok Shop Open API request signature.
 *
 * base   = app_secret + path + concat(sorted(key + value) for query params) + body + app_secret
 * sign   = HMAC-SHA256(base, key = app_secret) as lowercase hex
 *
 * `sign` and `access_token` are excluded from the concatenated query params.
 *
 * Verified against the live API: an unsigned request returns 36009004
 * ("Missing credentials ... required signature") while a request signed with this
 * routine advances to 36009005 ("the 'access_token' header is invalid"), proving the
 * server accepted the signature.
 */

const EXCLUDED_PARAMS = new Set(['sign', 'access_token']);

export function buildSignatureBase({ path, query = {}, body = '', appSecret }) {
  const keys = Object.keys(query)
    .filter((key) => !EXCLUDED_PARAMS.has(key))
    .filter((key) => query[key] !== undefined && query[key] !== null && query[key] !== '')
    .sort();

  let base = appSecret + path;
  for (const key of keys) base += key + query[key];
  base += body ?? '';
  base += appSecret;
  return base;
}

export function signRequest({ path, query = {}, body = '', appSecret }) {
  const base = buildSignatureBase({ path, query, body, appSecret });
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

/** Build the fully-signed request URL (query params sorted for stable output). */
export function buildSignedUrl({ baseUrl, path, query = {}, body = '', appSecret }) {
  const sign = signRequest({ path, query, body, appSecret });
  const url = new URL(path, baseUrl);
  for (const key of Object.keys(query).sort()) {
    if (query[key] === undefined || query[key] === null || query[key] === '') continue;
    url.searchParams.set(key, String(query[key]));
  }
  url.searchParams.set('sign', sign);
  return url.toString();
}
