import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshTokensOnce, resetRefreshGuard, applyTokens } from '../src/auth.js';

/**
 * TikTok rotates the refresh token on every refresh, so two refreshes started at once
 * rotate it twice and the first pair dies. Recovering from that means re-authorising
 * through Partner Center by hand, which is an outage rather than an inconvenience.
 */

const tokensFor = (n) => ({
  accessToken: `access-${n}`, refreshToken: `refresh-${n}`,
  accessTokenExpireAt: 2_000_000_000 + n, refreshTokenExpireAt: 3_000_000_000 + n,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test.beforeEach(() => resetRefreshGuard());

test('eight workers arriving at an expired token refresh it once between them', async () => {
  let calls = 0;
  const refresh = async () => { calls += 1; await settle(); return tokensFor(calls); };
  const persisted = [];
  const persist = async (_config, tokens) => { persisted.push(tokens.refreshToken); };

  // Each worker holds its own config, because loadConfig() hands out a new object.
  const configs = Array.from({ length: 8 }, () => ({ refreshToken: 'refresh-0', accessToken: 'access-0' }));
  await Promise.all(configs.map((config) => refreshTokensOnce(config, { refresh, persist })));

  assert.equal(calls, 1, 'satu penyegaran untuk semua, bukan delapan');
  assert.deepEqual(persisted, ['refresh-1']);
  // And every one of them walks away holding the pair that was actually stored.
  for (const config of configs) {
    assert.equal(config.accessToken, 'access-1');
    assert.equal(config.refreshToken, 'refresh-1');
    assert.equal(config.accessTokenExpireAt, 2_000_000_001);
  }
});

test('a later refresh is a new one, not the old promise served again', async () => {
  let calls = 0;
  const refresh = async () => { calls += 1; return tokensFor(calls); };
  const persist = async () => {};
  const config = { refreshToken: 'refresh-0' };

  await refreshTokensOnce(config, { refresh, persist });
  await refreshTokensOnce(config, { refresh, persist });
  assert.equal(calls, 2, 'token berikutnya tetap bisa disegarkan');
  assert.equal(config.refreshToken, 'refresh-2');
});

test('a failed refresh releases the guard instead of wedging every later caller', async () => {
  let calls = 0;
  const refresh = async () => {
    calls += 1;
    if (calls === 1) throw new Error('network');
    return tokensFor(calls);
  };
  const persist = async () => {};
  const config = { refreshToken: 'refresh-0' };

  await assert.rejects(() => refreshTokensOnce(config, { refresh, persist }), /network/);
  // Without releasing it, every request after the first blip would reuse a rejected
  // promise and the integration would stay down until the process restarted.
  await refreshTokensOnce(config, { refresh, persist });
  assert.equal(config.refreshToken, 'refresh-2');
});

test('everyone waiting on a failed refresh hears about it', async () => {
  const refresh = async () => { await settle(); throw new Error('ditolak TikTok'); };
  const persist = async () => {};
  const configs = [{ refreshToken: 'r' }, { refreshToken: 'r' }, { refreshToken: 'r' }];
  const outcomes = await Promise.allSettled(
    configs.map((config) => refreshTokensOnce(config, { refresh, persist })),
  );
  assert.ok(outcomes.every((o) => o.status === 'rejected'), 'tidak ada yang diam-diam dianggap berhasil');
});

test('applying a pair leaves the fields nobody sent alone', () => {
  const config = { openId: 'lama', sellerName: 'Toko', shopId: '123' };
  applyTokens(config, { accessToken: 'a', refreshToken: 'r', accessTokenExpireAt: 1, refreshTokenExpireAt: 2 });
  assert.equal(config.openId, 'lama');
  assert.equal(config.sellerName, 'Toko');
  assert.equal(config.shopId, '123');
  assert.equal(config.accessToken, 'a');
});
