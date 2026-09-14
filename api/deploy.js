import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readRawBody, safeEqual } from '../src/webhooks/verify.js';

/**
 * Push-to-deploy, without giving GitHub a key to the server.
 *
 * GitHub posts here on every push; a push to the default branch touches a trigger file.
 * A systemd path unit watches that file and runs the deploy. Nothing else happens in this
 * process: it does not pull, does not run npm, and does not restart anything - a service
 * cannot cleanly restart itself while answering a request, and giving the web process
 * sudo to do it would be worse.
 *
 * The direction matters. The common alternative - a GitHub Action that SSHes in - means a
 * private key with shell access lives in GitHub, and anyone who can push to the repo or
 * read those secrets owns the server. Here GitHub holds only a shared secret whose entire
 * power is "ask the server to pull its own code".
 */

/** Read at call time, not at import: the process may be configured after the module loads. */
export const triggerPath = () => process.env.DEPLOY_TRIGGER_PATH || '/opt/treelogy/state/deploy-requested';
const deployBranch = () => process.env.DEPLOY_BRANCH || 'main';

/**
 * GitHub signs with `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body.
 * Confirmed against GitHub's own documentation, not from memory.
 */
export function verifyGithub({ rawBody, header, secret }) {
  if (!secret || !header) return { ok: false, reason: 'tanda tangan atau DEPLOY_SECRET tidak ada' };
  const [algorithm, provided] = String(header).split('=');
  if (algorithm !== 'sha256' || !provided) return { ok: false, reason: 'format tanda tangan tidak dikenal' };
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return { ok: safeEqual(provided, expected) };
}

/** Which ref was pushed, as a branch name. */
export const branchOf = (ref) => (String(ref ?? '').startsWith('refs/heads/') ? String(ref).slice('refs/heads/'.length) : '');

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('method not allowed');
  }

  let raw;
  try {
    raw = await readRawBody(req, 5_000_000);
  } catch (error) {
    res.statusCode = 400;
    return res.end(error.message);
  }

  const check = verifyGithub({
    rawBody: raw,
    header: req.headers['x-hub-signature-256'],
    secret: process.env.DEPLOY_SECRET,
  });
  if (!check.ok) {
    console.warn(`deploy: ditolak - ${check.reason ?? 'tanda tangan tidak cocok'}`);
    res.statusCode = 401;
    return res.end('invalid signature');
  }

  const event = req.headers['x-github-event'];
  // GitHub sends `ping` when the webhook is created; answering it is how the hook goes green.
  if (event === 'ping') {
    res.statusCode = 200;
    return res.end('pong');
  }
  if (event !== 'push') {
    res.statusCode = 200;
    return res.end(`ignored: ${event}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    return res.end('bad json');
  }

  const branch = branchOf(payload.ref);
  if (branch !== deployBranch()) {
    console.log(`deploy: push ke ${branch || '(bukan branch)'} diabaikan`);
    res.statusCode = 200;
    return res.end(`ignored branch: ${branch}`);
  }

  const after = String(payload.after ?? '');
  // A branch deletion pushes the zero SHA; there is nothing to deploy.
  if (/^0+$/.test(after)) {
    res.statusCode = 200;
    return res.end('ignored: branch deleted');
  }

  try {
    const target = triggerPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({
      at: new Date().toISOString(),
      sha: after,
      branch,
      by: payload.pusher?.name ?? '',
      message: String(payload.head_commit?.message ?? '').split('\n')[0].slice(0, 200),
    }));
  } catch (error) {
    console.error(`deploy: tidak bisa menulis pemicu - ${error.message}`);
    res.statusCode = 500;
    return res.end('trigger failed');
  }

  console.log(`deploy: diminta untuk ${after.slice(0, 8)} di ${branch}`);
  res.statusCode = 202;
  res.end('deploy requested');
}
