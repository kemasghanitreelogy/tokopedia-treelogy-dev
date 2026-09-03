import { callApi } from './client.js';

/**
 * Order and fulfillment reads.
 *
 * Endpoint choice follows the highest applicable version in the bundled OAS:
 * order detail is 202507 (newer than 202309), while the search, tracking and package
 * endpoints have no later version.
 */

const ORDER_SEARCH_PATH = '/order/202309/orders/search';
const ORDER_DETAIL_PATH = '/order/202507/orders';
const TRACKING_PATH = (orderId) => `/fulfillment/202309/orders/${orderId}/tracking`;
const PACKAGE_PATH = (packageId) => `/fulfillment/202309/packages/${packageId}`;

/** Newest orders first. `status` filters server-side when given. */
export async function searchOrders({ config, pageSize = 20, status = null, pageToken = null }) {
  const query = { page_size: String(pageSize), sort_field: 'create_time', sort_order: 'DESC' };
  if (pageToken) query.page_token = pageToken;

  const { data, requestId } = await callApi({
    config,
    method: 'POST',
    path: ORDER_SEARCH_PATH,
    query,
    body: status ? { order_status: status } : {},
  });
  return { orders: data.orders ?? [], nextPageToken: data.next_page_token ?? null, requestId };
}

/** Full detail for up to 50 orders, including tracking number and carrier. */
export async function getOrderDetail({ config, ids }) {
  const { data, requestId } = await callApi({
    config,
    method: 'GET',
    path: ORDER_DETAIL_PATH,
    query: { ids: Array.isArray(ids) ? ids.join(',') : String(ids) },
  });
  return { orders: data.orders ?? [], requestId };
}

/**
 * Carrier scan history, newest first.
 *
 * Completed orders return an empty array - the platform prunes the event trail once an
 * order settles, so a durable history has to be harvested while the order is live.
 */
export async function getTracking({ config, orderId }) {
  const { data, requestId } = await callApi({
    config,
    method: 'GET',
    path: TRACKING_PATH(orderId),
  });
  const events = data.tracking ?? [];
  return {
    events: [...events].sort(
      (a, b) => (b.update_time_millis ?? 0) - (a.update_time_millis ?? 0),
    ),
    requestId,
  };
}

export async function getPackage({ config, packageId }) {
  const { data, requestId } = await callApi({
    config,
    method: 'GET',
    path: PACKAGE_PATH(packageId),
  });
  return { pkg: data, requestId };
}

export const firstPackageId = (order) => (order.packages ?? [])[0]?.id ?? null;
