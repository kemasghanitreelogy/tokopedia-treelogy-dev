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
import { backfill } from './db/backfill.js';
import { readCoverage, dbStats, DB_HISTORY_START } from './db/orders.js';
import { isSupabaseConfigured } from './db/client.js';
import { activeSources, rememberOrders } from './orders-source.js';
import { resolveRange, wibDate } from './range.js';
import { buildPicklist } from './picklist.js';
import { readCatalog } from './inventory.js';
import { loadLedger, saveLedger, seedLedger, emptyLedger, masterQty } from './ledger.js';
import { planSync, applySync, describePlan } from './stock-sync.js';
import { runSync, loadSyncLedger } from './mekari/sync.js';
import { ensureCustomers, ensureProducts, ensureReady, findDepositAccount } from './mekari/setup.js';
import { isMekariConfigured, QuotaExhaustedError } from './mekari/client.js';
import { setUpChartOfAccounts, describePolicy } from './mekari/coa.js';
import { restate } from './mekari/restate.js';
import { removeDuplicates } from './mekari/dedupe.js';
import { webhookStatus, registerShopee, registerTikTok, registerShopify, webhookUrl, baseUrl } from './webhooks/register.js';
import { recoverShopee } from './webhooks/recover.js';
import { sendTelegram, notifySyncFailures, notifyStockRisk, isTelegramConfigured } from './notify/telegram.js';
import { syncProductImages, refreshImageManifest } from './mekari/images.js';
import { rebuildLedgerFromJurnal } from './mekari/rebuild.js';
import { pullHistory } from './history/ingest.js';
import { runForecast } from './forecast/engine.js';
import { URGENCY_ORDER } from './forecast/policy.js';
import { fetchWithTimeout, TIMEOUTS } from './http.js';

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
  npm run notify:test         Kirim pesan uji ke Telegram
  npm run images              Tarik gambar produk & varian dari Shopify ke dashboard
  npm run mekari:images       Unggah gambar produk Shopify ke Jurnal & dashboard (butuh --yes)
  npm run mekari:coa          Setel akun ongkir & tag di Jurnal, tampilkan kebijakan per sumber (butuh --yes)
  npm run mekari:restate      Hapus & tulis ulang faktur sejak tanggal tertentu (butuh --yes)
  npm run mekari:dedupe       Cari & hapus faktur kembar di Jurnal (butuh --yes)
  npm run mekari:rebuild      Bangun ulang ledger faktur dari Jurnal (butuh --yes)
  npm run db:backfill         Isi database dari 1 Agustus 2026 sampai sekarang (butuh --yes)
  npm run db:status           Isi database, cakupan per sumber, dan dari mana dashboard membaca
  npm run history:pull        Tarik riwayat penjualan semua kanal ke state (bulan demi bulan)
  npm run forecast            Ramal permintaan & kebutuhan stok per SKU dari riwayat
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
async function applyBundle(config, bundle) {
  // Pulled from Blob, so only .env needs writing - not Blob again.
  await persistTokens(config, {
    accessToken: bundle.tokens?.accessToken ?? '',
    refreshToken: bundle.tokens?.refreshToken ?? '',
    accessTokenExpireAt: bundle.tokens?.accessTokenExpireAt ?? 0,
    refreshTokenExpireAt: bundle.tokens?.refreshTokenExpireAt ?? 0,
    openId: bundle.tokens?.openId ?? '',
    sellerName: bundle.tokens?.sellerName ?? '',
  }, { saveBundle: false });
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
    const bundle = await loadTokenBundle();
    if (bundle && Date.parse(bundle.saved_at) > startedAt) {
      console.log(`\n${info('callback completed')}`);
      await applyBundle(config, bundle);
      reportBundle(config, bundle);
      return 0;
    }
  }

  console.log(fail('timed out waiting for the callback'));
  console.log('        Inspect the function logs with:  vercel logs');
  return 1;
}

