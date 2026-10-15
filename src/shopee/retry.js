import { callShopApi } from './client.js';
import { resolveShopeeSession } from './session.js';

/**
 * A Shopee order whose pickup failed and that the team has already arranged again.
 *
 * When an instant courier gives a parcel back (261013GVQ7G0ND, 14 Oct: "no_space_in_bag"),
 * Shopee turns the order to RETRY_SHIP - and keeps it there after the seller arranges it
 * again in Seller Centre, until a courier picks it up. order_status and the package's
 * logistics_status both stay put; only the tracking history says the seller acted. So for
 * the few RETRY_SHIP rows, that history is read, and a row arranged after its last failed
 * pickup is no longer offered for arranging.
 */

/** How long one reading of an order's history is trusted. */
export const RETRY_CHECK_MS = 2 * 60_000;
/** Most histories read per page load; RETRY_SHIP is rare, this is only a ceiling. */
const MAX_CHECKS = 5;
/**
 * The longest a page waits for those reads. Past it the page goes out with what is known
 * and the reads finish in the background for the next load: on 15 Oct Shopee stopped
 * answering the VPS and every Proses load hung for a minute behind one history.
 */
export const RETRY_WAIT_MS = 1500;

const ARRANGED = /mengatur pengiriman|arranged (the )?shipment/i;
const FAILED = /gagal|fail/i;

/**
 * When the seller arranged the order again after its newest failed pickup, epoch seconds;
 * 0 when they have not (or when no pickup failed - then it is not this case at all).
 */
export function rearrangedAfterFailure(events) {
  let arranged = 0;
  let failed = 0;
  for (const e of events ?? []) {
    const at = Number(e?.update_time) || 0;
    const text = `${e?.description ?? ''} ${e?.logistics_status ?? ''}`;
    if (FAILED.test(text)) failed = Math.max(failed, at);
    else if (ARRANGED.test(text)) arranged = Math.max(arranged, at);
  }
  return failed > 0 && arranged > failed ? arranged : 0;
}

const memo = new Map();
const reading = new Map();
export const resetRetryMemo = () => { memo.clear(); reading.clear(); };

async function readHistory(sn) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/logistics/get_tracking_info', auth, { order_sn: sn });
  return r.response?.tracking_info ?? [];
}

/**
 * The page's orders with `rearranged` (the moment, epoch seconds) on every RETRY_SHIP row
 * the team already arranged again. A history that cannot be read leaves the row as it
 * was - offered for arranging - and is not asked again until RETRY_CHECK_MS has passed.
 */
export async function markRearranged(data, { read = readHistory, now = Date.now(), wait = RETRY_WAIT_MS } = {}) {
  const retrying = (data?.orders ?? []).filter((o) => o.channel === 'shopee' && o.status === 'RETRY_SHIP');
  if (!retrying.length) return data;
  const started = [];
  for (const o of retrying) {
    const seen = memo.get(o.id);
    if (reading.has(o.id)) { started.push(reading.get(o.id)); continue; }
    if (seen && now - seen.at < RETRY_CHECK_MS) continue;
    if (started.length >= MAX_CHECKS) break;
    const job = (async () => {
      try {
        memo.set(o.id, { at: now, rearranged: rearrangedAfterFailure(await read(o.id)) });
      } catch (error) {
        memo.set(o.id, { at: now, rearranged: seen?.rearranged ?? 0 });
        console.warn(`shopee: riwayat kurir ${o.id} tidak terbaca - ${error.message}`);
      } finally {
        reading.delete(o.id);
      }
    })();
    reading.set(o.id, job);
    started.push(job);
  }
  if (started.length) {
    let timer;
    await Promise.race([Promise.all(started), new Promise((resolve) => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  return { ...data, orders: data.orders.map((o) => (o.channel === 'shopee' && o.status === 'RETRY_SHIP' && memo.get(o.id)?.rearranged ? { ...o, rearranged: memo.get(o.id).rearranged } : o)) };
}
