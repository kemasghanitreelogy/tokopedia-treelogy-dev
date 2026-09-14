import { readDoc, writeDoc } from './store/index.js';

/**
 * Token persistence, in the shared state store.
 *
 * Both sides use this: the hosted callback writes the bundle after a successful exchange,
 * and the CLI, the server and the sweeps read it back. Which store that is - a SQLite
 * file on the VPS or Vercel Blob - is the store layer's business; `token` is accepted
 * for compatibility with older call sites and ignored.
 */

export const TOKENS_PATHNAME = 'tts/tokens.json';
/** Shopee bundles live beside the TikTok ones in the same store. */
export const SHOPEE_TOKENS_PATHNAME = 'shopee/tokens.json';

export class BlobNotConfiguredError extends Error {
  constructor() {
    super('penyimpanan state belum dikonfigurasi (STATE_DB_PATH atau BLOB_READ_WRITE_TOKEN)');
    this.name = 'BlobNotConfiguredError';
  }
}

/** @param {{tokens: object, nonce: string, shop?: object, token?: string, pathname?: string}} bundle */
export async function saveTokenBundle({ tokens, nonce, shop = null, pathname = TOKENS_PATHNAME }) {
  const bundle = { version: 1, saved_at: new Date().toISOString(), nonce, tokens, shop };
  await writeDoc(pathname, bundle);
  return bundle;
}

export async function loadTokenBundle({ pathname = TOKENS_PATHNAME } = {}) {
  return readDoc(pathname);
}