async function cmdPull(config) {
  const bundle = await loadTokenBundle();
  if (!bundle) {
    console.log(warn('no token bundle stored yet - run `npm run authorize`'));
    return 1;
  }
  console.log(`\nBundle saved at ${bundle.saved_at}`);
  await applyBundle(config, bundle);
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
  // persistTokens writes .env and the shared Blob bundle together, so the deployment can
  // never fall back to a stale token.
  const tokens = await refreshAccessToken({ config });
  await persistTokens(config, tokens);
  console.log(ok('refreshed and saved to the state store'));
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
    const response = await fetchWithTimeout(`${config.apiBaseUrl}/seller/202309/shops`);
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
    const response = await fetchWithTimeout(`${config.publicBaseUrl}/api/status`);
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
  // Tracking numbers cost an extra Shopee call per batch, and they are worth it: the
  // invoice carries the waybill, which is how a delivery dispute gets settled later.
  const range = resolveRange({ preset });
  const live = await collectOrders({ range, tracking: true });
  const { orders, errors } = live;
  // Posting is additive, so a dead channel only delays its own orders - but say so, never
  // let a missing channel read as "nothing to post".
  for (const [channel, message] of Object.entries(errors)) {
    console.log(warn(`${channel} gagal dibaca: ${message} - pesanannya dilewati run ini`));
  }
  // This run already paid three marketplaces for a fresh, tracked read of the last thirty
  // days. Throwing it away and making the dashboard fetch the same thing again is the
  // waste this whole change exists to remove, so it is kept - and because the read was
  // live and complete, it is what carries the covered window forward every fifteen
  // minutes without anybody running a backfill.
  await rememberOrders(live, range);
  return orders;
}

const depositArg = (args) =>
  args.find((a) => a.startsWith('--deposit='))?.slice('--deposit='.length)
  ?? process.env.MEKARI_DEPOSIT_ACCOUNT
  ?? null;

function printSyncResult(result) {
  const failed = result.results.filter((r) => r.status === 'failed' || r.status === 'mismatch');
  const total = result.results.reduce((n, r) => n + (r.total ?? 0), 0);

  console.log(`\n  ${result.considered} pesanan diproses` +
    `  ·  dibuat ${result.created}  ·  sudah ada ${result.exists}  ·  gagal ${result.failed}` +
    (result.deferred ? `  ·  tertunda ${result.deferred} (dicoba lagi run berikutnya)` : '') +
    (result.mismatch ? `  ·  NILAI SELISIH ${result.mismatch}` : '') +
    (result.voided ? `  ·  dibatalkan dihapus ${result.voided}` : '') +
    (result.needsReview ? `  ·  perlu ditinjau ${result.needsReview}` : ''));
  console.log(`  nilai  Rp${total.toLocaleString('id-ID')}\n`);

  for (const r of failed) console.log(fail(`${r.customId}: ${r.error}`));
  return failed.length === 0 ? 0 : 1;
}

async function cmdMekariSetup(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }

  const preview = await ensureReady({ dryRun: true });
  console.log(`\n  pelanggan terbaca   : ${preview.customers.existing.join(', ') || '-'}`);
  console.log(`  pelanggan akan dibuat: ${preview.customers.missing.join(', ') || '-'}`);
  console.log(`  produk terbaca      : ${preview.products.existing}`);
  console.log(`  produk akan dibuat  : ${preview.products.missing.length}${
    preview.products.missing.length ? ` (${preview.products.missing.slice(0, 6).join(', ')}${preview.products.missing.length > 6 ? ', ...' : ''})` : ''}`);
  // "akan dibuat" is a guess, not a promise: Jurnal's contact list does not report what it
  // holds, so anything already there comes back as a 409 and is counted as existing.
  console.log(`  ${'(yang ternyata sudah ada akan dilewati, bukan digandakan)'}\n`);

  const deposit = depositArg(args);
  if (deposit) {
    const account = await findDepositAccount(deposit);
    console.log(account ? ok(`akun deposit "${deposit}" ditemukan`) : fail(`akun deposit "${deposit}" tidak ada di Jurnal`));
    if (!account) return 1;
  }

  const todo = preview.customers.missing.length + preview.products.missing.length;
  if (todo === 0) { console.log(`${ok('tidak ada yang perlu dibuat')}\n`); return 0; }
  if (!args.includes('--yes')) { console.log(`${warn('belum dibuat. Ulangi dengan --yes')}\n`); return 1; }

  const result = await ensureReady({ dryRun: false });
  console.log(`${ok(`pelanggan dibuat: ${result.customers.created.join(', ') || '-'}`)}`);
  console.log(`${ok(`produk dibuat: ${result.products.created.length}, sudah ada: ${result.products.alreadyThere?.length ?? 0}`)}\n`);
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

