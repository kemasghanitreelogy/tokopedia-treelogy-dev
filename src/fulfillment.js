import { loadConfig } from './config.js';
import { callApi } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { shopifyGraphql } from './shopify/client.js';
import { isShopifyConfigured } from './shopify/config.js';
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

/** What, if anything, moves this order forward right now. */
export function nextAction(order) {
  // Shopify has no courier to ask, so its move is a typed one: the parcel has gone out
  // and the tracking number from whoever carried it gets recorded. That cannot join the
  // marketplaces' one-click batch, so it is its own action rather than none at all.
  if (order.channel === 'shopify') {
    return order.stage === 'to_ship'
      ? { action: 'shopify_fulfill', label: 'Tandai dikirim', needs: ['tracking'] }
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
export function pending(orders) {
  return orders
    .map((order) => ({ order, next: nextAction(order) }))
    .filter((row) => row.next)
    .sort((a, b) => b.order.createdAt - a.order.createdAt);
}

/* ------------------------------------------------------------------ actions */

function guard(what) {
  if (isReadOnly()) throw new ReadOnlyError(what);
}

/**
 * Shopee: arrange the shipment. This shop's get_shipping_parameter reports
 * `info_needed: { dropoff: [] }`, meaning dropoff with no extra fields required, so the
 * parameters are read per order rather than assumed - a shop switched to pickup needs an
 * address and a time slot instead.
 */
export async function shopeeShip(orderSn) {
  guard(`pengiriman Shopee ${orderSn}`);
  const { config, auth } = await resolveShopeeSession();

  const { response } = await callShopApi(config, '/api/v2/logistics/get_shipping_parameter', auth, {
    order_sn: orderSn,
  });
  const needed = response?.info_needed ?? {};

  const body = { order_sn: orderSn };
  if (Object.hasOwn(needed, 'dropoff')) {
    body.dropoff = {};
    for (const field of needed.dropoff ?? []) {
      if (field === 'branch_id') body.dropoff.branch_id = response.dropoff?.branch_list?.[0]?.branch_id;
    }
  } else if (Object.hasOwn(needed, 'pickup')) {
    const address = response.pickup?.address_list?.[0];
    if (!address) throw new Error('tidak ada alamat pickup yang tersedia');
    body.pickup = { address_id: address.address_id };
    const slot = address.time_slot_list?.[0];
    if (slot) body.pickup.pickup_time_id = slot.pickup_time_id;
  } else {
    throw new Error(`Shopee tidak menyebut metode pengiriman: ${JSON.stringify(needed)}`);
  }

  await callShopApi(config, '/api/v2/logistics/ship_order', auth, {}, body);
  return { channel: 'shopee', id: orderSn, action: 'shopee_ship' };
}

/** TikTok / Tokopedia: mark the package ready to ship, which is what mints the waybill. */
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

/**
 * Arrange shipment for many orders in one go.
 *
 * The two platforms batch differently, and both contracts were probed against the live
 * APIs rather than assumed:
 *
 *   TikTok / Tokopedia  POST /fulfillment/202309/packages/ship takes `packages: [{id}]`
 *                       and is natively batched - one call covers the whole selection.
 *                       (`{package_id}` alone is rejected: "Packages is a required field".)
 *   Shopee              POST /api/v2/logistics/mass_ship_order takes
 *                       `package_list: [{order_sn, package_number}]` plus exactly one of
 *                       pickup / dropoff / non_integrated - it says so itself when the
 *                       method is omitted. This shop is on dropoff.
 *
 * Shopee's batch is all-or-nothing per call, so a rejected batch falls back to shipping
 * each order on its own: one ineligible order must not cost the other nineteen.
 */
export async function massArrange(orders) {
  guard(`pengiriman ${orders.length} pesanan`);

  const tiktok = orders.filter((o) => o.channel !== 'shopee' && o.channel !== 'shopify');
  const shopee = orders.filter((o) => o.channel === 'shopee');
  const results = [];

  // Shopify cannot ride along: there is no courier to ask, only a tracking number to
  // type, and a batch has nowhere to type it. Said out loud rather than dropped, so a
  // selection that somehow carried one does not quietly leave it unshipped.
  for (const order of orders.filter((o) => o.channel === 'shopify')) {
    results.push({
      channel: 'shopify', id: order.id, status: 'failed',
      error: 'Shopify ditandai satu per satu dengan nomor resinya',
    });
  }

  if (tiktok.length > 0) {
    const config = loadConfig();
    const packages = tiktok.filter((o) => o.packageId).map((o) => ({ id: String(o.packageId) }));
    for (const order of tiktok.filter((o) => !o.packageId)) {
      results.push({ channel: order.channel, id: order.id, status: 'failed', error: 'belum punya paket' });
    }

    if (packages.length > 0) {
      try {
        await callApi({
          config,
          method: 'POST',
          path: '/fulfillment/202309/packages/ship',
          body: { packages },
        });
        for (const order of tiktok.filter((o) => o.packageId)) {
          results.push({ channel: order.channel, id: order.id, status: 'ok' });
        }
      } catch (error) {
        // One call covered them all, so one failure is reported against all of them.
        for (const order of tiktok.filter((o) => o.packageId)) {
          results.push({ channel: order.channel, id: order.id, status: 'failed', error: error.message });
        }
      }
    }
  }

  if (shopee.length > 0) {
    const { config, auth } = await resolveShopeeSession();
    const usable = shopee.filter((o) => o.packageNumber);
    for (const order of shopee.filter((o) => !o.packageNumber)) {
      results.push({ channel: 'shopee', id: order.id, status: 'failed', error: 'nomor paket tidak diketahui' });
    }

    let batched = false;
    if (usable.length > 0) {
      try {
        await callShopApi(config, '/api/v2/logistics/mass_ship_order', auth, {}, {
          package_list: usable.map((o) => ({ order_sn: o.id, package_number: o.packageNumber })),
          dropoff: {},
        });
        for (const order of usable) results.push({ channel: 'shopee', id: order.id, status: 'ok' });
        batched = true;
      } catch {
        batched = false;
      }
    }

    if (!batched) {
      for (const order of usable) {
        try {
          await shopeeShipUnguarded(config, auth, order.id);
          results.push({ channel: 'shopee', id: order.id, status: 'ok' });
        } catch (error) {
          results.push({ channel: 'shopee', id: order.id, status: 'failed', error: error.message });
        }
      }
    }
  }

  await writeAudit({ results }, { guards: { action: 'mass_arrange' } }).catch(() => {});
  return {
    results,
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}

/** The single-order path, minus the guard - the batch has already checked it once. */
async function shopeeShipUnguarded(config, auth, orderSn) {
  const { response } = await callShopApi(config, '/api/v2/logistics/get_shipping_parameter', auth, {
    order_sn: orderSn,
  });
  const needed = response?.info_needed ?? {};
  const body = { order_sn: orderSn };

  if (Object.hasOwn(needed, 'dropoff')) {
    body.dropoff = {};
    for (const field of needed.dropoff ?? []) {
      if (field === 'branch_id') body.dropoff.branch_id = response.dropoff?.branch_list?.[0]?.branch_id;
    }
  } else if (Object.hasOwn(needed, 'pickup')) {
    const address = response.pickup?.address_list?.[0];
    if (!address) throw new Error('tidak ada alamat pickup yang tersedia');
    body.pickup = { address_id: address.address_id };
    const slot = address.time_slot_list?.[0];
    if (slot) body.pickup.pickup_time_id = slot.pickup_time_id;
  } else {
    throw new Error(`Shopee tidak menyebut metode pengiriman: ${JSON.stringify(needed)}`);
  }

  await callShopApi(config, '/api/v2/logistics/ship_order', auth, {}, body);
}
