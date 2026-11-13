import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnqueue, applyTake, applyFinish, summarize, prune, RECLAIM_MS, AGENT_ONLINE_MS } from '../src/print-queue.js';
import { agentAuthorized } from '../api/print-agent.js';

const t0 = 1_800_000_000_000;

test('a job is queued, taken by the agent oldest first, and finished', () => {
  let { doc, job: a } = applyEnqueue(null, { by: 'kemas@treelogy.com', label: '2 label', orders: ['shopify:#1'], pages: ['AAAA', 'BBBB'] }, t0);
  ({ doc } = applyEnqueue(doc, { by: 'agas@treelogy.com', label: '1 label', orders: ['shopee:2'], pages: ['CCCC'] }, t0 + 10));
  assert.equal(summarize(doc, t0 + 20).pending, 2);
  assert.equal(summarize(doc, t0 + 20).online, false, 'no agent has asked yet');

  const take = applyTake(doc, { name: 'LAPTOP-PACKING', printer: 'OKAY D100' }, t0 + 100);
  assert.equal(take.job.id, a.id, 'oldest first');
  assert.equal(take.job.status, 'printing');
  assert.deepEqual(take.job.pages, ['AAAA', 'BBBB']);
  const s = summarize(take.doc, t0 + 200);
  assert.deepEqual([s.online, s.pending, s.printing, s.agent.name], [true, 1, 1, 'LAPTOP-PACKING']);
  assert.equal(s.recent.find((j) => j.id === a.id).pages, 2, 'pages are counted, never sent to a page');

  const done = applyFinish(take.doc, a.id, { status: 'done' }, t0 + 300);
  assert.equal(done.jobs.find((j) => j.id === a.id).status, 'done');
  assert.equal(summarize(done, t0 + 300).pending, 1);
  assert.equal(applyTake(done, {}, t0 + 400).job.label, '1 label');
});

test('a job the agent never finished is reclaimed, and the agent goes offline when quiet', () => {
  let { doc } = applyEnqueue(null, { pages: ['X'] }, t0);
  const first = applyTake(doc, { name: 'a' }, t0 + 1);
  assert.equal(applyTake(first.doc, { name: 'a' }, t0 + 2).job, null, 'nothing else to take');
  const later = applyTake(first.doc, { name: 'a' }, t0 + RECLAIM_MS + 1000);
  assert.equal(later.job.id, first.job.id, 'given out again');
  assert.equal(later.job.reclaimed, 1);
  assert.equal(summarize(first.doc, t0 + AGENT_ONLINE_MS + 1).online, false);
  const failed = applyFinish(later.doc, later.job.id, { status: 'failed', error: 'printer tidak ditemukan' }, t0 + RECLAIM_MS + 2000);
  assert.equal(failed.jobs[0].error, 'printer tidak ditemukan');
});

test('finished jobs fall away after a day and never pile up', () => {
  let doc = null;
  for (let i = 0; i < 80; i += 1) {
    const out = applyEnqueue(doc, { pages: ['P'] }, t0 + i);
    doc = applyFinish(out.doc, out.job.id, { status: 'done' }, t0 + i);
  }
  assert.equal(prune(doc, t0 + 100).jobs.length, 60);
  assert.equal(prune(doc, t0 + 25 * 3600_000).jobs.length, 0);
  const open = applyEnqueue(doc, { pages: ['Q'] }, t0 + 25 * 3600_000).doc;
  assert.equal(open.jobs.length, 1, 'a pending job is never pruned');
});

test('the agent token is required, compared whole, and absent means closed', () => {
  assert.equal(agentAuthorized('Bearer abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'), 'ok');
  assert.equal(agentAuthorized('abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'), 'ok', 'with or without the scheme');
  assert.equal(agentAuthorized('Bearer abcdefghijklmnopqrstuvwxy', 'abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(agentAuthorized('Bearer ', 'abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(agentAuthorized('Bearer x', ''), null, 'no token on the server: nobody gets in');
  assert.equal(agentAuthorized('Bearer short', 'short'), null, 'a short token is no token');
});
