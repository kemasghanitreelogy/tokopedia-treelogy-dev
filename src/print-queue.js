import { randomUUID } from 'node:crypto';
import { readDoc, updateDoc } from './store/index.js';

/**
 * The print queue: labels waiting for the printer on the packing bench.
 *
 * A Bluetooth printer takes one phone at a time and a browser cannot reach a USB or
 * LAN printer at all. So the bench has an agent - a small program on the laptop the
 * printer is plugged into - that asks here for the next job, feeds it to the printer
 * and reports back. Every phone and laptop then prints the same way: press the button,
 * the label is rendered here into the printer's own language, and the agent takes it.
 * No pairing, nothing to hold, and two people pressing at once simply queue.
 *
 * Jobs carry the rendered pages (TSPL, base64). A job the agent took but never finished
 * within RECLAIM_MS - the laptop rebooted, the cable came out - goes back to pending so
 * nothing is lost; the agent may print it twice in the worst case, which is paper, not
 * a missing parcel.
 */

export const QUEUE_DOC = 'labels/print-queue.json';
export const AGENT_ONLINE_MS = 90_000;
export const RECLAIM_MS = 3 * 60_000;
const KEEP_FINISHED_MS = 24 * 3600_000;
const KEEP_FINISHED = 60;
const EMPTY = { jobs: [], agent: null };

const base = (doc) => ({ jobs: Array.isArray(doc?.jobs) ? doc.jobs : [], agent: doc?.agent ?? null });

/** Finished jobs are kept for a day, and never more than a few dozen. */
export function prune(doc, now = Date.now()) {
  const d = base(doc);
  const finished = d.jobs.filter((j) => j.status === 'done' || j.status === 'failed')
    .filter((j) => now - (j.doneAt ?? j.at ?? 0) < KEEP_FINISHED_MS)
    .slice(-KEEP_FINISHED);
  const open = d.jobs.filter((j) => j.status === 'pending' || j.status === 'printing');
  return { ...d, jobs: [...open, ...finished].sort((a, b) => a.at - b.at) };
}

export function applyEnqueue(doc, { by, label, orders = [], pages = [] }, now = Date.now()) {
  const d = prune(doc, now);
  const job = { id: randomUUID().slice(0, 8), at: now, by: by ?? null, label: label ?? '', orders, pages, status: 'pending' };
  return { doc: { ...d, jobs: [...d.jobs, job] }, job };
}

/** The oldest pending job becomes this agent's; a job left printing too long is reclaimed first. */
export function applyTake(doc, agent, now = Date.now()) {
  const d = prune(doc, now);
  const jobs = d.jobs.map((j) => (j.status === 'printing' && now - (j.takenAt ?? 0) > RECLAIM_MS ? { ...j, status: 'pending', takenAt: null, reclaimed: (j.reclaimed ?? 0) + 1 } : j));
  const next = jobs.find((j) => j.status === 'pending');
  const taken = next ? { ...next, status: 'printing', takenAt: now, takenBy: agent?.name ?? null } : null;
  return {
    doc: { ...d, jobs: taken ? jobs.map((j) => (j.id === taken.id ? taken : j)) : jobs, agent: { ...(agent ?? {}), seenAt: now } },
    job: taken,
  };
}

export function applyFinish(doc, id, { status, error = null }, now = Date.now()) {
  const d = prune(doc, now);
  const ok = status === 'done';
  return {
    ...d,
    jobs: d.jobs.map((j) => (j.id === id && j.status !== 'done'
      ? { ...j, status: ok ? 'done' : 'failed', doneAt: now, error: ok ? null : String(error ?? 'gagal') }
      : j)),
    agent: { ...(d.agent ?? {}), seenAt: now },
  };
}

/** What a page shows: whether the bench is listening, and what is waiting. Pages are left out. */
export function summarize(doc, now = Date.now()) {
  const d = prune(doc, now);
  const seenAt = d.agent?.seenAt ?? null;
  const strip = ({ pages, ...j }) => ({ ...j, pages: Array.isArray(pages) ? pages.length : 0 });
  return {
    online: Boolean(seenAt && now - seenAt < AGENT_ONLINE_MS),
    seenAt,
    agent: d.agent ? { name: d.agent.name ?? null, printer: d.agent.printer ?? null } : null,
    pending: d.jobs.filter((j) => j.status === 'pending').length,
    printing: d.jobs.filter((j) => j.status === 'printing').length,
    recent: d.jobs.slice(-12).map(strip),
  };
}

/* ------------------------------------------------------------- the store */

export async function enqueueJob(input) {
  let made = null;
  await updateDoc(QUEUE_DOC, (current) => { const out = applyEnqueue(current, input); made = out.job; return out.doc; }, structuredClone(EMPTY));
  return made;
}

export async function takeJob(agent) {
  let taken = null;
  await updateDoc(QUEUE_DOC, (current) => { const out = applyTake(current, agent); taken = out.job; return out.doc; }, structuredClone(EMPTY));
  return taken;
}

export async function finishJob(id, result) {
  await updateDoc(QUEUE_DOC, (current) => applyFinish(current, id, result), structuredClone(EMPTY));
}

/** The agent said hello and took nothing. */
export async function touchAgent(agent) {
  await updateDoc(QUEUE_DOC, (current) => ({ ...prune(current), agent: { ...(agent ?? {}), seenAt: Date.now() } }), structuredClone(EMPTY));
}

export async function benchSnapshot() {
  const doc = await readDoc(QUEUE_DOC).catch(() => null);
  return summarize(doc);
}
