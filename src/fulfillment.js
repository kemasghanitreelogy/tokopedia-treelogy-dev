import { loadConfig } from './config.js';
import { callApi } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { mapLimit, batches } from './omni.js';
import { shippingMethod, shippingMethods, shipBody, needsPickupTime, PICKUP, DROPOFF } from './shopee/pickup.js';
import { shopifyGraphql } from './shopify/client.js';
import { isShopifyConfigured } from './shopify/config.js';
import { markArranged } from './shopify/label.js';
import { isReadOnly, ReadOnlyError, writeAudit } from './stock-sync.js';

/**
 * Moving an order forward: arrange shipment, then hand it to the courier.
 *
 * The three platforms divide the same journey differently, and the differences are not
 * cosmetic - each was checked against the live shop rather than inferred:
 *
 *   Tokopedia / TikTok  arrives already arranged (AWAITING_COLLECTION), so the only
 *                       gap is AWAITING_SHIPMENT, which needs an RTS call before a
 *                       waybill exists at all.
 *   Shopee              READY_TO_SHIP needs ship_order; this shop is configured for
 *                       dropoff, and get_shipping_parameter reports no extra fields.
 *   Shopify             has no courier integration, so nothing is ever "arranged" - the
 *                       order simply sits UNFULFILLED until someone records the tracking
 *                       number from whichever courier actually took it.
 *
 * Every action here is irreversible from this side: you cannot un-ship an order. So each
 * one is guarded by read-only mode, applied one at a time, and written to the audit log
 * whether it succeeds or fails.
 */

/**
 * What, if anything, moves this order forward right now.
 *
 * @param {object} order
 * @param {Record<string, unknown>} arranged  Shopify orders already worked through this
 *   queue. Arranging one calls nothing, so nothing on Shopify's side can say it happened.
 */
export function nextAction(order, arranged = {}) {
  // Shopify is arranged the same way from the operator's side, but nothing is called:
  // its couriers are booked outside Shopify and the order is closed there by hand. So
  // the move is recorded here, and the parcel joins the same day's picking and printing.
  if (order.channel === 'shopify') {
    return order.stage === 'to_ship' && !arranged[order.id]
      ? { action: 'shopify_arrange', label: 'Atur pengiriman', needs: [] }
      : null;
  }

  if (order.channel === 'shopee') {
    if (order.status === 'READY_TO_SHIP' || order.status === 'RETRY_SHIP') {
      return { action: 'shopee_ship', label: 'Atur pengiriman', needs: [] };
    }
    return null;
  }

  if (order.status === 'AWAITING_SHIPMENT') {
    return { action: 'tiktok_rts', label: 'Atur pengiriman', needs: [] };
  }
  return null;
}

/** Orders still waiting on the seller, newest first, with the action each one needs. */
export function pending(orders, arranged = {}) {
  return orders
    .map((order) => ({ order, next: nextAction(order, arranged) }))
    .filter((row) => row.next)
    .sort((a, b) => b.order.createdAt - a.order.createdAt);
}

/* ------------------------------------------------------------------ actions */

function guard(what) {
  if (isReadOnly()) throw new ReadOnlyError(what);
}

/**
 * Shopee: arrange the shipment, the way this order in particular is handed over.
 *
 * A regular courier is a drop-off and needs nothing said. An instant courier dispatches
 * a driver, so Shopee wants an address and a time; `pickupTimeId` is what the operator
 * chose, and a choice Shopee no longer offers is refused rather than quietly replaced -
 * silently falling back to "Now" is how a driver ends up at an unpacked bench.
 */
export async function shopeeShip(orderSn, { pickupTimeId = null } = {}) {
  guard(`pengiriman Shopee ${orderSn}`);
  const { config, auth } = await resolveShopeeSession();
  await shopeeShipUnguarded(config, auth, orderSn, { pickupTimeId });
  return { channel: 'shopee', id: orderSn, action: 'shopee_ship' };
}