/**
 * A spent monthly package is not a fault to fix, it is a date to wait for.
 *
 * Exit 2 says so: the sweep unit treats it as a clean run (SuccessExitStatus=2), because
 * a unit left red for the rest of the month is a unit nobody looks at when something
 * actually breaks. One Telegram message per month, keyed by the month, not per run.
 */
async function reportQuotaExhausted() {
  console.log(`\n${fail('kuota API bulanan Mekari Jurnal habis - berhenti; pesanan menunggu, tidak hilang')}\n`);
  await sendTelegram(
    '<b>⛔ Kuota API bulanan Mekari Jurnal habis</b>\nSinkronisasi berhenti sampai kuota kembali (awal bulan) atau paket API Mekari di-upgrade. Pesanan tidak hilang: sapuan akan menyusul semuanya begitu kuota ada.',
    { key: `mekari-monthly-quota-${new Date().toISOString().slice(0, 7)}` },
  );
  return 2;
}

async function cmdMekariSync(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }

  const orders = await mekariOrders(args);
  const depositTo = depositArg(args);

  const preview = await runSync({ orders, depositTo, dryRun: true, limit: 1000 });
  printSyncResult(preview);

  if (preview.considered === 0) { console.log(`${ok('semua pesanan sudah ada di Jurnal')}\n`); return 0; }
  if (!args.includes('--yes')) { console.log(`${warn('belum dikirim. Ulangi dengan --yes untuk menulis ke Jurnal')}\n`); return 1; }

  // From here every step talks to Jurnal, and any of them can be the one that finds the
  // monthly package spent - the ledger rebuild reaches it before ensureReady does, and
  // ensureReady before the sync loop. Which one gets there first is an accident of state,
  // not something the operator needs to know, so all three report it the same way. Left
  // uncaught it printed as a bare FAIL and exited 1, which is how the sweep unit came to
  // sit in "failed" for the rest of the month - the exact state a real failure would have
  // to be noticed in.
  try {
    // An empty ledger next to a Jurnal full of invoices means the ledger was lost, not
    // that nothing was ever posted. Rebuild it from the books first - two requests -
    // rather than spend one request per already-posted order learning the same by 409.
    const ledgerNow = await loadSyncLedger();
    if (Object.keys(ledgerNow.orders ?? {}).length === 0) {
      const rebuilt = await rebuildLedgerFromJurnal({ dryRun: false });
      if (rebuilt.inJurnal > 0) console.log(info(`ledger kosong - dibangun ulang dari Jurnal: ${rebuilt.inJurnal} faktur`));
    }

    // Customers and products both have to exist before an invoice can name them; Jurnal
    // rejects the whole invoice otherwise.
    await ensureReady({ dryRun: false, readyAt: ledgerNow.ready_at ?? null });

    const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice('--limit='.length)) || 1000;
    const result = await runSync({ orders, depositTo, dryRun: false, limit });
    if (result.skipped) { console.log(`${warn('run lain sedang berjalan, dilewati')}\n`); return 0; }
    if (result.quotaExhausted) return reportQuotaExhausted();
    await notifySyncFailures({ source: 'CLI mekari:sync', results: result.results });
    return printSyncResult(result);
  } catch (error) {
    if (!(error instanceof QuotaExhaustedError)) throw error;
    return reportQuotaExhausted();
  }
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

