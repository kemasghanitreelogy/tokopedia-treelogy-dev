import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * The bell, end to end, over a real socket.
 *
 * The question it answers for an operator is not "do the speakers work" - a card drawn
 * locally would answer that - but "does an alert arrive", which spans the server, the
 * store, the event stream and nginx. So the test does what the button does: press it,
 * then watch the stream for what comes back.
 */

process.env.ALERT_POLL_MS = '150';
process.env.DASHBOARD_EMAIL = 'uji@treelogy.test';
process.env.DASHBOARD_PASSWORD = 'rahasia-uji';
process.env.DASHBOARD_TOKEN = 'kunci-penandatangan-uji-yang-panjang';

const { default: events } = await import('../api/events.js');
const { default: alertTest } = await import('../api/alert-test.js');
const { issueSession, COOKIE_NAME, csrfToken } = await import('../src/dashboard-auth.js');
const { ownerUser } = await import('../src/users.js');
const { clearAlerts } = await import('../src/alerts.js');
const { closeStore } = await import('../src/store/index.js');

/*
 * The router's own behaviour, not just the handlers'.
 *
 * The first cut of this called the handlers directly, and that is precisely how a real
 * bug survived it: server.js ends any response whose handler has returned, and the event
 * stream returns with its socket deliberately open. Live delivery was dead in production
 * while every test passed, because the tests never went through the line that killed it.
 *
 * So this mirrors server.js, including the end-if-not-ended.
 */
const server = http.createServer(async (req, res) => {
  req.setTimeout(0);
  const handler = req.url.startsWith('/api/alert-test') ? alertTest : events;
  await handler(req, res);
  if (!res.writableEnded && !res.streaming) res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const token = await issueSession(ownerUser());
const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}`;
const csrf = csrfToken(token);

test.after(async () => { server.close(); await closeStore(); });

function press({ cookie: c = cookie, csrf: t = csrf } = {}) {
  const body = new URLSearchParams({ csrf: t }).toString();
  return new Promise((resolve) => {
    const req = http.request({
      port, host: '127.0.0.1', path: '/api/alert-test', method: 'POST',
      headers: { Cookie: c, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let text = '';
      res.on('data', (c2) => { text += c2; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.end(body);
  });
}

function listen({ ms = 2500 } = {}) {
  return new Promise((resolve) => {
    let body = '';
    const req = http.request({ port, host: '127.0.0.1', path: '/api/events', headers: { Cookie: cookie } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if ((body.match(/^data: .*$/gm) ?? []).length >= 1) done();
      });
    });
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); req.destroy(); resolve(body); }
    req.end();
  });
}

test('the stream survives its handler returning', async () => {
  // server.js ends a response whose handler has returned. This one returns with the socket
  // open on purpose; without the flag it went silent immediately after its backlog, which
  // is exactly how it behaved in production while the tests were green.
  await clearAlerts();
  const stream = listen({ ms: 1200 });
  await new Promise((r) => setTimeout(r, 400));
  // Raised well after the handler returned: if the socket had been closed, nothing lands.
  await press();
  assert.match(await stream, /event: alert/);
});

test('pressing the bell puts a real alert down the real stream', async () => {
  await clearAlerts();
  const stream = listen();
  await new Promise((r) => setTimeout(r, 120));

  const pressed = await press();
  assert.equal(pressed.status, 200);

  const [event] = [...(await stream).matchAll(/data: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  assert.match(event.title, /UJI COBA/, 'ditandai uji, supaya tak tertukar dengan parcel sungguhan');
  assert.equal(event.data.tier, 'instant', 'tier yang berbunyi, karena itu yang sedang diuji');
  assert.equal(event.data.courier, 'GoSend Instant Prioritas');
  assert.match(event.data.buyer, /dites oleh/);
});

test('two presses are two alerts, not one swallowed as a repeat', async () => {
  await clearAlerts();
  const first = await press();
  const second = await press();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(JSON.parse(first.text).id, JSON.parse(second.text).id);
});

test('a stranger cannot ring the bench', async () => {
  assert.equal((await press({ cookie: '' })).status, 401);
  assert.equal((await press({ csrf: 'bukan-token' })).status, 403);
});

test('GET does not ring it either', async () => {
  const status = await new Promise((resolve) => {
    http.get({ port, host: '127.0.0.1', path: '/api/alert-test', headers: { Cookie: cookie } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(status, 405);
});
