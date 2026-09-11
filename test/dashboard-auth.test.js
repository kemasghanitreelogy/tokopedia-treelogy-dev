import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCookies, credentialsMatch, tokenMatches, isConfigured, issueSession, sessionValid,
  sessionCookie, clearedCookie, safeRedirect, isLockedOut, csrfToken, csrfValid,
  COOKIE_NAME, MAX_ATTEMPTS,
} from '../src/dashboard-auth.js';

const withCreds = (email, password, signingKey, fn) => {
  const before = {
    e: process.env.DASHBOARD_EMAIL, p: process.env.DASHBOARD_PASSWORD, t: process.env.DASHBOARD_TOKEN,
  };
  process.env.DASHBOARD_EMAIL = email;
  process.env.DASHBOARD_PASSWORD = password;
  process.env.DASHBOARD_TOKEN = signingKey;
  try {
    return fn();
  } finally {
    for (const [key, value] of [['DASHBOARD_EMAIL', before.e], ['DASHBOARD_PASSWORD', before.p], ['DASHBOARD_TOKEN', before.t]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const SIGNING = 'a-long-random-signing-key-not-typed-by-anyone';

test('cookies parse into a jar, ignoring malformed pairs', () => {
  const jar = parseCookies('a=1; omni_session=abc%3Ddef; broken; b=2');
  assert.equal(jar.omni_session, 'abc=def');
  assert.equal(jar.broken, undefined);
});

test('both email and password must match', () => {
  withCreds('kemas@treelogy.com', 'hunter2', SIGNING, () => {
    assert.equal(credentialsMatch('kemas@treelogy.com', 'hunter2'), true);
    assert.equal(credentialsMatch('kemas@treelogy.com', 'wrong'), false);
    assert.equal(credentialsMatch('other@treelogy.com', 'hunter2'), false);
    assert.equal(credentialsMatch('', ''), false);
  });
});

test('the email is matched case- and whitespace-insensitively, the password is not', () => {
  withCreds('kemas@treelogy.com', 'Secret', SIGNING, () => {
    assert.equal(credentialsMatch('  KEMAS@Treelogy.com  ', 'Secret'), true);
    assert.equal(credentialsMatch('kemas@treelogy.com', 'secret'), false);
  });
});

test('an unconfigured dashboard authenticates nobody', () => {
  withCreds('', '', '', () => {
    assert.equal(isConfigured(), false);
    assert.equal(credentialsMatch('', ''), false);
    assert.equal(tokenMatches(''), false);
    assert.equal(sessionValid('anything'), false);
  });
});

test('the bookmark token is the signing key, not the password', () => {
  withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    assert.equal(tokenMatches(SIGNING), true);
    assert.equal(tokenMatches('123'), false);
  });
});

test('a session cannot be forged by signing with the password', async () => {
  // The whole point: with a weak password, HMAC-keyed-by-password would be arithmetic.
  const crypto = await import('node:crypto');
  const forged = withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    const payload = `${crypto.randomBytes(16).toString('hex')}.${Math.floor(Date.now() / 1000) + 3600}`;
    const mac = crypto.createHmac('sha256', '123').update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${mac}`;
  });
  withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    assert.equal(sessionValid(forged), false);
  });
});

test('an issued session verifies, and a tampered one does not', () => {
  withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    const token = issueSession();
    assert.equal(sessionValid(token), true);
    assert.equal(sessionValid(token.slice(0, -2) + 'xx'), false);
  });
});

test('changing the password invalidates outstanding sessions', () => {
  const token = withCreds('kemas@treelogy.com', 'old', SIGNING, () => issueSession());
  withCreds('kemas@treelogy.com', 'new', SIGNING, () => assert.equal(sessionValid(token), false));
});

test('changing the email also invalidates outstanding sessions', () => {
  const token = withCreds('a@treelogy.com', 'same', SIGNING, () => issueSession());
  withCreds('b@treelogy.com', 'same', SIGNING, () => assert.equal(sessionValid(token), false));
});

test('the session cookie is HttpOnly, Secure and SameSite', () => {
  withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    const cookie = sessionCookie(issueSession());
    assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      assert.ok(cookie.includes(flag), `missing ${flag}`);
    }
  });
});

test('logging out sends an immediately expiring cookie', () => {
  assert.ok(clearedCookie().includes('Max-Age=0'));
});

test('lockout is active only while the window has not passed', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isLockedOut({ count: MAX_ATTEMPTS, lockedUntil: now + 60 }), true);
  assert.equal(isLockedOut({ count: MAX_ATTEMPTS, lockedUntil: now - 60 }), false);
  assert.equal(isLockedOut({ count: 1, lockedUntil: 0 }), false);
});

test('redirects are rebuilt from validated params, never reflected', () => {
  assert.equal(safeRedirect('/api/dashboard', { preset: '7d' }), '/api/dashboard?preset=7d');
  assert.equal(safeRedirect('/api/dashboard', { next: 'https://evil.example' }), '/api/dashboard');
});

test('a preset redirect never also carries from/to', () => {
  assert.equal(
    safeRedirect('/api/dashboard', { preset: '7d', from: '2026-09-01', to: '2026-09-08' }),
    '/api/dashboard?preset=7d',
  );
});

test('a CSRF token is bound to its session and rejects others', () => {
  withCreds('kemas@treelogy.com', '123', SIGNING, () => {
    const a = issueSession();
    const b = issueSession();
    assert.equal(csrfValid(a, csrfToken(a)), true);
    assert.equal(csrfValid(a, csrfToken(b)), false);
    assert.equal(csrfValid(a, 'forged'), false);
    assert.equal(csrfValid('', csrfToken(a)), false);
    assert.equal(csrfValid(a, ''), false);
  });
});
