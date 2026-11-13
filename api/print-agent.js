import { timingSafeEqual } from 'node:crypto';
import { takeJob, finishJob, touchAgent } from '../src/print-queue.js';

/**
 * The bench agent's door.
 *
 * GET  /api/print-agent?wait=20  the next job, or 204 after waiting up to `wait` seconds
 * POST /api/print-agent          { id, status: 'done'|'failed', error? } or { heartbeat: true }
 *
 * The agent is not a person and has no session; it carries PRINT_AGENT_TOKEN from the
 * server's environment as a bearer token. Compared in constant time, and a server
 * without the token answers 503 rather than letting anyone in.
 */

const MAX_WAIT_S = 25;
const POLL_MS = 700;

export function agentAuthorized(header, token = process.env.PRINT_AGENT_TOKEN) {
  if (!token || token.length < 16) return null;
  const given = String(header ?? '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body terlalu besar')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export default async function handler(req, res) {
  const json = (status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const auth = agentAuthorized(req.headers.authorization);
  if (auth === null) { json(503, { error: 'PRINT_AGENT_TOKEN belum disetel di server' }); return; }
  if (!auth) { json(401, { error: 'token agen tidak cocok' }); return; }

  const url = new URL(req.url, 'http://local');
  const agent = {
    name: String(url.searchParams.get('name') ?? req.headers['x-agent-name'] ?? '').slice(0, 60) || null,
    printer: String(url.searchParams.get('printer') ?? req.headers['x-agent-printer'] ?? '').slice(0, 80) || null,
    version: String(req.headers['x-agent-version'] ?? '').slice(0, 20) || null,
  };

  if (req.method === 'GET') {
    const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait')) || 0));
    const until = Date.now() + wait * 1000;
    let job = await takeJob(agent);
    while (!job && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_MS);
      if (req.destroyed) return;
      // eslint-disable-next-line no-await-in-loop
      job = await takeJob(agent);
    }
    if (!job) { res.statusCode = 204; res.setHeader('Cache-Control', 'no-store'); res.end(); return; }
    json(200, { id: job.id, label: job.label, orders: job.orders, pages: job.pages, at: job.at });
    return;
  }

  if (req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { json(400, { error: 'JSON tidak valid' }); return; }
    if (body.heartbeat) { await touchAgent(agent); json(200, { ok: true }); return; }
    const id = String(body.id ?? '');
    if (!/^[0-9a-f-]{4,40}$/.test(id)) { json(400, { error: 'id pekerjaan tidak valid' }); return; }
    const status = body.status === 'done' ? 'done' : 'failed';
    await finishJob(id, { status, error: body.error });
    json(200, { ok: true });
    return;
  }

  json(405, { error: 'method not allowed' });
}