async function cmdNotifyTest() {
  if (!isTelegramConfigured()) {
    console.log(fail('TELEGRAM_BOT dan TELEGRAM_CHAT_ID belum lengkap di env'));
    return 1;
  }
  const result = await sendTelegram(
    '<b>✅ Uji notifikasi Treelogy</b>\nKalau pesan ini sampai, kegagalan sinkronisasi ke Jurnal akan dilaporkan ke sini.',
    { key: `uji-${Date.now()}` },
  );
  console.log(result.sent ? ok('pesan uji terkirim') : fail(`gagal: ${result.reason}`));
  return result.sent ? 0 : 1;
}

/**
 * Pictures onto the dashboard, with Jurnal left out of it entirely.
 *
 * Kept separate from mekari:images because the pictures on the dashboard have nothing to
 * do with the books: when Jurnal's monthly package ran out, the combined job died on its
 * first request and every product showed "tanpa gambar" for a week for a reason that had
 * nothing to do with the pictures.
 */
async function cmdImages() {
  const t0 = Date.now();
  const { total, changed, unknown } = await refreshImageManifest();
  console.log(`\n  ${total} SKU bergambar di Shopify  ·  ${changed} diperbarui  ·  ${Math.round((Date.now() - t0) / 1000)} detik`);
  if (unknown.length > 0) {
    console.log(`  ${warn(`${unknown.length} SKU Shopify tidak ada di data master: ${unknown.slice(0, 6).join(', ')}${unknown.length > 6 ? '...' : ''}`)}`);
  }
  console.log(`  ${changed > 0 ? ok('manifest dashboard diperbarui') : info('sudah sesuai, tidak ada yang ditulis')}\n`);
  return 0;
}

async function cmdMekariImages(config, args = []) {
  const dryRun = !args.includes('--yes');
  const result = await syncProductImages({ dryRun });
  console.log(`\n  ${result.withImage} SKU bergambar di Shopify` +
    `  ·  ${dryRun ? 'akan diunggah' : 'diunggah'} ${dryRun ? result.wouldUpload : result.uploaded}` +
    `  ·  tidak berubah ${result.unchanged}  ·  belum ada di Jurnal ${result.noJurnalProduct}  ·  gagal ${result.failed}`);
  for (const r of result.results) {
    if (r.status === 'unchanged') continue;
    console.log(`    ${r.status.padEnd(18)} ${r.sku.padEnd(30)} ${r.source ?? ''} ${r.bytes ? Math.round(r.bytes / 1024) + ' KB' : ''} ${r.error ?? ''}`);
  }
  if (result.unknown.length) console.log(`\n  SKU Shopify di luar data master: ${result.unknown.join(', ')}`);
  console.log(dryRun ? `\n${info('dry-run: tidak ada yang diunggah. Jalankan dengan --yes')}\n` : '\n');
  return result.failed ? 1 : 0;
}

/**
 * The two settings that live in Jurnal rather than here, plus the policy table printed so
 * a person can check it against what the business actually decided.
 */
