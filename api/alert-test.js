import { authenticate, parseCookies, COOKIE_NAME, csrfValid, readFormBody } from '../src/dashboard-auth.js';
import { raiseAlert } from '../src/alerts.js';
import { zoneForChannel, BENCH_CHANNEL } from '../src/clock.js';

/**
 * Prove the whole chain, from the browser, without a terminal.
 *
 * The bell in the top bar could only ever test this machine: it drew a card and rang, and
 * that answers "do the speakers work" and nothing else. The question an operator actually
 * has is different - does an alert *arrive* - and that one spans the webhook's process,
 * the store, the event stream and nginx. None of it can be tested from inside the page.
 *
 * So this raises a real alert through the real feed. What comes back comes back the way a
 * Shopee pickup would: down the same stream, into the same card, with the same sound. If
 * nothing appears, the failure is in the pipe, which is exactly what the operator wanted
 * to know and could not find out.
 *
 * Marked as a test in its own text, because an alert indistinguishable from a real parcel
 * is a worse thing to have than no test at all.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[COOKIE_NAME];
  const user = await authenticate(session);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }

  // The same token every other write on this dashboard carries. A doorbell anybody could
  // ring from another site is a doorbell that gets disabled.
  const form = await readFormBody(req, 4096).catch(() => null);
  if (!csrfValid(session, form?.get('csrf'))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }

  const at = new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit', minute: '2-digit', timeZone: zoneForChannel(BENCH_CHANNEL).name,
  });

  /*
   * A deploy presses this too, and nobody wants a popup and a chime on every deploy.
   * A silent press travels the identical path - same feed, same stream, same socket -
   * and is only skipped when the page goes to draw it. What the smoke test is proving
   * is that the alert arrives, and it reads that off the wire rather than off a screen.
   */
  const silent = form.get('silent') === '1';

  const raised = await raiseAlert({
    // Unique per press, so a second test is not swallowed as a repeat of the first.
    key: `test:${user.id}:${Date.now()}`,
    kind: silent ? 'smoke' : 'express',
    tone: 'act',
    title: 'UJI COBA — bukan pesanan sungguhan',
    href: '/api/dashboard?view=labels',
    data: {
      channelName: 'Uji', id: 'TES ' + at, tier: 'instant',
      courier: 'GoSend Instant Prioritas',
      buyer: `dites oleh ${user.name || user.email}`,
      total: '', items: 0, placedAt: at,
    },
  });

  console.log(`alert/test: diminta ${user.email} -> ${raised ? 'terkirim' : 'gagal'}`);

  if (!raised) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'umpan alert tidak bisa ditulis' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, id: raised.id }));
}
