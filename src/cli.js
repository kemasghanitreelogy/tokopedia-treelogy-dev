import { loadConfig, requireAppCredentials, redirectUri } from './config.js';
import { buildAuthorizeUrl, refreshAccessToken, persistTokens } from './auth.js';
import { callApi, ApiError, accessTokenExpired } from './client.js';
import { fetchAuthorizedShops, persistShop } from './shops.js';
import { searchOrders, getOrderDetail, getTracking, getPackage, firstPackageId } from './orders.js';
import { createState } from './state.js';
import { loadTokenBundle, saveTokenBundle, BlobNotConfiguredError } from './token-store.js';
import { openBrowser } from './open-browser.js';
import { mask, ok, fail, warn, info, humanTime } from './format.js';
import { signRequest } from './sign.js';
import { collectOrders, summarize, CHANNELS, STAGES } from './omni.js';
import { resolveRange } from './range.js';
import { buildPicklist } from './picklist.js';
import { readCatalog } from './inventory.js';
import { loadLedger, saveLedger, seedLedger, emptyLedger, masterQty } from './ledger.js';
import { planSync, applySync, describePlan } from './stock-sync.js';
import { runSync, loadSyncLedger } from './mekari/sync.js';
import { ensureCustomers, findDepositAccount } from './mekari/setup.js';
import { isMekariConfigured } from './mekari/client.js';
import { webhookStatus, registerShopee, registerTikTok, registerShopify, webhookUrl, baseUrl } from './webhooks/register.js';
import { recoverShopee } from './webhooks/recover.js';

const USAGE = `tts - TikTok Shop Open API client (ID / Tokopedia)

Usage:
  npm run authorize           Approve via the official link, wait for the hosted callback
  npm run authorize -- --tokopedia        ... via Tokopedia Seller Center instead
  npm run authorize -- <url>              ... via a Partner Center "Copy authorisation link"
  npm run pull                Pull the stored token bundle from Vercel Blob into .env
  npm run url                 Print the authorization URL and the redirect URL to register
  npm run refresh             Refresh the access token (and sync it to Blob)
  npm run shops               List authorized shops and save shop_cipher
  npm run orders [status]     Recent orders with status, carrier and tracking number
  npm run track <order_id>    Carrier timeline plus package detail for one order
  npm run omni [range]        Omnichannel summary. range: today | 7d | 14d | 30d
                              or two dates: npm run omni -- 2026-08-15 2026-09-08
  npm run pick [range]        Picklist gudang: SKU yang harus diambil hari ini
  npm run stock               Stok per SKU di semua kanal + selisih vs ledger
  npm run stock:seed          Isi ledger master dari stok kanal saat ini
  npm run stock:plan          Rencana sinkronisasi (dry-run, tidak menulis apa pun)
  npm run stock:apply         Terapkan rencana ke marketplace (butuh --yes)
  npm run shopify             Cek koneksi Shopify (toko, produk, pesanan)
  npm run mekari:setup        Siapkan pelanggan per channel di Jurnal (butuh --yes)
  npm run mekari:plan         Rencana faktur ke Jurnal (dry-run, tidak menulis)
  npm run mekari:sync         Kirim faktur ke Jurnal (butuh --yes)
  npm run hooks               Status webhook ketiga platform
  npm run hooks:register      Daftarkan URL webhook (butuh --yes)
  npm run hooks:recover       Ambil push Shopee yang sempat gagal terkirim
  npm run doctor              End-to-end health check
  npm run api -- <METHOD> <path> [key=value ...] [--body '<json>']

Examples:
  npm run api -- GET /seller/202309/shops
  npm run api -- GET /product/202312/products/search page_size=10
`;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printShops(shops) {
  shops.forEach((shop, index) => {
    console.log(`  [${index}] ${shop.name ?? shop.shop_name ?? '(unnamed)'}`);
    console.log(`      id      : ${shop.id ?? shop.shop_id ?? '-'}`);
    console.log(`      region  : ${shop.region ?? '-'}   seller_type: ${shop.seller_type ?? '-'}`);
    console.log(`      code    : ${shop.code ?? '-'}`);
    console.log(`      cipher  : ${mask(shop.cipher ?? shop.shop_cipher, 6)}`);
  });
}

/** Write a bundle fetched from Blob into .env and the in-memory config. */
function applyBundle(config, bundle) {
  persistTokens(config, {
    accessToken: bundle.tokens?.accessToken ?? '',
    refreshToken: bundle.tokens?.refreshToken ?? '',
    accessTokenExpireAt: bundle.tokens?.accessTokenExpireAt ?? 0,
    refreshTokenExpireAt: bundle.tokens?.refreshTokenExpireAt ?? 0,
    openId: bundle.tokens?.openId ?? '',
    sellerName: bundle.tokens?.sellerName ?? '',
  });
  if (bundle.shop) persistShop(config, bundle.shop);
}