async function cmdMekariCoa(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }
  const dryRun = !args.includes('--yes');

  const result = await setUpChartOfAccounts({ dryRun });

  const now = result.currentShipping;
  const right = now?.number === result.shipping.number;
  console.log(`\n  ${result.company.name}`);
  console.log(`  akun pengiriman penjualan: ${now ? `${now.number} ${now.name}` : '(tidak terbaca)'}  ${right ? ok('sudah benar') : fail(`harus ${result.shipping.number} ${result.shipping.name}`)}`);
  if (!right) {
    // Not a warning to be scrolled past: while this is wrong, every order carrying
    // postage is held back rather than booked into the wrong account.
    console.log(`  ${warn('selama ini belum diubah, pesanan berongkir DITAHAN dan tidak dibukukan')}`);
    console.log(`  ${info('ubah di Jurnal: ikon roda gigi → Pengaturan → cari "pengiriman" → akun pengiriman penjualan')}`);
  }
  console.log('');
  console.log(`  ${'SUMBER'.padEnd(14)}${'TAG'.padEnd(14)}${'PIUTANG'.padEnd(10)}${'TERMIN'.padEnd(9)}PEMBAYARAN`);
  for (const row of await describePolicy()) {
    console.log(`  ${row.label.padEnd(14)}${row.tag.padEnd(14)}${row.receivable.padEnd(10)}${`Net ${row.termDays}`.padEnd(9)}${row.autoPaid ? ok('otomatis lunas') : warn('manual')}`);
  }

  if (dryRun) {
    if (result.tagsToCreate.length > 0) console.log(`\n  ${info(`tag yang akan dibuat: ${result.tagsToCreate.join(', ')}`)}`);
    console.log(`\n  ${info('dry-run: belum ada yang disetel. Ulangi dengan --yes')}\n`);
    return 0;
  }

  if (result.tagsCreated.length > 0) console.log(`  ${ok(`tag dibuat: ${result.tagsCreated.join(', ')}`)}`);
  console.log('');
  return 0;
}

/**
 * Re-book what was written under the old rules.
 *
 * Destructive by nature - Jurnal cannot move an invoice between receivables, so restating
 * means deleting and writing again, and the old invoice numbers do not come back. The
 * plan is always printed first and --yes is always required.
 */
async function cmdMekariRestate(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }
  const from = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) || '2026-09-01';
  const dryRun = !args.includes('--yes');
  const t0 = Date.now();

  const result = await restate({
    from,
    dryRun,
    onProgress: (p) => {
      if (p.stage === 'piutang' && p.changed % 50 === 0) console.log(`  piutang pelanggan dipindah ${p.changed}/${p.of}`);
      // Deletes used to report nothing at all, so a slow run - Jurnal answering 504s, as
      // it did - was indistinguishable from a hung one, and got killed on suspicion.
      if (p.stage === 'hapus' && p.processed % 25 === 0) console.log(`  diperiksa ${p.processed}/${p.of}  ·  dihapus ${p.deleted}  ·  sudah tidak ada ${p.alreadyGone}`);
      if (p.stage === 'buat') console.log(`  ditulis ${p.created}/${p.of}`);
    },
  });

  console.log(`\n  sejak ${from}  ·  ${result.ordersInWindow} pesanan di database  ·  ${result.doomed} faktur milik sistem ini\n`);
  console.log(`  ${result.rebuildable.length} bisa ditulis ulang  ·  ${result.autoPaid} di antaranya otomatis lunas`);
  if (result.unbuildable.length > 0) {
    console.log(`  ${warn(`${result.unbuildable.length} tidak bisa dibangun ulang - akan dihapus dan tidak ditulis kembali:`)}`);
    for (const row of result.unbuildable.slice(0, 8)) console.log(`    ${row.customId}: ${row.error}`);
  }

  if (dryRun) {
    console.log(`\n  ${result.receivables.size} pelanggan perlu dipindahkan ke piutang sumbernya`);
    console.log(`  perkiraan biaya API: ${result.apiCalls} panggilan (5 baca pelanggan + ${result.receivables.size} pindah + ${result.doomed} hapus + ${Math.ceil(result.rebuildable.length / 50)} batch tulis)`);
    console.log(`\n  ${info('dry-run: tidak ada yang dihapus. Ulangi dengan --yes')}\n`);
    return 0;
  }

  console.log(`\n  ${result.aligned.changed} pelanggan dipindah  ·  ${result.deleted} dihapus` +
    (result.alreadyGone > 0 ? `  ·  ${result.alreadyGone} sudah tidak ada` : '') +
    `  ·  ${result.created} ditulis ulang  ·  ${Math.round((Date.now() - t0) / 1000)} detik`);
  if (result.failures.length > 0) {
    console.log(`  ${fail(`${result.failures.length} gagal:`)}`);
    for (const f of result.failures.slice(0, 10)) console.log(`    ${f.customId} (${f.stage}): ${f.error}`);
    console.log('');
    return 1;
  }
  console.log(`  ${ok('selesai')}\n`);
  return 0;
}

