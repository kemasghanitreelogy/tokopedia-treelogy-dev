/**
 * Which order a Shopify push is about.
 *
 * orders/paid posts the order itself. orders/edited does not: its body is
 * `{ order_edit: { order_id, line_items: { additions, removals }, ... } }`, with no
 * `admin_graphql_api_id` and no name, so reading it as an order finds nothing and the
 * edit is silently dropped. Only the order id is taken either way - the order is re-read
 * through the Admin API before anything is decided.
 */
export function shopifyPushOrder(body) {
  const edit = body?.order_edit;
  if (edit?.order_id) return { id: edit.order_id, name: '', admin_graphql_api_id: `gid://shopify/Order/${edit.order_id}` };
  return body ?? {};
}