/** Which Shopee orders in a selection need a pickup time before anything can be arranged. */
export async function planArrangement(orders, { read = shippingMethods } = {}) {
  const shopee = orders.filter((o) => o.channel === 'shopee' && o.packageNumber);
  if (shopee.length === 0) return {};
  const { config, auth } = await resolveShopeeSession();
  return read(shopee.map((o) => o.id), { config, auth });
}

/**
 * TikTok / Tokopedia: mark the package ready to ship, which is what mints the waybill.
 *
 * No handover method and no pickup slot go out with this, unlike the Shopee path, and
 * that is a gap rather than a decision. Probed against the live shop on 2026-09-22:
 * a package carries `handover_method`, and Tokopedia's instant couriers are pickups the
 * same way Shopee's are - Instant/Grab, Instant/Gojek and Same day/Paxel all come back
 * PICKUP, against DROP_OFF for J&T and JNE. Each also carries `pickup_slot`, and on
 * every one of ours it reads `{start_time: 0, end_time: 0}`: no window was ever chosen,
 * the courier simply came. The slots live behind
 * GET /fulfillment/202309/packages/{package_id}/handover_time_slots, which exists (a
 * wrong path answers 36009009; this one answers 105005) but which this app has no scope
 * for. Until that scope is granted and the app reauthorized, there is nothing to ask the
 * operator and nothing to send, so this stays as it is rather than guessing a body shape.
 */
export async function tiktokReadyToShip(order) {
  guard(`RTS ${order.id}`);
  if (!order.packageId) throw new Error('pesanan belum punya paket');
  const config = loadConfig();
  // Probed against the live API: the endpoint takes a `packages` array of `{id}`.
  // A bare package_id is rejected with "Packages is a required field".
  await callApi({
    config,
    method: 'POST',
    path: '/fulfillment/202309/packages/ship',
    body: { packages: [{ id: String(order.packageId) }] },
  });
  return { channel: order.channel, id: order.id, action: 'tiktok_rts' };
}

const FULFILL_MUTATION = `
mutation TreelogyFulfill($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment {
      id
      status
      trackingInfo { number company }
    }
    userErrors { field message }
  }
}`;

/** Validated against the live 2026-07 schema via the Shopify Admin skill. */
const FULFILLMENT_ORDERS_QUERY = `
query TreelogyFulfillmentOrders($id: ID!) {
  order(id: $id) {
    id
    name
    fulfillmentOrders(first: 20) {
      nodes {
        id
        status
        assignedLocation { name location { id } }
        lineItems(first: 100) { nodes { id remainingQuantity } }
      }
    }
  }
}`;

/** Only work that has not been handed off or closed can still be fulfilled. */
const FULFILLABLE = new Set(['OPEN', 'IN_PROGRESS']);

/**
 * Shopify: record that the parcel went out, with the courier's tracking number.
 *
 * A fulfillment is created against fulfillment orders, not the order itself, and one
 * mutation can only cover fulfillment orders assigned to the same location - Shopify
 * says so in the mutation's own documentation. So the open ones are grouped by location
 * and each group is its own call. One location is the ordinary case and costs one call;
 * two locations used to mean the whole thing was rejected.
 */