/**
 * Faktur kembar: cari, tampilkan, lalu hapus salinannya.
 *
 * They should not exist - the single-invoice endpoint rejects a repeated custom_id - but
 * batch_create does not, and a create that timed out at our end after Jurnal had already
 * written it was retried as if it were a read. The oldest copy is kept, because it is the
 * one anything else may already be pointing at.
 */
async function cmdMekariDedupe(config, args = []) {
  if (!isMekariConfigured()) { console.log(fail('MEKARI_APP_CLIENT_ID / SECRET belum diisi')); return 1; }
  const since = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) || '2026-09-01';
  const dryRun = !args.includes('--yes');

  const result = await removeDuplicates({
    since,
    dryRun,
    onProgress: (p) => { if (p.removed % 20 === 0) console.log(`  dihapus ${p.removed}/${p.of}`); },
  });

  console.log(`\n  ${result.scanned} faktur ditelusuri sejak ${since}  ·  ${result.ours} custom_id milik sistem ini`);
  if (result.groups.length === 0) { console.log(`  ${ok('tidak ada faktur kembar')}\n`); return 0; }

  console.log(`  ${fail(`${result.groups.length} pesanan punya faktur ganda  ·  ${result.extra} salinan berlebih`)}\n`);
  for (const g of result.groups.slice(0, 10)) {
    console.log(`    ${g.customId.padEnd(34)} simpan #${g.keep.no ?? g.keep.id}  hapus ${g.drop.map((d) => `#${d.no ?? d.id}`).join(' ')}`);
  }
  if (result.groups.length > 10) console.log(`    ...dan ${result.groups.length - 10} lagi`);

  if (dryRun) { console.log(`\n  ${info('dry-run: belum ada yang dihapus. Ulangi dengan --yes')}\n`); return 0; }
  console.log(`\n  ${result.removed} salinan dihapus`);
  if (result.failures.length > 0) {
    console.log(`  ${fail(`${result.failures.length} gagal dihapus`)}`);
    for (const f of result.failures.slice(0, 5)) console.log(`    ${f.customId} #${f.id}: ${f.error.slice(0, 70)}`);
  }
  console.log('');
  return result.failures.length > 0 ? 1 : 0;
}

async function cmdMekariRebuild(config, args = []) {
  const result = await rebuildLedgerFromJurnal({ dryRun: !args.includes('--yes') });
  console.log(`\n  faktur TRL di Jurnal: ${result.inJurnal} (${result.pages} halaman)  ·  di ledger sekarang: ${result.before}  ·  akan ditambahkan: ${result.added}`);
  console.log(result.dryRun ? `\n${info('dry-run. Terapkan dengan --yes')}\n` : `\n${ok('ledger dibangun ulang')}\n`);
  return 0;
}

async function cmdHistoryPull(config, args = []) {
  const only = args.find((a) => /^--(shopify|tiktok|shopee)$/.test(a))?.slice(2);
  const t0 = Date.now();
  const { summary } = await pullHistory({
    channels: only ? [only] : undefined,
    onMonth: ({ channel, month, orders, complete, error }) => console.log(error
      ? fail(`${channel.padEnd(8)} berhenti: ${String(error).slice(0, 90)}`)
      : `  ${channel.padEnd(8)} ${month}  ${String(orders).padStart(5)} order${complete ? '' : '  (bulan berjalan)'}`),
  });
  console.log();
  for (const [ch, s] of Object.entries(summary)) {
    const line = `${ch.padEnd(8)} ditarik ${s.pulled} bulan (${s.orders} order), dilewati ${s.skipped} bulan yang sudah lengkap`;
    console.log(s.error ? warn(`${line} - BERHENTI: ${String(s.error).slice(0, 70)}`) : ok(line));
  }
  console.log(`  ${Math.round((Date.now() - t0) / 1000)} detik\n`);
  return 0;
}

