import test from 'node:test';
import assert from 'node:assert/strict';
import { persistTokens, hydrateFromBundle } from '../src/auth.js';

const tokens = {
  accessToken: 'akses-baru', refreshToken: 'segar-baru',
  accessTokenExpireAt: 1_800_000_000, refreshTokenExpireAt: 1_900_000_000,
};

test('a refresh that cannot write .env still updates the config and does not throw', async () => {
  // On Vercel there is no .env and the filesystem is read-only. The refresh that just
  // rotated the token must not be reported as a failure because a convenience copy could
  // not be written - the token would then be lost on both sides.
  const config = { envPath: '/nonexistent/dir/.env', blobToken: '' };
  await persistTokens(config, tokens);
  assert.equal(config.accessToken, 'akses-baru');
  assert.equal(config.refreshToken, 'segar-baru');
  assert.equal(config.accessTokenExpireAt, 1_800_000_000);
});

test('without a Blob token the config is left exactly as .env described it', async () => {
  const config = { accessToken: 'lama', refreshToken: 'lama-r', accessTokenExpireAt: 1, blobToken: '' };
  const same = await hydrateFromBundle(config);
  assert.equal(same.accessToken, 'lama');
  assert.equal(same.refreshToken, 'lama-r');
});

test('an unreachable or empty bundle never clobbers working local tokens', async () => {
  // A bogus Blob token makes the read fail; hydration must swallow that and keep .env.
  const config = { accessToken: 'lama', refreshToken: 'lama-r', accessTokenExpireAt: 1, blobToken: 'vercel_blob_rw_bogus' };
  const same = await hydrateFromBundle(config);
  assert.equal(same.refreshToken, 'lama-r');
});