export async function shopifyFulfill(orderGid, { trackingNumber, company, notifyCustomer = false }) {
  guard(`fulfillment Shopify ${orderGid}`);
  if (!isShopifyConfigured()) throw new Error('Shopify belum dikonfigurasi');

  const data = await shopifyGraphql(FULFILLMENT_ORDERS_QUERY, { id: orderGid });
  const open = (data.order?.fulfillmentOrders?.nodes ?? []).filter((fo) => FULFILLABLE.has(fo.status));
  if (open.length === 0) throw new Error('tidak ada fulfillment order yang bisa dikirim');

  const byLocation = new Map();
  for (const fo of open) {
    const key = fo.assignedLocation?.location?.id ?? fo.assignedLocation?.name ?? 'tanpa lokasi';
    const group = byLocation.get(key);
    if (group) group.push(fo);
    else byLocation.set(key, [fo]);
  }

  const statuses = [];
  for (const group of byLocation.values()) {
    const fulfillment = {
      notifyCustomer,
      lineItemsByFulfillmentOrder: group.map((fo) => ({ fulfillmentOrderId: fo.id })),
    };
    // An empty tracking number is worse than none: it shows the buyer a blank link.
    if (trackingNumber) {
      fulfillment.trackingInfo = { number: trackingNumber, company: company || undefined };
    }

    const result = await shopifyGraphql(FULFILL_MUTATION, { fulfillment });
    const errors = result.fulfillmentCreate?.userErrors ?? [];
    if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
    statuses.push(result.fulfillmentCreate?.fulfillment?.status);
  }

  return {
    channel: 'shopify',
    id: data.order?.name ?? orderGid,
    action: 'shopify_fulfill',
    status: statuses.every((st) => st === 'SUCCESS') ? 'ok' : statuses.join('/'),
  };
}

/**
 * Run one action. Kept deliberately singular: shipping is irreversible, so a mistake
 * should cost one order, not a batch. The audit record is written either way.
 */
export async function runAction({ action, order, trackingNumber, company }) {
  const started = Date.now();
  let outcome;
  try {
    if (action === 'shopee_ship') outcome = await shopeeShip(order.id);
    else if (action === 'tiktok_rts') outcome = await tiktokReadyToShip(order);
    else if (action === 'shopify_fulfill') {
      outcome = await shopifyFulfill(order.gid ?? order.id, { trackingNumber, company });
    } else throw new Error(`aksi tidak dikenal: ${action}`);

    outcome.status = outcome.status ?? 'ok';
    outcome.ms = Date.now() - started;
  } catch (error) {
    outcome = { channel: order.channel, id: order.id, action, status: 'failed', error: error.message };
  }

  await writeAudit({ results: [outcome] }, { guards: { action } }).catch(() => {});
  return outcome;
}


/* ------------------------------------------------------------- mass shipment */

/* ------------------------------------------------------------- the batch */

/**
 * Shopee refuses a 51st package outright: "The amount of packages in your request
 * exceeds limit". Probed against the live shop rather than read off a page.
 */
const SHOPEE_MASS_LIMIT = 50;
/** One call per parcel, several at a time. Both platforms are comfortable here. */
const SHIP_CONCURRENCY = 6;
const VERIFY_CONCURRENCY = 4;
/** Shopee statuses that still mean "nobody has arranged this". */
const UNARRANGED = new Set(['READY_TO_SHIP', 'RETRY_SHIP']);

const ok = (order) => ({ channel: order.channel, id: order.id, status: 'ok' });
const failed = (order, error) => ({ channel: order.channel, id: order.id, status: 'failed', error });

/**
 * TikTok / Tokopedia: one call per package.
 *
 * The endpoint takes an array and looks batched, but it validates the whole body before
 * it does anything: a single package it will not accept fails the call with
 * "No Valid FulfillUnit error" and takes every other parcel in the request down with it.
 * One call each costs a few hundred milliseconds across six workers and tells the truth
 * about every parcel, which is worth more than a round trip.
 */
export async function arrangeTikTok(orders, { call = callApi, config = null } = {}) {
  if (orders.length === 0) return [];
  const settings = config ?? loadConfig();
  return mapLimit(orders, SHIP_CONCURRENCY, async (order) => {
    if (!order.packageId) return failed(order, 'belum punya paket');
    try {
      await call({
        config: settings,
        method: 'POST',
        path: '/fulfillment/202309/packages/ship',
        body: { packages: [{ id: String(order.packageId) }] },
      });
      return ok(order);
    } catch (error) {
      return failed(order, error.message);
    }
  });
}

