import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSignatureBase, signRequest, buildSignedUrl } from '../src/sign.js';
import { parseEnv, updateEnv, readEnv } from '../src/env-file.js';
import { extractAuthCode, normalizeTokenPayload } from '../src/auth.js';
import { accessTokenExpired } from '../src/client.js';

const SECRET = 'test_secret';

test('signature base wraps app_secret around path and sorted params', () => {
  const base = buildSignatureBase({
    path: '/seller/202309/shops',
    query: { timestamp: '1700000000', app_key: 'abc' },
    body: '',
    appSecret: SECRET,
  });
  assert.equal(base, `${SECRET}/seller/202309/shopsapp_keyabctimestamp1700000000${SECRET}`);
});

test('signature base excludes sign and access_token', () => {
  const base = buildSignatureBase({
    path: '/p',
    query: { app_key: 'k', sign: 'SHOULD_NOT_APPEAR', access_token: 'SHOULD_NOT_APPEAR' },
    appSecret: SECRET,
  });
  assert.ok(!base.includes('SHOULD_NOT_APPEAR'));
  assert.equal(base, `${SECRET}/papp_keyk${SECRET}`);
});

test('signature base skips empty values but keeps the body', () => {
  const base = buildSignatureBase({
    path: '/p',
    query: { app_key: 'k', empty: '', missing: undefined, nulled: null },
    body: '{"a":1}',
    appSecret: SECRET,
  });
  assert.equal(base, `${SECRET}/papp_keyk{"a":1}${SECRET}`);
});

test('signature is HMAC-SHA256 hex over that base', () => {
  const query = { app_key: 'k', timestamp: '1' };
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(buildSignatureBase({ path: '/p', query, appSecret: SECRET }), 'utf8')
    .digest('hex');
  assert.equal(signRequest({ path: '/p', query, appSecret: SECRET }), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test('signed URL carries every param plus sign', () => {
  const url = new URL(
    buildSignedUrl({
      baseUrl: 'https://example.test',
      path: '/seller/202309/shops',
      query: { app_key: 'k', timestamp: '1' },
      appSecret: SECRET,
    }),
  );
  assert.equal(url.pathname, '/seller/202309/shops');
  assert.equal(url.searchParams.get('app_key'), 'k');
  assert.match(url.searchParams.get('sign'), /^[0-9a-f]{64}$/);
});

test('env parsing strips quotes and ignores comments', () => {
  const parsed = parseEnv('# note\nA=1\nB="two words"\n\nC=\'three\'\nnot_a_pair\n');
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'three' });
});

test('env update rewrites in place, appends new keys, and preserves comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# keep me\nAPP_KEY=old\nAPP_SECRET=secret\n');

  updateEnv(path, { APP_KEY: 'new', ACCESS_TOKEN: 'token123' });
  const text = readFileSync(path, 'utf8');

  assert.ok(text.includes('# keep me'), 'comment survived');
  assert.ok(text.includes('APP_KEY=new'), 'existing key rewritten in place');
  assert.ok(text.includes('APP_SECRET=secret'), 'untouched key preserved');
  assert.ok(text.includes('ACCESS_TOKEN=token123'), 'new key appended');
  assert.equal(readEnv(path).APP_KEY, 'new');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'written with owner-only permissions');
});

test('env update quotes values containing whitespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tts-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, 'SHOP_NAME=\n');
  updateEnv(path, { SHOP_NAME: 'Treelogy Moringa' });
  assert.equal(readEnv(path).SHOP_NAME, 'Treelogy Moringa');
});

test('auth code is extracted from a redirect URL or passed through', () => {
  assert.equal(
    extractAuthCode('https://treelogy-hr-system.vercel.app/tokopedia-reviews?code=ROW_abc&state=xyz'),
    'ROW_abc',
  );
  assert.equal(extractAuthCode('  ROW_bare_code  '), 'ROW_bare_code');
  assert.equal(extractAuthCode('https://example.test/no-code'), '');
});

test('token expiry accepts absolute timestamps and relative TTLs', () => {
  const now = Math.floor(Date.now() / 1000);
  const absolute = normalizeTokenPayload({ access_token_expire_in: now + 3600 });
  assert.equal(absolute.accessTokenExpireAt, now + 3600);

  const relative = normalizeTokenPayload({ access_token_expire_in: 3600 });
  assert.ok(Math.abs(relative.accessTokenExpireAt - (now + 3600)) <= 2);
});

test('access token is treated as expired inside the skew window', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(accessTokenExpired({ accessTokenExpireAt: now + 3600 }), false);
  assert.equal(accessTokenExpired({ accessTokenExpireAt: now + 10 }), true, 'within 60s skew');
  assert.equal(accessTokenExpired({ accessTokenExpireAt: now - 10 }), true);
  assert.equal(accessTokenExpired({ accessTokenExpireAt: 0 }), false, 'unknown expiry is not expired');
});
