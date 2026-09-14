import test from 'node:test';
import assert from 'node:assert/strict';
import { persistTokens, hydrateFromBundle } from '../src/auth.js';
import { deleteDoc } from '../src/store/index.js';
import { TOKENS_PATHNAME } from '../src/token-store.js';

const tokens = {
  accessToken: 'akses-baru', refreshToken: 'segar-baru',
  accessTokenExpireAt: 1_800_000_000, refreshTokenExpireAt: 1_900_000_000,
};

test('a refresh that cannot write .env still updates the config and does not throw', async () => {
  // On Vercel there is no .env and the filesystem is read-only. The refresh that just
  // rotated the token must not be reported as a failure because a convenience copy could
  // not be written - the token would then be lost on both sides.
  const config = { envPath: '/nonexistent/dir/.env' };
  await persistTokens(config, tokens, { saveBundle: false });
  assert.equal(config.accessToken, 'akses-baru');
  assert.equal(config.refreshToken, 'segar-baru');
  assert.equal(config.accessTokenExpireAt, 1_800_000_000);
});

test('with nothing stored the config is left exactly as .env described it', async () => {
  await deleteDoc(TOKENS_PATHNAME);
  const config = { accessToken: 'lama', refreshToken: 'lama-r', accessTokenExpireAt: 1 };
  const same = await hydrateFromBundle(config);
  assert.equal(same.accessToken, 'lama');
  assert.equal(same.refreshToken, 'lama-r');
});

test('a stored bundle wins over .env, because every refresh lands in the store', async () => {
  const config = { accessToken: 'lama', refreshToken: 'lama-r', accessTokenExpireAt: 1 };
  await persistTokens({ envPath: '/nonexistent/.env' }, tokens);
  const hydrated = await hydrateFromBundle(config);
  assert.equal(hydrated.refreshToken, 'segar-baru');
  assert.equal(hydrated.accessTokenExpireAt, 1_800_000_000);
  await deleteDoc(TOKENS_PATHNAME);
});
