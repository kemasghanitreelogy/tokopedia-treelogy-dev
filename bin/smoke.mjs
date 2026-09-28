#!/usr/bin/env node
import http from 'node:http';
import { issueSession, COOKIE_NAME, csrfToken } from '../src/dashboard-auth.js';
import { ownerUser } from '../src/users.js';
import { VALID_VIEWS } from '../src/dashboard-page.js';
import { backendName, updateDoc, closeStore } from '../src/store/index.js';
import { ALERTS_DOC } from '../src/alerts.js';

/**
 * What the deploy asks the running service before it calls a deploy good.
 *
 * `npm test` proves the code is self-consistent and the health check proves the process
 * answers. Between those two there is a gap wide enough to have shipped two real faults
 * green in a single afternoon.
 *
 * The router used to end any response whose handler had returned, which closed the event
 * stream the instant it opened: every dashboard connected, drew whatever was already
 * waiting, and went deaf. The unit tests called the handlers directly, so they never
 * crossed the line that did it. And a leftover token routed a command into a Vercel Blob
 * store that has been suspended since September, on a box where the state is in Redis.
 *
 * Neither is a bug in a function. Both are bugs in the assembly - the router, the
 * process, the environment - and only a running service can be asked about those. So
 * this is a black-box client: it signs in over HTTP like a browser, opens the pages a
 * person opens, and holds the stream open to see whether something raised afterwards
 * actually arrives.
 *
 * It costs no marketplace and no Jurnal quota. The alert it raises is marked as a
 * deploy's own, so no dashboard draws it and nobody's bench chimes at three in the
 * morning; it is proved on the wire and then removed from the feed.
 */

const HOST = process.env.SMOKE_HOST || '127.0.0.1';
const PORT = Number(process.env.SMOKE_PORT) || Number(process.env.PORT) || 3000;
/** Generous: a cold page can read the database, and a deploy would rather wait than lie. */
const TIMEOUT_MS = 20_000;
/** The stream has the emitter for this; five seconds is already the slow path. */
const ALERT_WAIT_MS = 6_000;

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'GAGAL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function request(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method, headers, timeout: TIMEOUT_MS }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('timeout', () => req.destroy(new Error(`lewat ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

/** Open the stream, run `while` with it held, and return everything it said. */
function withStream(cookie, while_) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const req = http.request({ host: HOST, port: PORT, path: '/api/events', headers: { Cookie: cookie } }, async (res) => {
      if (res.statusCode !== 200) {
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body: '' });
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      try {
        await while_();
      } catch (error) {
        req.destroy();
        reject(error);
        return;
      }
      setTimeout(() => {
        if (settled) return;
        settled = true;
        req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, body });
      }, ALERT_WAIT_MS);
    });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    req.end();
  });
}

const owner = ownerUser();
if (!owner) {
  console.error('smoke: DASHBOARD_EMAIL belum diisi - tidak bisa menguji sebagai siapa pun');
  process.exit(1);
}
const token = await issueSession(owner);
const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
const csrf = csrfToken(token);

console.log(`\nsmoke: ${HOST}:${PORT}\n`);

/* ---------------------------------------------------------------- the process */

try {
  const status = await request('/api/status');
  check('layanan menjawab', status.status === 200, `HTTP ${status.status}`);
} catch (error) {
  check('layanan menjawab', false, error.message);
}

// The state this box is supposed to be on. A leftover token once routed a command into a
// Blob store that has been suspended since September; the service reading the wrong store
// is the same failure with the whole dashboard behind it.
check('state pakai backend yang benar', backendName() === (process.env.SMOKE_BACKEND || 'redis'), `terbaca ${backendName()}`);

/* ------------------------------------------------------------------- the pages */

// Signed out, the dashboard is a login page and not the dashboard. Checked because an
// auth regression is invisible to anybody already holding a cookie.
try {
  const out = await request('/api/dashboard?view=orders');
  const isLogin = out.status === 200 && /name="password"/.test(out.text);
  check('tanpa sesi hanya halaman masuk', isLogin, `HTTP ${out.status}`);
} catch (error) {
  check('tanpa sesi hanya halaman masuk', false, error.message);
}

for (const view of Object.keys(VALID_VIEWS)) {
  try {
    const out = await request(`/api/dashboard?view=${view}`, { headers: { Cookie: cookie } });
    // A page that throws half way still answers 200 with a truncated body, so the closing
    // tag is what says it finished.
    const whole = out.status === 200 && out.text.trimEnd().endsWith('</html>');
    check(`halaman ${view}`, whole, `HTTP ${out.status}, ${out.text.length} byte`);
  } catch (error) {
    check(`halaman ${view}`, false, error.message);
  }
}

/* ------------------------------------------------------------------ the stream */

try {
  const stream = await withStream(cookie, async () => {
    // Raised only once the stream is open, so what is being proved is live delivery and
    // not the backlog that a connection replays. Reading the backlog as delivery is
    // exactly the mistake that let a dead stream pass for working.
    const body = new URLSearchParams({ csrf, silent: '1' }).toString();
    const pressed = await request('/api/alert-test', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    check('alert bisa dibunyikan', pressed.status === 200, `HTTP ${pressed.status}`);
  });

  check('stream terbuka sebagai event-stream', /text\/event-stream/.test(stream.headers?.['content-type'] ?? ''), `HTTP ${stream.status}`);
  check('stream tidak di-buffer proxy', stream.headers?.['x-accel-buffering'] === 'no');
  check('alert hidup sampai ke stream', /"kind":"smoke"/.test(stream.body), `${(stream.body.match(/event: alert/g) ?? []).length} event`);
} catch (error) {
  check('alert hidup sampai ke stream', false, error.message);
}

/* ------------------------------------------------------------------- tidying up */

try {
  await updateDoc(ALERTS_DOC, (current) => ({
    ...(current ?? { version: 1, seq: 0, alerts: [] }),
    alerts: (current?.alerts ?? []).filter((a) => a.kind !== 'smoke'),
  }), { version: 1, seq: 0, alerts: [] });
} catch { /* a feed entry that outlives this expires on its own within two hours */ }

await closeStore().catch(() => {});

console.log(`\nsmoke: ${results.length - failures}/${results.length} lolos\n`);
process.exit(failures > 0 ? 1 : 0);