function reportBundle(config, bundle) {
  console.log(ok('token bundle written to .env'));
  console.log(`        access expires : ${humanTime(config.accessTokenExpireAt)}`);
  console.log(`        refresh expires: ${humanTime(config.refreshTokenExpireAt)}`);
  if (bundle.shop) {
    console.log(`        shop           : ${config.shopName || '(unnamed)'} (id ${config.shopId})`);
    console.log(`        shop_cipher    : ${mask(config.shopCipher, 6)}`);
  } else {
    console.log(warn('the callback stored no shop - run `npm run shops`'));
  }
}

const STAGE_LABEL = {
  unpaid: 'belum bayar', to_ship: 'siap kirim', shipping: 'dikirim',
  delivered: 'terkirim', completed: 'selesai', cancelled: 'batal', returned: 'retur',
};

const rupiah = (n) => 'Rp' + Math.round(n).toLocaleString('id-ID');

/** Terminal twin of the hosted dashboard - same numbers, no browser. */
async function cmdOmni(config, args = []) {
  // `omni today`, `omni 30d`, or `omni 2026-08-15 2026-09-08`.
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const range = resolveRange(
    dates.length === 2 ? { from: dates[0], to: dates[1] } : { preset: args[0] },
  );

  const data = await collectOrders({ range });
  const { all, byChannel } = summarize(data.orders);

  for (const [channel, message] of Object.entries(data.errors)) {
    console.log(warn(`${channel} tidak terbaca - ${message}`));
  }
  if (data.truncated.length > 0) {
    console.log(warn(`dipotong di ${data.maxPerPlatform} pesanan untuk ${data.truncated.join(' dan ')}`));
  }

  console.log(`\n  ${range.label}  (${range.from} s/d ${range.to})`);
  console.log(`  ${String(all.count).padStart(5)} pesanan   ${rupiah(all.revenue)}`);
  console.log(`  ${String(all.actionable).padStart(5)} perlu tindakan (belum bayar + siap kirim)\n`);

  const width = Math.max(...Object.values(CHANNELS).map((c) => c.label.length));
  for (const [id, meta] of Object.entries(CHANNELS)) {
    const bucket = byChannel[id];
    const stages = STAGES.filter((s) => bucket.stages[s] > 0)
      .map((s) => `${STAGE_LABEL[s]} ${bucket.stages[s]}`)
      .join(', ');
    console.log(`  ${meta.label.padEnd(width)}  ${String(bucket.count).padStart(4)}  ${rupiah(bucket.revenue).padStart(14)}`);
    if (stages) console.log(`  ${' '.repeat(width)}        ${stages}`);
  }
  console.log();
  return 0;
}

/** Read-only connection check for the Shopify half. */
async function cmdShopify() {
  const { loadShopifyConfig, isShopifyConfigured } = await import('./shopify/config.js');
  const { fetchShop, fetchProducts, fetchOrders } = await import('./shopify/shop.js');
  const sc = loadShopifyConfig();

  console.log(`\n  domain : ${sc.domain || '(belum diisi)'}`);
  console.log(`  token  : ${mask(sc.token, 6)}`);
  console.log(`  versi  : ${sc.apiVersion}\n`);

  if (!isShopifyConfigured(sc)) {
    console.log(fail('SHOPIFY_SHOP_DOMAIN belum diisi'));
    console.log('        Isi dengan nama toko, contoh: SHOPIFY_SHOP_DOMAIN=namatoko');
    return 1;
  }

  const shop = await fetchShop(sc);
  console.log(ok(`terhubung ke ${shop.name} (${shop.myshopifyDomain}, ${shop.currencyCode})`));

  const products = await fetchProducts(sc);
  console.log(ok(`${products.length} varian ber-SKU`));
  for (const p of products.slice(0, 5)) {
    console.log(`        ${p.sku.padEnd(24)} stok ${String(p.qty).padStart(5)}  ${rupiah(p.price)}`);
  }

  const to = Math.floor(Date.now() / 1000);
  const orders = await fetchOrders({ since: to - 7 * 86400, until: to, config: sc });
  console.log(ok(`${orders.length} pesanan dalam 7 hari`));
  const tally = {};
  for (const o of orders) tally[o.stage] = (tally[o.stage] ?? 0) + 1;
  for (const [stage, n] of Object.entries(tally)) console.log(`        ${STAGE_LABEL[stage] ?? stage}: ${n}`);
  console.log();
  return 0;
}