const URGENCY_LABEL = { stockout: 'HABIS', critical: 'KRITIS', watch: 'AWASI', ok: 'aman', idle: 'diam' };

async function cmdForecast(config, args = []) {
  const t0 = Date.now();
  // Stock comes from the ledger where it exists, otherwise from the live catalogues.
  const [ledger, catalog] = await Promise.all([
    loadLedger().catch(() => null),
    readCatalog().catch(() => null),
  ]);
  if (catalog && Object.keys(catalog.errors ?? {}).length > 0) {
    for (const [ch, msg] of Object.entries(catalog.errors)) console.log(warn(`stok ${ch} tidak terbaca: ${String(msg).slice(0, 80)}`));
  }

  const leadTimeDays = Number(args.find((a) => a.startsWith('--lead='))?.slice(7)) || undefined;
  const result = await runForecast({ ledger, catalog, policy: leadTimeDays ? { leadTimeDays } : undefined });

  const h = result.history;
  console.log(`\n  riwayat ${h.from} s/d ${h.to}  ·  ${h.orders.toLocaleString('id-ID')} pesanan terpakai, ${h.excluded.toLocaleString('id-ID')} batal/retur dikeluarkan`);
  console.log(`  lead time ${result.policy.leadTimeDays} hari  ·  review ${result.policy.reviewDays} hari\n`);
  console.log(`  ${URGENCY_ORDER.map((u) => `${URGENCY_LABEL[u]} ${result.counts[u]}`).join('  ·  ')}\n`);

  const show = args.includes('--all') ? result.rows : result.rows.filter((r) => r.status === 'ok');
  console.log('  SKU                          stok  hari  30hr (p10-p90)        model        MASE  pesan');
  for (const r of show.slice(0, 40)) {
    if (r.status !== 'ok') { console.log(`  ${r.sku.padEnd(28)} ${String(r.onHand ?? '-').padStart(5)}   belum cukup data (${r.historyDays} hari)`); continue; }
    const f = r.forecasts[30] ?? {};
    const a = r.accuracy[30] ?? {};
    const tag = URGENCY_LABEL[r.urgency] ?? r.urgency;
    console.log(
      `  ${r.sku.padEnd(28)} ${String(r.onHand ?? '-').padStart(5)} ${String(r.stock?.daysOfCover ?? '-').padStart(5)}  ` +
      `${String(f.p50 ?? '-').padStart(5)} (${String(f.p10 ?? '-').padStart(4)}-${String(f.p90 ?? '-').padStart(5)})  ` +
      `${String(a.model ?? '-').padEnd(10)} ${String(a.mase ?? '-').padStart(6)}  ${String(r.stock?.reorderQty ?? '-').padStart(5)}  ${tag}`,
    );
  }
  if (h.unknownSkus?.length) console.log(`\n  SKU di luar data master: ${h.unknownSkus.map((u) => `${u.sku} (${u.qty})`).join(', ')}`);

  // Only when asked: the daily job wants the alert, someone checking a number does not.
  if (args.includes('--notify')) {
    const sent = await notifyStockRisk(result);
    console.log(sent.sent ? ok('peringatan stok dikirim ke Telegram') : info(`tidak dikirim: ${sent.reason}`));
  }
  console.log(`\n  ${Math.round((Date.now() - t0) / 1000)} detik\n`);
  return 0;
}

/**
 * Fill the database with the sales that happened before webhooks existed.
 *
 * Re-running is safe and cheap: writes are keyed on (channel, id) and the newest read of
 * an order wins, so a second pass over a week that is already stored changes nothing
 * except the timestamps. That is what makes it usable as a repair tool and not only as a
 * one-time migration.
 */
