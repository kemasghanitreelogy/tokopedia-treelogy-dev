import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The pipe itself, over a real socket.
 *
 * Everything here was found against production rather than reasoned about. The stream
 * connected, replayed its backlog and then went deaf: `req.on('close')` fires as soon as
 * the *request* is complete, and a GET has no body, so the teardown ran instantly while
 * the socket stayed open. Nothing in the unit tests could see that, because the bug was
 * in which event means "the browser went away".
 */

// Fast enough to watch the cross-process path finish inside a test. Set before the
// handler is imported, because it reads the interval once at module load.
process.env.ALERT_POLL_MS = '150';
process.env.DASHBOARD_EMAIL = 'uji@treelogy.test';
process.env.DASHBOARD_PASSWORD = 'rahasia-uji';
process.env.DASHBOARD_TOKEN = 'kunci-penandatangan-uji-yang-panjang';

const { default: handler } = await import('../api/events.js');
const { issueSession, COOKIE_NAME } = await import('../src/dashboard-auth.js');
const { ownerUser } = await import('../src/users.js');
const { raiseAlert, clearAlerts, ALERTS_DOC } = await import('../src/alerts.js');
const { updateDoc, closeStore } = await import('../src/store/index.js');

const server = http.createServer((req, res) => { req.setTimeout(0); handler(req, res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const cookie = `${COOKIE_NAME}=${encodeURIComponent(await issueSession(ownerUser()))}`;

test.after(async () => { server.close(); await closeStore(); });

/** Open a stream and collect what arrives, until `want` events or the deadline. */
function listen({ want = 1, ms = 3000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let body = '';
    const req = http.request({ port, host: '127.0.0.1', path: '/api/events', headers: { Cookie: cookie, ...headers } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        // Counted on the payload line, not on "event: alert". An event arrives as three
        // separate writes and the first cut resolved on the second of them, so the test
        // read a body that did not have its own data in it yet.
        if (want > 0 && (body.match(/^data: .*$/gm) ?? []).length >= want) done();
      });
    });
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      req.destroy();
      resolve(body);
    }
    req.end();
  });
}

const events = (body) => [...body.matchAll(/data: (.*)\n/g)].map((m) => JSON.parse(m[1]));

test('a stream without a session is refused, not redirected', async () => {
  const status = await new Promise((resolve) => {
    http.get({ port, host: '127.0.0.1', path: '/api/events' }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  // EventSource cannot follow a redirect; a login page as an event stream would only be
  // retried for ever.
  assert.equal(status, 401);
});

test('it opens as an event stream that no proxy may buffer', async () => {
  const headers = await new Promise((resolve) => {
    const req = http.request({ port, host: '127.0.0.1', path: '/api/events', headers: { Cookie: cookie } }, (res) => {
      req.destroy();
      resolve(res.headers);
    });
    req.end();
  });
  assert.match(headers['content-type'], /text\/event-stream/);
  // Without this nginx holds each event until its buffer fills, which for a doorbell
  // means holding it until it no longer matters.
  assert.equal(headers['x-accel-buffering'], 'no');
});

test('an alert raised in this process arrives at once', async () => {
  await clearAlerts();
  const stream = listen({ want: 1 });
  await new Promise((r) => setTimeout(r, 120));
  await raiseAlert({ key: 'k-bus', kind: 'express', title: 'lewat bus', data: { id: 'A' } });

  const [event] = events(await stream);
  assert.equal(event.title, 'lewat bus');
  assert.ok(event.id > 0, 'membawa id supaya bisa disambung lagi');
});

test('an alert raised by another process arrives too', async () => {
  await clearAlerts();
  const stream = listen({ want: 1 });
  await new Promise((r) => setTimeout(r, 120));

  /*
   * Written straight to the store, deliberately bypassing the in-process emitter: that
   * is exactly what the sweep does, running as its own systemd unit. This is the path
   * that was silently dead - the stream connected and then heard nothing for ever.
   */
  await updateDoc(ALERTS_DOC, (current) => ({
    version: 1, seq: 99,
    alerts: [...(current?.alerts ?? []), { id: 99, at: Date.now(), kind: 'express', title: 'dari proses lain', data: { id: 'B' } }],
  }), { version: 1, seq: 0, alerts: [] });

  const [event] = events(await stream);
  assert.equal(event.title, 'dari proses lain');
});

test('a browser that reconnects is not shown what it already saw', async () => {
  await clearAlerts();
  const first = await raiseAlert({ key: 'k1', kind: 'express', title: 'lama' });
  await raiseAlert({ key: 'k2', kind: 'express', title: 'baru' });

  const body = await listen({ want: 1, ms: 800, headers: { 'Last-Event-ID': String(first.id) } });
  const seen = events(body).map((e) => e.title);
  assert.deepEqual(seen, ['baru'], 'hanya yang belum pernah dikirim');
});

test('the stream says how soon to come back, so a deploy refills the dashboards', async () => {
  const body = await listen({ want: 0, ms: 400 });
  assert.match(body, /^retry: 3000/);
});