async function cmdPick(config, args = []) {
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const range = resolveRange(dates.length === 2 ? { from: dates[0], to: dates[1] } : { preset: args[0] });
  const data = await collectOrders({ range });
  const pl = buildPicklist(data.orders);

  console.log(`\n  Picklist - ${range.label}`);
  console.log(`  ${pl.orderCount} pesanan siap kirim, ${pl.unitCount} unit, ${pl.skuCount} SKU\n`);
  if (pl.items.length === 0) {
    console.log(info('tidak ada yang perlu dipetik'));
    return 0;
  }
  console.log('  SKU'.padEnd(28) + 'QTY'.padStart(5) + '   TOKPED  TIKTOK  SHOPEE   PRODUK');
  for (const i of pl.items) {
    console.log(
      '  ' + i.sku.padEnd(26) + String(i.qty).padStart(5) +
      String(i.byChannel.tokopedia).padStart(9) + String(i.byChannel.tiktok_shop).padStart(8) +
      String(i.byChannel.shopee).padStart(8) + '   ' + (i.name || '').slice(0, 34),
    );
  }
  console.log();
  return 0;
}

/** Read-only cross-channel stock view, including how far each channel is from the ledger. */
async function cmdStock(config) {
  const [catalog, ledger] = await Promise.all([readCatalog(), loadLedger().catch(() => null)]);
  for (const [channel, message] of Object.entries(catalog.errors)) {
    console.log(warn(`${channel} tidak terbaca - ${message}`));
  }
  if (!ledger) console.log(warn('ledger belum ada - jalankan `npm run stock:seed`'));

  console.log('\n  SKU'.padEnd(28) + 'LEDGER'.padStart(7) + 'TIKTOK'.padStart(8) + 'SHOPEE'.padStart(8) + '   catatan');
  for (const entry of catalog.skus) {
    const master = ledger ? masterQty(ledger, entry.sku) : null;
    const tt = entry.tiktok?.qty ?? null;
    const sp = entry.shopee?.qty ?? null;
    if (tt === null && sp === null) continue;

    const notes = [];
    if (master === null) notes.push('di luar ledger');
    if (tt !== null && sp !== null && tt !== sp) notes.push('kanal beda');
    if (entry.tiktok?.conflict || entry.shopee?.conflict) notes.push('listing ganda beda stok');

    console.log(
      '  ' + entry.sku.padEnd(26) + String(master ?? '-').padStart(7) +
      String(tt ?? '-').padStart(8) + String(sp ?? '-').padStart(8) +
      (notes.length ? '   ' + notes.join(', ') : ''),
    );
  }
  console.log();
  return 0;
}

async function cmdStockSeed(config) {
  const catalog = await readCatalog();
  if (Object.keys(catalog.errors).length > 0) {
    throw new Error(`tidak menyemai ledger dari katalog yang tidak lengkap: ${JSON.stringify(catalog.errors)}`);
  }
  const existing = (await loadLedger().catch(() => null)) ?? emptyLedger();
  const { ledger, seeded, conflicts } = seedLedger(catalog, existing);
  await saveLedger(ledger);

  console.log(ok(`${seeded.length} SKU ditambahkan ke ledger (${Object.keys(ledger.skus).length} total)`));
  for (const c of conflicts) {
    console.log(warn(`${c.sku}: tiktok ${c.tiktok} vs shopee ${c.shopee} - dipakai ${c.chosen} (terendah), perlu ditinjau`));
  }
  return 0;
}

async function planCurrent() {
  const [catalog, ledger] = await Promise.all([readCatalog(), loadLedger()]);
  if (!ledger) throw new Error('ledger belum ada - jalankan `npm run stock:seed`');
  if (Object.keys(catalog.errors).length > 0) {
    throw new Error(`katalog tidak lengkap, membatalkan: ${JSON.stringify(catalog.errors)}`);
  }
  return { plan: planSync({ ledger, catalog }), catalog, ledger };
}

function printPlan(plan) {
  console.log(`\n  ${describePlan(plan)}\n`);
  const show = (rows, label) => {
    for (const r of rows) {
      console.log(`  ${label} ${r.sku.padEnd(24)} ${r.channel.padEnd(7)} ${String(r.from).padStart(5)} -> ${String(r.to).padEnd(5)} ${r.reason ?? ''}`);
    }
  };
  show(plan.changes, 'ubah  ');
  show(plan.review, 'TINJAU');
  show(plan.blocked, 'BLOKIR');
  if (plan.unmanaged.length > 0) console.log(`\n  ${plan.unmanaged.length} SKU di luar ledger (tidak disentuh)`);
  if (plan.missing.length > 0) console.log(`  ${plan.missing.length} SKU di ledger tanpa listing hidup: ${plan.missing.join(', ')}`);
}

async function cmdStockPlan(config) {
  const { plan } = await planCurrent();
  printPlan(plan);
  console.log(`\n${info('dry-run: tidak ada yang ditulis. Terapkan dengan `npm run stock:apply -- --yes`')}\n`);
  return 0;
}

