import { callShopApi } from './client.js';

/**
 * How Shopee wants this particular parcel handed over.
 *
 * Two answers, and the difference decides whether a human has to be asked something.
 * A regular courier is a drop-off: the shop takes the parcel to the agent, Shopee needs
 * nothing but the word "shipped". An instant courier is a pickup: a driver is dispatched
 * to the shop, so Shopee will not accept the order until it is told which address and
 * *when*, and it offers the slots itself - "Now", or an hour-wide window later in the
 * day. Verified against the live shop on 2026-09-22:
 *
 *   JNE Reguler              info_needed { dropoff: [] }
 *   GrabExpress Instant      info_needed { pickup: [address_id, pickup_time_id] }
 *   GoSend Instant Prioritas info_needed { pickup: [address_id, pickup_time_id] }
 *
 * The slot ids are minted per order - the same 10:00-11:00 window is `..._6` on one
 * order and `..._12` on the next - so they cannot be reused across orders, and they
 * expire, which is why the shop is asked at the moment of arranging rather than earlier.
 *
 * What this replaces is worse than a missing feature: the old path took the first slot
 * on the list, which is "Now", and booked a driver to a bench that had not packed yet.
 */

export const DROPOFF = 'dropoff';
export const PICKUP = 'pickup';

const SHIPPING_PARAMETER = '/api/v2/logistics/get_shipping_parameter';

/** @returns {Promise<{id: string, method: string, fields: string[], addressId?: number, address?: string, slots?: object[], branchId?: number|null, needed?: object}>} */
export async function shippingMethod(orderSn, { config, auth, call = callShopApi } = {}) {
  const { response } = await call(config, SHIPPING_PARAMETER, auth, { order_sn: orderSn });
  const needed = response?.info_needed ?? {};

  if (Object.hasOwn(needed, PICKUP)) {
    // One address, the shop's own; Shopee flags it `pickup_address` and lists no other.
    const address = response?.pickup?.address_list?.[0] ?? null;
    return {
      id: orderSn,
      method: PICKUP,
      fields: needed[PICKUP] ?? [],
      addressId: address?.address_id ?? null,
      address: String(address?.address ?? '').trim(),
      slots: (address?.time_slot_list ?? [])
        .map((slot) => ({
          id: String(slot.pickup_time_id ?? ''),
          text: String(slot.time_text ?? '').trim(),
          at: Number(slot.date) || 0,
          recommended: (slot.flags ?? []).includes('recommended'),
        }))
        .filter((slot) => slot.id),
    };
  }

  if (Object.hasOwn(needed, DROPOFF)) {
    return {
      id: orderSn,
      method: DROPOFF,
      fields: needed[DROPOFF] ?? [],
      branchId: response?.dropoff?.branch_list?.[0]?.branch_id ?? null,
    };
  }

  return { id: orderSn, method: 'unknown', fields: [], needed };
}

/** Whether this parcel cannot be arranged until somebody says when the driver should come. */
export const needsPickupTime = (plan) =>
  plan?.method === PICKUP && (plan.fields ?? []).includes('pickup_time_id') && (plan.slots ?? []).length > 0;

/** The slot Shopee itself recommends, or failing that the first one it offers. */
export const defaultSlot = (plan) =>
  (plan?.slots ?? []).find((slot) => slot.recommended) ?? (plan?.slots ?? [])[0] ?? null;

/**
 * The ship_order body this parcel needs, or a refusal naming what is missing.
 *
 * Pure on purpose: what goes in the body is a decision, and a decision that can send a
 * driver to an empty bench is one worth being able to test without a network.
 */
export function shipBody(orderSn, plan, { pickupTimeId = null } = {}) {
  const body = { order_sn: orderSn };

  if (plan?.method === DROPOFF) {
    body.dropoff = {};
    if ((plan.fields ?? []).includes('branch_id')) body.dropoff.branch_id = plan.branchId;
    return body;
  }

  if (plan?.method === PICKUP) {
    if (!plan.addressId) throw new Error('tidak ada alamat pickup yang tersedia');
    body.pickup = { address_id: plan.addressId };
    let chosen = defaultSlot(plan)?.id ?? null;
    if (pickupTimeId) {
      // A slot expires while the operator is deciding. Quietly booking the recommended
      // one instead would send a driver at a time nobody agreed to.
      if (!(plan.slots ?? []).some((slot) => slot.id === pickupTimeId)) {
        throw new Error('waktu jemput yang dipilih sudah tidak ditawarkan Shopee - pilih ulang');
      }
      chosen = pickupTimeId;
    }
    if (chosen) body.pickup.pickup_time_id = chosen;
    else if (needsPickupTime(plan)) throw new Error('Shopee minta waktu jemput dan tidak ada yang dipilih');
    return body;
  }

  throw new Error(`Shopee tidak menyebut metode pengiriman: ${JSON.stringify(plan?.needed ?? {})}`);
}

/**
 * The method for a whole selection, a few at a time.
 *
 * One read per order, because the answer is per order: two parcels on the same courier
 * can be offered different windows, and an order already collected is offered none. An
 * order Shopee will not describe is not a reason to stop - it is recorded as unknown and
 * fails on its own when the shipment is attempted.
 */
export async function shippingMethods(orderSns, { config, auth, call = callShopApi, concurrency = 4 } = {}) {
  const queue = [...new Set(orderSns)];
  const plans = {};
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const orderSn = queue.shift();
      try {
        plans[orderSn] = await shippingMethod(orderSn, { config, auth, call });
      } catch (error) {
        plans[orderSn] = { id: orderSn, method: 'unknown', fields: [], error: error.message };
      }
    }
  }));
  return plans;
}
