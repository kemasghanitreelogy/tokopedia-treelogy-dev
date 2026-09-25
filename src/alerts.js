import { EventEmitter } from 'node:events';
import { readDoc, updateDoc } from './store/index.js';

/**
 * Things worth interrupting somebody for, and the pipe that carries them to a screen.
 *
 * Everything else this dashboard shows is pulled: a page is opened, a list is read, a
 * number is looked at. That is right for almost all of it and wrong for an instant order,
 * where the useful window is minutes and the person who needs to know is at a bench, not
 * at a browser tab they happen to be refreshing.
 *
 * Two layers, because there are two processes. The emitter delivers inside the web
 * service, which is where webhooks land, and is immediate. The store holds the same
 * alerts so that a browser reconnecting after a dropped connection can catch up, a tab
 * opened five minutes later still learns about the parcel, and an alert raised by the
 * sweep - a different process entirely - is not lost.
 *
 * The feed is capped and pruned. It is a doorbell, not a record: the audit log and the
 * order list are where things are kept.
 */

export const ALERTS_DOC = 'alerts/feed.json';

/** Long enough to cover a lunch break, short enough that nothing stale ever pops up. */
export const ALERT_TTL_MS = 2 * 60 * 60_000;

/** Enough for the busiest hour anyone has had, so a burst cannot push out its own start. */
const MAX_ALERTS = 100;

const EMPTY = { version: 1, seq: 0, alerts: [] };

/** In-process delivery, for the common case where the webhook and the browser share a process. */
export const alertBus = new EventEmitter();
// A dozen dashboards open at once is normal and is not a leak; Node's default of ten
// would print a warning that means nothing here.
alertBus.setMaxListeners(0);

const prune = (alerts, now) => alerts
  .filter((a) => now - Number(a.at ?? 0) < ALERT_TTL_MS)
  .slice(-MAX_ALERTS);

/**
 * Raise one, unless the same thing was already raised.
 *
 * Keyed on whatever the caller calls the event - for an order, the order itself - because
 * platforms push the same order repeatedly and a doorbell that rings on every push is one
 * people learn to ignore. Returns null when it was a repeat, so the caller can say so.
 *
 * @param {{key: string, kind: string, title: string, body?: string, tone?: string, href?: string, data?: object}} alert
 */
export async function raiseAlert(alert, { now = Date.now() } = {}) {
  if (!alert?.key) throw new Error('alert tanpa key');

  let raised = null;
  try {
    await updateDoc(ALERTS_DOC, (current) => {
      const doc = { ...EMPTY, ...(current ?? {}) };
      const alerts = prune(doc.alerts ?? [], now);
      if (alerts.some((a) => a.key === alert.key)) {
        raised = null;
        return { ...doc, alerts };
      }
      const seq = Number(doc.seq ?? 0) + 1;
      raised = { ...alert, id: seq, at: now };
      return { ...doc, seq, alerts: [...alerts, raised] };
    }, structuredClone(EMPTY));
  } catch (error) {
    // A doorbell that cannot ring must never stop the door opening. The order is already
    // saved by the time this runs.
    console.warn(`alerts: gagal mencatat - ${error.message}`);
    return null;
  }

  if (raised) alertBus.emit('alert', raised);
  return raised;
}

/**
 * Everything raised after `sinceId` that has not aged out.
 *
 * `sinceId` of 0 means "whatever is still live", which is what a tab opened cold wants:
 * a parcel from four minutes ago is still a parcel somebody has to pack.
 */
export async function alertsSince(sinceId = 0, { now = Date.now() } = {}) {
  try {
    const doc = await readDoc(ALERTS_DOC);
    return prune(doc?.alerts ?? [], now).filter((a) => Number(a.id) > Number(sinceId));
  } catch {
    return [];
  }
}

/** For tests and for a person who wants the noise to stop. */
export async function clearAlerts() {
  await updateDoc(ALERTS_DOC, () => structuredClone(EMPTY), structuredClone(EMPTY)).catch(() => {});
}