async function cmdStockApply(config, args = []) {
  const { plan } = await planCurrent();
  printPlan(plan);

  if (plan.changes.length === 0) {
    console.log(`\n${info('tidak ada yang perlu ditulis')}\n`);
    return 0;
  }
  if (!args.includes('--yes')) {
    console.log(`\n${warn('belum diterapkan. Ulangi dengan --yes untuk menulis ke marketplace')}\n`);
    return 1;
  }

  const result = await applySync(plan, { dryRun: false });
  console.log();
  for (const r of result.results) {
    const line = `${r.sku.padEnd(24)} ${r.channel.padEnd(7)} ${r.from} -> ${r.to}`;
    console.log(r.status === 'ok' ? ok(line) : fail(`${line}  ${r.error ?? ''}`));
  }
  console.log(`\n  ${result.succeeded} berhasil, ${result.failed} gagal dari ${result.attempted}\n`);
  return result.failed > 0 ? 1 : 0;
}

async function cmdAuthorize(config, args = []) {
  requireAppCredentials(config);
  if (!config.serviceId) throw new Error('SERVICE_ID missing in .env');
  if (!config.blobToken) throw new BlobNotConfiguredError();

  const { state } = createState(config.appSecret);
  const links = buildAuthorizeUrl({ serviceId: config.serviceId, state });

  // Two entry points exist. `partner-service-detail` reports the official one as
  // services.tiktokshop.com (auth_type 1); the Tokopedia Seller Center link is what
  // an ID seller reaches by browsing. They are not interchangeable: an authorization
  // completed through the wrong door can yield a token carrying no API scopes.
  const useTokopedia = args.includes('--tokopedia');
  const authorizeUrl = useTokopedia ? links.tokopediaUrl : links.url;
  const source = useTokopedia ? 'Tokopedia Seller Center' : 'official (services.tiktokshop.com)';

  // A custom link from Partner Center's "Copy authorisation link" overrides both.
  const override = args.find((a) => a.startsWith('https://'));
  const finalUrl = override
    ? `${override}${override.includes('?') ? '&' : '?'}state=${encodeURIComponent(state)}`
    : authorizeUrl;

  console.log(`\nAuthorize via: ${override ? 'custom link you supplied' : source}`);
  // Tokopedia drops `state`, so the callback cannot echo our nonce back. Match on
  // freshness instead: any bundle stored after this moment is the one we triggered.
  const startedAt = Date.now();

  console.log(`\nRedirect URL (must match Partner Center):\n  ${redirectUri(config)}\n`);

  const opened = openBrowser(finalUrl);
  console.log(opened ? info('opening the authorization page...') : warn('open this URL manually:'));
  console.log(`\n  ${finalUrl}\n`);
  console.log(info('waiting for the hosted callback to store the tokens (5 min timeout)...'));

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const bundle = await loadTokenBundle({ token: config.blobToken });
    if (bundle && Date.parse(bundle.saved_at) > startedAt) {
      console.log(`\n${info('callback completed')}`);
      applyBundle(config, bundle);
      reportBundle(config, bundle);
      return 0;
    }
  }

  console.log(fail('timed out waiting for the callback'));
  console.log('        Inspect the function logs with:  vercel logs');
  return 1;
}

async function cmdPull(config) {
  if (!config.blobToken) throw new BlobNotConfiguredError();
  const bundle = await loadTokenBundle({ token: config.blobToken });
  if (!bundle) {
    console.log(warn('no token bundle stored yet - run `npm run authorize`'));
    return 1;
  }
  console.log(`\nBundle saved at ${bundle.saved_at}`);
  applyBundle(config, bundle);
  reportBundle(config, bundle);
  return 0;
}

async function cmdUrl(config) {
  if (!config.serviceId) throw new Error('SERVICE_ID missing in .env');
  const { state } = createState(config.appSecret || 'unset');
  const { url, tokopediaUrl } = buildAuthorizeUrl({ serviceId: config.serviceId, state });

  console.log(`\nRegister this redirect URL in Partner Center:\n  ${redirectUri(config)}\n`);
  console.log('Then open ONE of these and approve as the seller.\n');
  console.log('  ID / Tokopedia seller (use this one):');
  console.log(`    ${tokopediaUrl}\n`);
  console.log('  Global TikTok Shop seller:');
  console.log(`    ${url}\n`);
  console.log('Prefer `npm run authorize` - it does this and collects the tokens for you.\n');
}

async function cmdRefresh(config) {
  requireAppCredentials(config);
  const tokens = await refreshAccessToken({ config });
  persistTokens(config, tokens);

  // Keep the shared bundle in step so the deployment never falls back to a stale token.
  if (config.blobToken) {
    await saveTokenBundle({
      tokens,
      nonce: 'refresh',
      shop: config.shopCipher
        ? { id: config.shopId, cipher: config.shopCipher, name: config.shopName }
        : null,
      token: config.blobToken,
    });
    console.log(ok('refreshed and synced to Vercel Blob'));
  } else {
    console.log(ok('access token refreshed locally'));
  }
  console.log(`        access expires : ${humanTime(tokens.accessTokenExpireAt)}`);
  console.log(`        refresh expires: ${humanTime(tokens.refreshTokenExpireAt)}`);
}