/**
 * Shopee drop-offs, fifty to a call, several calls at once.
 *
 * A chunk that comes back cleanly is not taken at its word: `result_list` names the
 * orders that did not make it, and those are re-reported as failures. A chunk that
 * throws is not a verdict on any one order - it is retried one order at a time, so the
 * single ineligible parcel costs itself and nothing else.
 */
export async function shipShopeeDropoffs(config, auth, orders, { call = callShopApi, shipOne = shopeeShipUnguarded } = {}) {
  if (orders.length === 0) return [];
  const chunks = batches(orders, SHOPEE_MASS_LIMIT);

  const perChunk = await mapLimit(chunks, VERIFY_CONCURRENCY, async (chunk) => {
    try {
      const answer = await call(config, '/api/v2/logistics/mass_ship_order', auth, {}, {
        package_list: chunk.map((o) => ({ order_sn: o.id, package_number: o.packageNumber })),
        dropoff: {},
      });
      // Every order Shopee names with an error is one that did not ship, whatever the
      // call's own status said. Marking the whole chunk "ok" because the HTTP request
      // succeeded is what made a batch report twenty-seven arranged when nine were.
      const rejected = new Map();
      for (const row of answer.response?.result_list ?? []) {
        if (row.fail_error) rejected.set(row.order_sn, row.fail_message || row.fail_error);
      }
      return chunk.map((order) => (rejected.has(order.id) ? failed(order, rejected.get(order.id)) : ok(order)));
    } catch (error) {
      const reason = error.message;
      return mapLimit(chunk, SHIP_CONCURRENCY, async (order) => {
        try {
          await shipOne(config, auth, order.id, { plan: { method: DROPOFF, fields: [] } });
          return ok(order);
        } catch (own) {
          // The batch's own complaint is the more useful one when the retry says nothing new.
          return failed(order, own.message || reason);
        }
      });
    }
  });

  return perChunk.flat();
}

/**
 * What Shopee thinks now, for the orders we just tried to arrange.
 *
 * The ship call answering 200 is not the same as the parcel having moved, and the
 * difference is exactly what an operator sees when the list still holds orders the
 * dashboard just said were arranged. Fifty statuses per call, so checking a hundred
 * parcels costs two reads. A read that fails leaves the ship call's own answer standing
 * rather than inventing a failure.
 */
export async function verifyShopee(config, auth, orderSns, { call = callShopApi } = {}) {
  if (orderSns.length === 0) return {};
  const pages = await mapLimit(batches(orderSns, 50), VERIFY_CONCURRENCY, (chunk) =>
    call(config, '/api/v2/order/get_order_detail', auth, {
      order_sn_list: chunk.join(','),
      response_optional_fields: 'order_status',
    }).then((r) => r.response?.order_list ?? []).catch(() => []));

  const status = {};
  for (const row of pages.flat()) status[row.order_sn] = row.order_status;
  return status;
}

export async function arrangeShopee(orders, { pickupTimes = {}, methods = null, session = null, call = callShopApi, shipOne = shopeeShipUnguarded } = {}) {
  if (orders.length === 0) return [];
  const { config, auth } = session ?? await resolveShopeeSession();

  const results = [];
  const usable = orders.filter((o) => o.packageNumber);
  for (const order of orders.filter((o) => !o.packageNumber)) {
    results.push(failed(order, 'nomor paket tidak diketahui'));
  }
  if (usable.length === 0) return results;

  // Split by how each parcel is handed over, rather than sending the lot as dropoff and
  // letting Shopee refuse the batch because one order wanted a driver.
  const plans = methods ?? await shippingMethods(usable.map((o) => o.id), { config, auth, concurrency: SHIP_CONCURRENCY });
  const collected = usable.filter((o) => plans[o.id]?.method === PICKUP);
  const dropped = usable.filter((o) => plans[o.id]?.method !== PICKUP);

  // A pickup is booked one at a time by necessity - the address and the slot belong to
  // that order, and mass_ship_order carries one method for the whole call - but they no
  // longer wait for each other, or for the drop-offs.
  const [droppedResults, collectedResults] = await Promise.all([
    shipShopeeDropoffs(config, auth, dropped, { call, shipOne }),
    mapLimit(collected, SHIP_CONCURRENCY, async (order) => {
      try {
        await shipOne(config, auth, order.id, {
          pickupTimeId: pickupTimes[order.id] ?? null,
          plan: plans[order.id] ?? null,
        });
        return ok(order);
      } catch (error) {
        return failed(order, error.message);
      }
    }),
  ]);

  const attempted = [...droppedResults, ...collectedResults];
  const status = await verifyShopee(config, auth, usable.map((o) => o.id), { call }).catch(() => ({}));

  for (const row of attempted) {
    const now = status[row.id];
    if (!now) { results.push(row); continue; }
    if (UNARRANGED.has(now)) {
      results.push({ ...row, status: 'failed', error: row.error ?? `Shopee masih ${now}` });
    } else {
      // Moved on, whatever the call said - including an order somebody else arranged
      // while this batch was running.
      results.push({ channel: 'shopee', id: row.id, status: 'ok' });
    }
  }
  return results;
}

