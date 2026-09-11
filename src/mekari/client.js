import crypto from 'node:crypto';
import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';

/**
 * Mekari API client.
 *
 * Authentication is HTTP Signatures, not a bearer token: every request signs its own
 * Date header and request line with the client secret. The signing string is exactly
 *
 *   date: <RFC1123 GMT>\n<METHOD> <path-with-query> HTTP/1.1
 *
 * and the result goes into an Authorization header naming which headers were signed.
 * Because the date is part of the signature, a clock more than a few minutes out makes
 * every call fail - the same class of problem the Shopee integration hit.
 */

export const HOST = 'api.mekari.com';

export function loadMekariConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    clientId: get('MEKARI_APP_CLIENT_ID'),
    clientSecret: get('MEKARI_APP_CLIENT_SECRET'),
    host: get('MEKARI_HOST') || HOST,
  };
}

export const isMekariConfigured = (config = loadMekariConfig()) =>
  Boolean(config.clientId && config.clientSecret);

export class MekariError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'MekariError';
    this.status = status;
    this.body = body;
  }
}

/** RFC 1123 in GMT, which is what the signature is computed over. */
export const httpDate = (at = new Date()) => at.toUTCString();

export function signRequest({ method, path, date, clientId, clientSecret }) {
  const payload = `date: ${date}\n${method.toUpperCase()} ${path} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', clientSecret).update(payload, 'utf8').digest('base64');
  return {
    payload,
    header: `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`,
  };
}

const RETRY_DELAYS_MS = [400, 1000, 2400];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{method?: string, path: string, body?: object, config?: object}} request
 * `path` must include the query string: it is part of what gets signed.
 */
export async function mekari({ method = 'GET', path, body, config = loadMekariConfig() }) {
  if (!isMekariConfigured(config)) throw new MekariError('MEKARI_APP_CLIENT_ID / SECRET belum diisi');

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // The date is re-signed on every attempt; replaying a stale one would fail auth.
    const date = httpDate();
    const { header } = signRequest({
      method, path, date, clientId: config.clientId, clientSecret: config.clientSecret,
    });

    let response;
    try {
      response = await fetch(`https://${config.host}${path}`, {
        method,
        headers: {
          Authorization: header,
          Date: date,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      if (attempt === RETRY_DELAYS_MS.length) throw new MekariError(`tidak terjangkau: ${cause.message}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 300) };
    }

    // 5xx and 429 are transient. A 4xx is an answer - retrying it would only duplicate work.
    if ((response.status >= 500 || response.status === 429) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (!response.ok) {
      const detail = payload?.message ?? payload?.errors ?? payload?.raw ?? '';
      throw new MekariError(
        `${method} ${path} -> HTTP ${response.status}${detail ? `: ${JSON.stringify(detail).slice(0, 200)}` : ''}`,
        { status: response.status, body: payload },
      );
    }
    return payload;
  }

  throw new MekariError('gagal setelah beberapa percobaan');
}