async function cmdShops(config) {
  requireAppCredentials(config);
  if (!config.accessToken) throw new Error('No ACCESS_TOKEN - run `npm run authorize` first');

  const { shops, requestId } = await fetchAuthorizedShops(config);
  console.log(`\nAuthorized shops: ${shops.length}   [request_id ${requestId}]\n`);
  if (shops.length === 0) {
    console.log(warn('No shops returned. The seller may have revoked the app,'));
    console.log('        or this access_token belongs to a different app.\n');
    return;
  }

  printShops(shops);
  const saved = persistShop(config, shops[0]);
  console.log(`\n${ok(`saved SHOP_ID / SHOP_CIPHER / SHOP_NAME for "${saved.name}"`)}\n`);
  if (shops.length > 1) {
    console.log(info('Multiple shops found; the first was saved. Edit .env to pick another.\n'));
  }
}

const localDateTime = (seconds) =>
  seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-';

async function cmdOrders(config, args) {
  requireAppCredentials(config);
  if (!config.shopCipher) throw new Error('No SHOP_CIPHER - run `npm run authorize` first');

  const status = args.find((a) => !a.startsWith('-'))?.toUpperCase() ?? null;
  const { orders, requestId } = await searchOrders({ config, pageSize: 20, status });

  console.log(`\nOrders: ${orders.length}${status ? ` (status ${status})` : ''}   [request_id ${requestId}]\n`);
  if (orders.length === 0) {
    console.log(info('nothing matched.\n'));
    return 0;
  }

  // The search response omits carrier fields; the detail endpoint carries them.
  const detail = await getOrderDetail({ config, ids: orders.map((o) => o.id) });
  const byId = new Map(detail.orders.map((o) => [o.id, o]));

  console.log(
    `  ${'ORDER ID'.padEnd(20)} ${'CREATED'.padEnd(17)} ${'STATUS'.padEnd(21)} ${'CARRIER'.padEnd(16)} TRACKING`,
  );
  for (const order of orders) {
    const full = byId.get(order.id) ?? {};
    console.log(
      `  ${String(order.id).padEnd(20)} ${localDateTime(order.create_time).padEnd(17)} ` +
        `${String(order.status ?? '-').padEnd(21)} ` +
        `${String(full.shipping_provider ?? full.delivery_option_name ?? '-').slice(0, 15).padEnd(16)} ` +
        `${full.tracking_number || '-'}`,
    );
  }
  console.log(`\n${info('detail for one order:  npm run track -- <order_id>')}\n`);
  return 0;
}

async function cmdTrack(config, args) {
  requireAppCredentials(config);
  const orderId = args.find((a) => /^\d+$/.test(a));
  if (!orderId) throw new Error('Usage: npm run track -- <order_id>');

  const { orders } = await getOrderDetail({ config, ids: orderId });
  const order = orders[0];
  if (!order) throw new Error(`Order ${orderId} not found`);

  console.log(`\nOrder ${order.id}`);
  console.log(`  status          : ${order.status}`);
  console.log(`  platform        : ${order.commerce_platform ?? '-'}`);
  console.log(`  carrier         : ${order.shipping_provider ?? '-'} (${order.delivery_option_name ?? '-'})`);
  console.log(`  tracking number : ${order.tracking_number || '-'}`);
  console.log(`  placed          : ${localDateTime(order.create_time)}`);
  console.log(`  ready to ship   : ${localDateTime(order.rts_time)}`);
  console.log(`  collected       : ${localDateTime(order.collection_time)}`);
  console.log(`  delivered       : ${localDateTime(order.delivery_time)}`);

  const { events, requestId } = await getTracking({ config, orderId });
  console.log(`\n  Carrier timeline (${events.length})   [request_id ${requestId}]`);
  if (events.length === 0) {
    console.log(warn('empty - the platform prunes events once an order settles'));
  } else {
    for (const event of events) {
      const when = new Date(event.update_time_millis ?? 0).toISOString().slice(0, 19).replace('T', ' ');
      console.log(`    ${when}  [${event.action_code}] ${event.description}`);
    }
  }

  const packageId = firstPackageId(order);
  if (packageId) {
    const { pkg } = await getPackage({ config, packageId });
    console.log(`\n  Package ${packageId}`);
    console.log(`    status   : ${pkg.package_status ?? '-'} / ${pkg.package_sub_status ?? '-'}`);
    console.log(`    carrier  : ${pkg.shipping_provider_name ?? '-'}  (${pkg.handover_method ?? '-'})`);
    const w = pkg.weight ?? {};
    const d = pkg.dimension ?? {};
    console.log(`    weight   : ${w.value ?? '-'} ${w.unit ?? ''}`);
    console.log(`    size     : ${d.length ?? '-'} x ${d.width ?? '-'} x ${d.height ?? '-'} ${d.unit ?? ''}`);
  }
  console.log();
  return 0;
}

