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

const ARRANGED = /mengatur pengiriman|arranged (the )?shipment/i;
const FAILED = /gagal|fail/i;

/** Whether the newest "seller arranged" event is later than the newest failed pickup. */
export function rearrangedAfterFailure(events) {
  let arranged = 0;
  let failed = 0;
  for (const e of events ?? []) {
    const at = Number(e?.update_time) || 0;
    const text = `${e?.description ?? ''} ${e?.logistics_status ?? ''}`;
    if (FAILED.test(text)) failed = Math.max(failed, at);
    else if (ARRANGED.test(text)) arranged = Math.max(arranged, at);
  }
  return arranged > 0 && arranged > failed;
}

const memo = new Map();
export const resetRetryMemo = () => memo.clear();

async function readHistory(sn) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/logistics/get_tracking_info', auth, { order_sn: sn });
  return r.response?.tracking_info ?? [];
}

/**
 * The page's orders with `rearranged: true` on every RETRY_SHIP row the team already
 * arranged again. A history that cannot be read leaves the row as it was - offered.
 */
export async function markRearranged(data, { read = readHistory, now = Date.now() } = {}) {
  const retrying = (data?.orders ?? []).filter((o) => o.channel === 'shopee' && o.status === 'RETRY_SHIP');
  if (!retrying.length) return data;
  let reads = 0;
  for (const o of retrying) {
    const seen = memo.get(o.id);
    if (seen && now - seen.at < RETRY_CHECK_MS) continue;
    if (reads >= MAX_CHECKS) break;
    reads += 1;
    try {
      memo.set(o.id, { at: now, rearranged: rearrangedAfterFailure(await read(o.id)) });
    } catch (error) {
      console.warn(`shopee: riwayat kurir ${o.id} tidak terbaca - ${error.message}`);
    }
  }
  return { ...data, orders: data.orders.map((o) => (o.channel === 'shopee' && o.status === 'RETRY_SHIP' && memo.get(o.id)?.rearranged ? { ...o, rearranged: true } : o)) };
}
