import { put, get } from '@vercel/blob';

/**
 * Token persistence backed by a private Vercel Blob store (`tts-tokens`).
 *
 * Both sides use this: the serverless callback writes the bundle after a successful
 * exchange, and the local CLI reads it back. `access: 'private'` means the blob is not
 * reachable by URL - every read is authenticated with BLOB_READ_WRITE_TOKEN.
 */

export const TOKENS_PATHNAME = 'tts/tokens.json';
/** Shopee bundles live beside the TikTok ones in the same private store. */
export const SHOPEE_TOKENS_PATHNAME = 'shopee/tokens.json';

export class BlobNotConfiguredError extends Error {
  constructor() {
    super('BLOB_READ_WRITE_TOKEN is not set - link the blob store to this project');
    this.name = 'BlobNotConfiguredError';
  }
}

/**
 * On Vercel the token is injected into the environment. Locally it comes from
 * .env.local, which `vercel blob create-store` / `vercel env pull` writes.
 */
function resolveToken(explicit) {
  const token = explicit || process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new BlobNotConfiguredError();
  return token;
}

/** @param {{tokens: object, nonce: string, shop?: object, token?: string, pathname?: string}} bundle */
export async function saveTokenBundle({ tokens, nonce, shop = null, token, pathname = TOKENS_PATHNAME }) {
  const blobToken = resolveToken(token);
  const bundle = {
    version: 1,
    saved_at: new Date().toISOString(),
    nonce,
    tokens,
    shop,
  };
  await put(pathname, JSON.stringify(bundle, null, 2), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    token: blobToken,
    // Tokens change on every refresh; caching a stale bundle would be a correctness bug.
    cacheControlMaxAge: 0,
  });
  return bundle;
}

export async function loadTokenBundle({ token, pathname = TOKENS_PATHNAME } = {}) {
  const blobToken = resolveToken(token);
  const result = await get(pathname, {
    access: 'private',
    useCache: false,
    token: blobToken,
  });
  if (!result) return null;

  const text = await new Response(result.stream).text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Stored token bundle at ${pathname} is not valid JSON`);
  }
}