async function cmdApi(config, args) {
  requireAppCredentials(config);

  const bodyIndex = args.indexOf('--body');
  let body = null;
  if (bodyIndex !== -1) {
    body = JSON.parse(args[bodyIndex + 1]);
    args = [...args.slice(0, bodyIndex), ...args.slice(bodyIndex + 2)];
  }

  const [method, path, ...pairs] = args;
  if (!method || !path) throw new Error('Usage: npm run api -- <METHOD> <path> [key=value ...]');

  const query = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`Bad query param "${pair}" - expected key=value`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const { data, requestId, httpStatus } = await callApi({
    config,
    method: method.toUpperCase(),
    path,
    query,
    body,
  });
  console.log(`HTTP ${httpStatus}  [request_id ${requestId}]`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdDoctor(config) {
  console.log('\nTikTok Shop integration doctor\n');
  let failed = 0;
  const step = (label) => console.log(`\n${label}`);

  step('1. App credentials');
  if (config.appKey && config.appSecret) {
    console.log(ok(`APP_KEY ${mask(config.appKey)}  APP_SECRET ${mask(config.appSecret)}`));
  } else {
    console.log(fail('APP_KEY / APP_SECRET missing in .env'));
    failed += 1;
  }

  step('2. Signature algorithm');
  signRequest({ path: '/t', query: { app_key: 'k' }, appSecret: 'secret' });
  console.log(ok('deterministic hex; base excludes sign/access_token'));

  step('3. API reachability (unsigned probe)');
  try {
    const response = await fetch(`${config.apiBaseUrl}/seller/202309/shops`);
    const payload = await response.json();
    if (payload.code === 36009004) {
      console.log(ok(`${config.apiBaseUrl} reachable; rejects unsigned request as expected`));
    } else {
      console.log(warn(`unexpected probe response: code ${payload.code} - ${payload.message}`));
    }
  } catch (error) {
    console.log(fail(`cannot reach ${config.apiBaseUrl}: ${error.message}`));
    failed += 1;
  }

  step('4. Hosted callback');
  console.log(`        register in Partner Center: ${redirectUri(config)}`);
  try {
    const response = await fetch(`${config.publicBaseUrl}/api/status`);
    if (response.ok) {
      const status = await response.json();
      const missing = Object.entries(status.env)
        .filter(([, present]) => !present)
        .map(([key]) => key);
      console.log(ok(`deployment live; stored tokens: ${status.tokens.state}`));
      if (missing.length > 0) {
        console.log(fail(`missing env on the deployment: ${missing.join(', ')}`));
        failed += 1;
      } else {
        console.log(ok('all required env vars present on the deployment'));
      }
    } else {
      console.log(fail(`GET /api/status returned HTTP ${response.status} - deployed yet?`));
      failed += 1;
    }
  } catch (error) {
    console.log(fail(`cannot reach ${config.publicBaseUrl}: ${error.message}`));
    failed += 1;
  }

  step('5. Blob store (local access)');
  if (!config.blobToken) {
    console.log(fail('BLOB_READ_WRITE_TOKEN missing - run `vercel env pull .env.local --yes`'));
    failed += 1;
  } else {
    try {
      const bundle = await loadTokenBundle({ token: config.blobToken });
      console.log(
        bundle
          ? ok(`bundle present, saved ${bundle.saved_at}`)
          : warn('reachable but empty - run `npm run authorize`'),
      );
    } catch (error) {
      console.log(fail(`blob read failed: ${error.message}`));
      failed += 1;
    }
  }

  step('6. Access token');
  if (!config.accessToken) {
    console.log(fail('ACCESS_TOKEN missing - run `npm run authorize`'));
    failed += 1;
  } else if (accessTokenExpired(config)) {
    console.log(warn(`expired at ${humanTime(config.accessTokenExpireAt)} - will auto-refresh`));
  } else {
    console.log(ok(`${mask(config.accessToken)}  expires ${humanTime(config.accessTokenExpireAt)}`));
  }

  step('7. Authorized shops (live call)');
  if (!config.accessToken) {
    console.log(info('skipped - no access token yet'));
  } else {
    try {
      const { shops, requestId } = await fetchAuthorizedShops(config);
      console.log(ok(`${shops.length} shop(s)  [request_id ${requestId}]`));
      printShops(shops);
    } catch (error) {
      console.log(fail(describeApiError(error)));
      failed += 1;
    }
  }

  step('8. Shop context');
  if (config.shopCipher) {
    console.log(
      ok(`${config.shopName || '(unnamed)'}  id ${config.shopId}  cipher ${mask(config.shopCipher, 6)}`),
    );
  } else {
    console.log(warn('SHOP_CIPHER not saved yet - run `npm run shops`'));
  }

  console.log(
    failed === 0 ? `\n${ok('all critical checks passed')}\n` : `\n${fail(`${failed} check(s) failed`)}\n`,
  );
  return failed === 0 ? 0 : 1;
}

function describeApiError(error) {
  if (!(error instanceof ApiError)) return error.message;
  const parts = [error.message];
  if (error.code !== undefined) parts.push(`code ${error.code}`);
  if (error.requestId) parts.push(`request_id ${error.requestId}`);
  return parts.join(' | ');
}

/** Orders for the Mekari commands, over whatever window was asked for. */
async function mekariOrders(args) {
  const preset = args.find((a) => /^--(today|7d|14d|30d)$/.test(a))?.slice(2) ?? '30d';
  const { orders, errors } = await collectOrders({ range: resolveRange({ preset }), tracking: false });
  // Posting is additive, so a dead channel only delays its own orders - but say so, never
  // let a missing channel read as "nothing to post".
  for (const [channel, message] of Object.entries(errors)) {
    console.log(warn(`${channel} gagal dibaca: ${message} - pesanannya dilewati run ini`));
  }
  return orders;
}

const depositArg = (args) =>
  args.find((a) => a.startsWith('--deposit='))?.slice('--deposit='.length)
  ?? process.env.MEKARI_DEPOSIT_ACCOUNT
  ?? null;

function printSyncResult(result) {
  const failed = result.results.filter((r) => r.status === 'failed');
  const total = result.results.reduce((n, r) => n + (r.total ?? 0), 0);

  console.log(`\n  ${result.considered} pesanan diproses` +
    `  ·  dibuat ${result.created}  ·  sudah ada ${result.exists}  ·  gagal ${result.failed}`);
  console.log(`  nilai  Rp${total.toLocaleString('id-ID')}\n`);

  for (const r of failed) console.log(fail(`${r.customId}: ${r.error}`));
  return failed.length === 0 ? 0 : 1;
}

async function cmdMekariSetup(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }

  const preview = await ensureCustomers({ dryRun: true });
  console.log(`\n  sudah ada : ${preview.existing.join(', ') || '-'}`);
  console.log(`  akan dibuat: ${preview.missing.join(', ') || '-'}\n`);

  const deposit = depositArg(args);
  if (deposit) {
    const account = await findDepositAccount(deposit);
    console.log(account ? ok(`akun deposit "${deposit}" ditemukan`) : fail(`akun deposit "${deposit}" tidak ada di Jurnal`));
    if (!account) return 1;
  }

  if (preview.missing.length === 0) { console.log(`\n${ok('tidak ada yang perlu dibuat')}\n`); return 0; }
  if (!args.includes('--yes')) { console.log(`\n${warn('belum dibuat. Ulangi dengan --yes')}\n`); return 1; }

  const result = await ensureCustomers({ dryRun: false });
  console.log(`\n${ok(`pelanggan dibuat: ${result.created.join(', ')}`)}\n`);
  return 0;
}

async function cmdMekariPlan(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }

  const orders = await mekariOrders(args);
  const result = await runSync({ orders, depositTo: depositArg(args), dryRun: true, limit: 1000 });
  const code = printSyncResult(result);
  console.log(info('dry-run: tidak ada yang ditulis. Kirim dengan `npm run mekari:sync -- --yes`') + '\n');
  return code;
}