async function cmdDbBackfill(config, args = []) {
  if (!isSupabaseConfigured()) { console.log(fail('SUPABASE_URL / SUPABASE_SECRET_KEY belum diisi')); return 1; }

  const from = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) || DB_HISTORY_START;
  const dryRun = !args.includes('--yes');
  const t0 = Date.now();

  console.log(`\n  Mengisi database dari ${from}${dryRun ? info('  (dry-run)') : ''}\n`);

  const result = await backfill({
    from,
    dryRun,
    onProgress: (chunk) => {
      const problems = [
        ...Object.entries(chunk.errors).map(([source, message]) => fail(`${source}: ${message}`)),
        ...chunk.truncated.map((t) => warn(`terpotong: ${t}`)),
        ...chunk.rejected.map((r) => fail(`${r.channel}/${r.id}: ${r.error}`)),
      ];
      console.log(`  ${chunk.label}  ${String(chunk.found).padStart(5)} ditemukan  ${String(chunk.written).padStart(5)} ditulis  ${problems.join('  ')}`);
    },
  });

  console.log(`\n  ${result.seen} pesanan dibaca  ·  ${result.stored} ditulis` +
    (result.rejected.length > 0 ? `  ·  ${result.rejected.length} ditolak database` : '') +
    `  ·  ${Math.round((Date.now() - t0) / 1000)} detik`);
  if (result.claimed.length > 0) {
    console.log(`  ${ok(`${dryRun ? 'akan dicatat' : 'cakupan tercatat'}: ${result.claimed.join(', ')}`)}`);
  }
  // An unclaimed source is not a crash; it is the dashboard quietly continuing to read
  // that platform live, which the operator should know rather than discover.
  if (result.unclaimed.length > 0) console.log(`  ${warn(`belum tercakup, masih dibaca langsung: ${result.unclaimed.join(', ')}`)}`);
  if (dryRun) console.log(`\n  ${info('dry-run: tidak ada yang ditulis. Ulangi dengan --yes')}`);
  console.log('');
  return 0;
}

async function cmdDbStatus() {
  if (!isSupabaseConfigured()) { console.log(fail('SUPABASE_URL / SUPABASE_SECRET_KEY belum diisi')); return 1; }

  const [stats, coverage] = await Promise.all([dbStats(), readCoverage()]);
  console.log(`\n  ${stats?.orders ?? '?'} pesanan tersimpan\n`);
  const sources = activeSources();
  for (const source of sources) {
    const window = coverage[source];
    if (!window) { console.log(`  ${source.padEnd(10)} ${warn('belum ada cakupan - dibaca langsung dari platform')}`); continue; }
    console.log(`  ${source.padEnd(10)} ${ok(`${wibDate(window.from)} s/d ${wibDate(window.through)}`)}  diperbarui ${window.at?.slice(0, 19).replace('T', ' ')}`);
  }
  const missing = sources.filter((s) => !coverage[s]);
  console.log(`\n  ${missing.length === 0 ? ok('dashboard membaca dari database') : warn(`${missing.length} sumber masih dibaca langsung`)}\n`);
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
  'notify:test': cmdNotifyTest,
  images: cmdImages,
  'mekari:images': cmdMekariImages,
  'mekari:coa': cmdMekariCoa,
  'mekari:restate': cmdMekariRestate,
  'mekari:dedupe': cmdMekariDedupe,
  'mekari:rebuild': cmdMekariRebuild,
  'db:backfill': cmdDbBackfill,
  'db:status': cmdDbStatus,
  'history:pull': cmdHistoryPull,
  forecast: cmdForecast,
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
    // The message alone says what went wrong but never where, and on a box you reach over
    // ssh that difference is an afternoon. Off by default so normal output stays readable.
    if (process.env.TREELOGY_TRACE) console.error(error?.stack ?? error);
    return 1;
  }
}