/**
 * Arrange shipment for many orders in one go.
 *
 * Every parcel in the selection is arranged, however many were chosen, and every parcel
 * gets its own verdict. The three platforms run at the same time rather than in turn,
 * because none of them is waiting on the others:
 *
 *   TikTok / Tokopedia  POST /fulfillment/202309/packages/ship takes `packages: [{id}]`.
 *                       It looks batched and is not: the body is validated as a whole, so
 *                       one parcel it refuses fails the call for all of them. One call
 *                       each, six at a time. (`{package_id}` alone is rejected outright:
 *                       "Packages is a required field".)
 *   Shopee              POST /api/v2/logistics/mass_ship_order takes
 *                       `package_list: [{order_sn, package_number}]` plus exactly one of
 *                       pickup / dropoff / non_integrated - it says so itself when the
 *                       method is omitted - and refuses a 51st package. Fifty to a call,
 *                       and what Shopee names in `result_list` as failed is failed.
 *   Shopify             has no courier to call. Arranging it is the record that the bench
 *                       has taken it, which is what lets it leave the queue.
 *
 * Then the Shopee orders are read back. A ship call answering 200 is not the same as the
 * parcel having moved, and the gap between the two is what an operator sees when the
 * queue still holds orders the dashboard just called done.
 */
export async function massArrange(orders, { pickupTimes = {}, methods = null } = {}) {
  guard(`pengiriman ${orders.length} pesanan`);

  const tiktok = orders.filter((o) => o.channel !== 'shopee' && o.channel !== 'shopify');
  const shopee = orders.filter((o) => o.channel === 'shopee');
  const shopify = orders.filter((o) => o.channel === 'shopify');

  const [tiktokResults, shopeeResults, shopifyResults] = await Promise.all([
    arrangeTikTok(tiktok).catch((error) => tiktok.map((o) => failed(o, error.message))),
    arrangeShopee(shopee, { pickupTimes, methods }).catch((error) => shopee.map((o) => failed(o, error.message))),
    shopify.length === 0
      ? Promise.resolve([])
      : markArranged(shopify.map((o) => o.id), { by: 'dashboard' })
        .then(() => shopify.map(ok))
        .catch((error) => shopify.map((o) => failed(o, error.message))),
  ]);

  const results = [...tiktokResults, ...shopeeResults, ...shopifyResults];
  await writeAudit({ results }, { guards: { action: 'mass_arrange' } }).catch(() => {});
  return {
    results,
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}

/** The single-order path, minus the guard - the batch has already checked it once. */
async function shopeeShipUnguarded(config, auth, orderSn, { pickupTimeId = null, plan = null } = {}) {
  const method = plan ?? await shippingMethod(orderSn, { config, auth });
  await callShopApi(config, '/api/v2/logistics/ship_order', auth, {}, shipBody(orderSn, method, { pickupTimeId }));
}