async function cmdMekariSync(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }

  const orders = await mekariOrders(args);
  const depositTo = depositArg(args);

  const preview = await runSync({ orders, depositTo, dryRun: true, limit: 1000 });
  printSyncResult(preview);

  if (preview.considered === 0) { console.log(`${ok('semua pesanan sudah ada di Jurnal')}\n`); return 0; }
  if (!args.includes('--yes')) { console.log(`${warn('belum dikirim. Ulangi dengan --yes untuk menulis ke Jurnal')}\n`); return 1; }

  // The customers have to exist before the first invoice can name one.
  await ensureCustomers({ dryRun: false });

  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length)) || 1000;
  const result = await runSync({ orders, depositTo, dryRun: false, limit });
  if (result.skipped) { console.log(`${warn('run lain sedang berjalan, dilewati')}\n`); return 0; }
  return printSyncResult(result);
}

async function cmdMekariStatus() {
  const ledger = await loadSyncLedger();
  const rows = Object.entries(ledger.orders ?? {});
  const total = rows.reduce((n, [, v]) => n + (v.total ?? 0), 0);
  console.log(`\n  ${rows.length} faktur tercatat  ·  Rp${total.toLocaleString('id-ID')}\n`);
  for (const [customId, row] of rows.slice(-10)) {
    console.log(`  ${customId.padEnd(34)} faktur ${String(row.invoice_id ?? '-').padEnd(12)} ${row.at ?? ''}`);
  }
  console.log('');
  return 0;
}

