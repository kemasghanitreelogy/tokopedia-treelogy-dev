import { authenticate, parseCookies, COOKIE_NAME } from '../src/dashboard-auth.js';
import { alertBus, alertsSince } from '../src/alerts.js';

/**
 * The open pipe that lets the dashboard be told rather than asked.
 *
 * Server-sent events, not websockets: this is one-way, it is text, and it reconnects by
 * itself with the last id it saw. A websocket would be a second protocol through nginx
 * and a second thing to get wrong, in exchange for an upstream channel nothing needs.
 *
 * Three things keep it alive through a proxy. `X-Accel-Buffering: no` turns off nginx's
 * response buffering for this response only - without it nginx holds each event until its
 * buffer fills, which for a doorbell means holding it until it no longer matters. A
 * comment line every twenty-five seconds keeps the connection from being reaped as idle,
 * comfortably inside the sixty-second default and the six hundred configured here. And
 * `retry:` tells the browser how soon to come back, so a restarted service refills the
 * dashboards within a couple of seconds rather than whenever EventSource feels like it.
 *
 * Polling sits behind the emitter rather than instead of it. The emitter covers the
 * common case - a webhook lands in this very process and the browser hears about it in
 * milliseconds - and the poll covers the rest: an alert raised by the sweep, which runs
 * as its own unit and shares nothing but the store.
 */

const HEARTBEAT_MS = 25_000;
/**
 * How often the store is re-read for alerts raised elsewhere.
 *
 * Overridable only so a test can watch the cross-process path complete in milliseconds
 * instead of seconds. Production never sets it, and the default is what runs.
 */
const POLL_MS = Number(process.env.ALERT_POLL_MS) || 5_000;
/** Long enough to outlive a deploy, short enough that a hung socket is not forever. */
const MAX_LIFETIME_MS = 30 * 60_000;

const send = (res, event) => {
  res.write(`id: ${event.id}\n`);
  res.write(`event: alert\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('method not allowed');
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const user = await authenticate(cookies[COOKIE_NAME]);
  if (!user) {
    // 401 rather than a redirect: EventSource cannot follow one, and a login page
    // arriving as an event stream would only make the browser retry it for ever.
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  // Node buffers small writes by default; a doorbell cannot wait for a full packet.
  res.socket?.setNoDelay?.(true);

  // Where this browser got to. EventSource replays it on every reconnect, so a dropped
  // connection costs nothing; a cold tab sends nothing and gets whatever is still live.
  const header = String(req.headers['last-event-id'] ?? '');
  let lastId = Number.isFinite(Number(header)) ? Number(header) : 0;
  if (!header) {
    const asked = Number(new URL(req.url, 'http://x').searchParams.get('since'));
    if (Number.isFinite(asked) && asked > 0) lastId = asked;
  }

  let closed = false;
  const push = (event) => {
    if (closed || Number(event.id) <= lastId) return;
    lastId = Number(event.id);
    send(res, event);
  };

  const backlog = await alertsSince(lastId).catch(() => []);
  for (const event of backlog) push(event);

  alertBus.on('alert', push);

  const poll = setInterval(async () => {
    if (closed) return;
    for (const event of await alertsSince(lastId).catch(() => [])) push(event);
  }, POLL_MS);

  const beat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // Ended on purpose, so a socket that somehow outlives its usefulness is not immortal.
  // The browser reconnects on its own; the person at the bench notices nothing.
  const life = setTimeout(() => { if (!closed) res.end(); }, MAX_LIFETIME_MS);

  const stop = () => {
    if (closed) return;
    closed = true;
    alertBus.off('alert', push);
    clearInterval(poll);
    clearInterval(beat);
    clearTimeout(life);
  };

  for (const timer of [poll, beat, life]) timer.unref?.();

  /*
   * The response, not the request.
   *
   * `req` emits 'close' when the *request* is complete, and a GET has no body - so it
   * fired immediately, tore down the poll and unsubscribed from the bus while the socket
   * stayed happily open. The stream looked alive: it connected, it replayed its backlog,
   * and then it was deaf for ever. Caught against production, where an alert raised by a
   * second process never arrived although it was plainly in the store.
   *
   * `res` emits 'close' when the response finishes or the connection goes away, and this
   * response only finishes when we end it. That is the signal meant here.
   */
  res.on('close', stop);
  res.on('error', stop);
}
