import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { verifyGithub, branchOf } from '../api/deploy.js';

const secret = 'rahasia-deploy';
const sign = (body) => `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

test('GitHub signs sha256=<hex> over the raw body, and nothing else passes', () => {
  const body = '{"ref":"refs/heads/main"}';
  assert.equal(verifyGithub({ rawBody: body, header: sign(body), secret }).ok, true);
  assert.equal(verifyGithub({ rawBody: `${body} `, header: sign(body), secret }).ok, false, 'satu spasi pun harus gagal');
  assert.equal(verifyGithub({ rawBody: body, header: sign(body), secret: 'salah' }).ok, false);
  assert.equal(verifyGithub({ rawBody: body, header: null, secret }).ok, false);
  assert.equal(verifyGithub({ rawBody: body, header: sign(body), secret: '' }).ok, false, 'tanpa DEPLOY_SECRET tidak ada yang diterima');
  // The old sha1 scheme, and a bare hex with no algorithm, are both refused.
  const sha1 = `sha1=${crypto.createHmac('sha1', secret).update(body).digest('hex')}`;
  assert.equal(verifyGithub({ rawBody: body, header: sha1, secret }).ok, false);
  assert.equal(verifyGithub({ rawBody: body, header: sign(body).slice(7), secret }).ok, false);
});

test('a ref becomes a branch name, and anything that is not a branch becomes empty', () => {
  assert.equal(branchOf('refs/heads/main'), 'main');
  assert.equal(branchOf('refs/heads/fitur/ramalan'), 'fitur/ramalan');
  assert.equal(branchOf('refs/tags/v1'), '');
  assert.equal(branchOf(undefined), '');
});

const call = async (raw, headers, env = {}) => {
  const before = { ...process.env };
  Object.assign(process.env, { DEPLOY_SECRET: secret, ...env });
  const handler = (await import('../api/deploy.js')).default;
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST', headers });
  let out = '';
  const res = { statusCode: 0, setHeader() {}, end(b) { out = b ?? ''; } };
  await handler(req, res);
  for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
  Object.assign(process.env, before);
  return [res.statusCode, out];
};

test('only a signed push to the deploy branch asks for a deploy', async () => {
  const trigger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trl-')), 'deploy-requested');
  const push = (ref, after = 'a'.repeat(40)) => JSON.stringify({ ref, after, pusher: { name: 'kemas' }, head_commit: { message: 'ubah sesuatu' } });

  const body = push('refs/heads/main');
  assert.deepEqual(await call(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'push' }, { DEPLOY_TRIGGER_PATH: trigger }), [202, 'deploy requested']);
  const written = JSON.parse(fs.readFileSync(trigger, 'utf8'));
  assert.equal(written.sha, 'a'.repeat(40));
  assert.equal(written.branch, 'main');
  assert.equal(written.message, 'ubah sesuatu');

  // An unsigned push must not even be read as JSON.
  assert.deepEqual((await call(body, { 'x-github-event': 'push' }, { DEPLOY_TRIGGER_PATH: trigger }))[0], 401);
  // Another branch, a tag, and a branch deletion are all acknowledged and ignored.
  const other = push('refs/heads/eksperimen');
  assert.equal((await call(other, { 'x-hub-signature-256': sign(other), 'x-github-event': 'push' }, { DEPLOY_TRIGGER_PATH: trigger }))[0], 200);
  const deleted = push('refs/heads/main', '0'.repeat(40));
  assert.deepEqual(await call(deleted, { 'x-hub-signature-256': sign(deleted), 'x-github-event': 'push' }, { DEPLOY_TRIGGER_PATH: trigger }), [200, 'ignored: branch deleted']);
});

test("GitHub's ping is answered, so the hook goes green, and other events are not deploys", async () => {
  const body = '{"zen":"Non-blocking is better than blocking."}';
  assert.deepEqual(await call(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'ping' }), [200, 'pong']);
  assert.deepEqual(await call(body, { 'x-hub-signature-256': sign(body), 'x-github-event': 'issues' }), [200, 'ignored: issues']);
});