function printHookStatus(status, config) {
  console.log(`\n  URL dasar: ${baseUrl(config)}\n`);

  const shopee = status.shopee;
  if (shopee.error) console.log(fail(`Shopee    ${shopee.error}`));
  else if (!shopee.callbackUrl) console.log(warn('Shopee    belum ada callback_url'));
  else {
    const matches = shopee.callbackUrl === webhookUrl('shopee', config);
    console.log((matches ? ok : warn)(`Shopee    ${shopee.callbackUrl}`));
    console.log(`          push aktif: ${shopee.enabled.join(', ') || '(tidak ada)'}`);
  }

  const tiktok = status.tiktok;
  if (tiktok.error) console.log(fail(`TikTok    ${tiktok.error}`));
  else if (tiktok.total === 0) console.log(warn('TikTok    belum ada langganan'));
  else for (const w of tiktok.webhooks) console.log(ok(`TikTok    ${w.event_type ?? '?'} -> ${w.address ?? '?'}`));

  const shopify = status.shopify;
  if (shopify.error) console.log(fail(`Shopify   ${shopify.error}`));
  else if (shopify.total === 0) console.log(warn('Shopify   belum ada langganan'));
  else for (const w of shopify.webhooks) console.log(ok(`Shopify   ${w.topic} -> ${w.uri}`));

  console.log('');
}

async function cmdHooks(config) {
  printHookStatus(await webhookStatus(), config);
  console.log(info('daftarkan dengan `npm run hooks:register -- --yes`') + '\n');
  return 0;
}

async function cmdHooksRegister(config, args = []) {
  const status = await webhookStatus();
  printHookStatus(status, config);

  const only = args.find((a) => /^--(shopee|tiktok|shopify)$/.test(a))?.slice(2) ?? null;
  const targets = (only ? [only] : ['shopee', 'tiktok', 'shopify'])
    .map((name) => `${name} -> ${webhookUrl(name, config)}`);
  console.log(`  akan didaftarkan:\n${targets.map((t) => `    ${t}`).join('\n')}\n`);

  if (!args.includes('--yes')) { console.log(`${warn('belum didaftarkan. Ulangi dengan --yes')}\n`); return 1; }

  const run = async (name, fn) => {
    if (only && only !== name) return;
    try {
      const result = await fn();
      console.log(ok(`${name}: ${JSON.stringify(result)}`));
    } catch (error) {
      console.log(fail(`${name}: ${error.message}`));
    }
  };

  await run('shopee', registerShopee);
  await run('tiktok', registerTikTok);
  await run('shopify', registerShopify);
  console.log('');
  return 0;
}

async function cmdHooksRecover(config, args = []) {
  const dryRun = !args.includes('--yes');
  const result = await recoverShopee({ dryRun });
  console.log(`\n  ${result.messages} pesan tertunda` +
    (dryRun ? '' : `  ·  dibuat ${result.created}  ·  sudah ada ${result.exists}  ·  gagal ${result.failed}`));
  for (const s of result.seen.slice(0, 20)) console.log(`    ${s.id.padEnd(22)} code ${s.code}  ${s.status}`);
  console.log(dryRun ? `\n${info('dry-run: antrean Shopee tidak dikosongkan. Proses dengan --yes')}\n` : '\n');
  return 0;
}

const COMMANDS = {
  authorize: cmdAuthorize,
  pull: cmdPull,
  url: cmdUrl,
  refresh: cmdRefresh,
  shops: cmdShops,
  orders: cmdOrders,
  track: cmdTrack,
  omni: cmdOmni,
  pick: cmdPick,
  shopify: cmdShopify,
  stock: cmdStock,
  'stock:seed': cmdStockSeed,
  'stock:plan': cmdStockPlan,
  'stock:apply': cmdStockApply,
  'mekari:setup': cmdMekariSetup,
  'mekari:plan': cmdMekariPlan,
  'mekari:sync': cmdMekariSync,
  'mekari:status': cmdMekariStatus,
  hooks: cmdHooks,
  'hooks:register': cmdHooksRegister,
  'hooks:recover': cmdHooksRecover,
  doctor: cmdDoctor,
  api: cmdApi,
};

export async function run(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command "${command}"\n`);
    console.log(USAGE);
    return 1;
  }

  const config = loadConfig();
  try {
    return (await handler(config, args)) ?? 0;
  } catch (error) {
    console.error(`\n${fail(describeApiError(error))}\n`);
    return 1;
  }
}
