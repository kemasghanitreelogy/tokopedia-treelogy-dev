import { writeFileSync } from 'node:fs';
import {
  loadTokopediaConfig, syncReviews, loadReviews, selectReviews, reviewStats, toCsv, fetchShopSummary,
  shopReviewUrl, LOW_RATING_MAX,
} from './reviews.js';
import { notifyReviewSync } from './notify.js';
import { ok, fail, warn, info } from '../format.js';

const USAGE = `tokopedia - ulasan toko Tokopedia (dibaca dari storefront, bukan Open API)

Pakai:
  npm run tokopedia:doctor             Satu permintaan: rating toko, jumlah penilaian, sebaran bintang
  npm run tokopedia:reviews            Sinkronkan semua ulasan tertulis ke store (aman diulang)
      --quick                          Berhenti di halaman pertama yang tidak berisi ulasan baru
      --notify                         Kirim Telegram untuk ulasan baru <= ${LOW_RATING_MAX} bintang + ringkasan
      --json                           Cetak hasil sinkron sebagai JSON
  npm run tokopedia:reviews:list       Tampilkan ulasan tersimpan, terbaru dulu
      --rating=1,2,3  --sku=OMC-180-001  --product=<id>  --days=30  --text  --limit=20  --json
  npm run tokopedia:reviews:stats      Rangkuman: per bintang, per SKU, 30 hari terakhir, belum dibalas
  npm run tokopedia:reviews:export     Tulis ulasan tersimpan ke berkas
      --csv[=path]  --json[=path]      (bawaan: state/tokopedia-reviews.csv / .json), filter sama seperti list

Sumber: ${shopReviewUrl(loadTokopediaConfig().shopSlug)}
Ubah toko lewat TOKOPEDIA_SHOP_ID dan TOKOPEDIA_SHOP_SLUG di .env.
`;

const flag = (args, name) => args.includes(`--${name}`);
const value = (args, name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

function filterFrom(args) {
  const ratings = value(args, 'rating')?.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  const days = Number(value(args, 'days')) || 0;
  return {
    ratings,
    sku: value(args, 'sku') ?? undefined,
    productId: value(args, 'product') ?? undefined,
    sinceEpoch: days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined,
    withText: flag(args, 'text'),
    limit: Number(value(args, 'limit')) || undefined,
  };
}

const when = (r) => (r.createdAt ? r.createdAt.slice(0, 10) + (r.createdAtPrecision === 'approx' ? '~' : '') : '?');

function printReview(r) {
  const who = r.anonymous ? '(anonim)' : r.reviewerName;
  console.log(`  ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}  ${when(r)}  ${r.sku ?? '-'}  ${r.variantName || r.productName}`);
  if (r.text) console.log(`      "${r.text.replace(/\s+/g, ' ').slice(0, 200)}"  — ${who}`);
  if (r.badRatingReason) console.log(`      alasan: ${r.badRatingReason}`);
  if (r.images.length || r.videos.length) console.log(`      lampiran: ${r.images.length} foto, ${r.videos.length} video`);
  console.log(`      balasan: ${r.reply ? r.reply.text.replace(/\s+/g, ' ').slice(0, 120) : 'belum'}`);
}

async function cmdDoctor(config) {
  console.log(info(`toko     : ${config.shopSlug} (id ${config.shopId})`));
  const summary = await fetchShopSummary({ shopId: config.shopId, slug: config.shopSlug });
  console.log(ok(`rating   : ${summary.score} dari ${summary.totalRatings} penilaian (${summary.totalWritten} tertulis) — ${summary.satisfied}`));
  console.log(info(`sebaran  : ${[5, 4, 3, 2, 1].map((n) => `${n}★ ${summary.distribution[n] ?? 0}`).join('  ')}`));
  if (summary.aggregatedWithTikTok) console.log(info('angka di atas gabungan Tokopedia + TikTok Shop (isAggregatedWithTTS)'));
  for (const t of summary.topics) console.log(info(`topik    : ${t.title} ${t.rating.toFixed(2)} (${t.reviews} ulasan)`));
  return 0;
}

async function cmdReviews(config, args) {
  const quiet = flag(args, 'json');
  const log = quiet ? () => {} : (line) => console.log(info(line));
  const result = await syncReviews({ shopId: config.shopId, slug: config.shopSlug, quick: flag(args, 'quick'), log });

  if (quiet) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(ok(`${result.total} ulasan tersimpan (${result.listed} terdaftar di toko), ${result.requests} permintaan`));
    console.log(info(`baru ${result.added.length}, berubah ${result.updated.length}`));
    const low = result.added.filter((r) => r.rating <= LOW_RATING_MAX);
    if (low.length) {
      console.log(warn(`${low.length} ulasan baru <= ${LOW_RATING_MAX} bintang:`));
      low.forEach(printReview);
    }
  }

  if (flag(args, 'notify')) {
    const sent = await notifyReviewSync(result);
    if (!quiet) console.log(sent.length ? ok(`Telegram: ${sent.length} pesan`) : info('Telegram: tidak ada yang perlu dikirim'));
  }
  return 0;
}

async function cmdList(config, args) {
  const doc = await loadReviews(config.shopId);
  if (!doc.syncedAt) {
    console.log(fail('belum ada ulasan tersimpan - jalankan `npm run tokopedia:reviews` dulu'));
    return 1;
  }
  const list = selectReviews(doc, filterFrom(args));
  if (flag(args, 'json')) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  console.log(info(`${list.length} ulasan (sinkron terakhir ${doc.syncedAt}); tanggal dengan ~ adalah perkiraan`));
  list.forEach(printReview);
  return 0;
}

async function cmdStats(config, args) {
  const doc = await loadReviews(config.shopId);
  if (!doc.syncedAt) {
    console.log(fail('belum ada ulasan tersimpan - jalankan `npm run tokopedia:reviews` dulu'));
    return 1;
  }
  const stats = reviewStats(doc);
  if (flag(args, 'json')) {
    console.log(JSON.stringify(stats, null, 2));
    return 0;
  }
  console.log(info(`sinkron terakhir: ${stats.syncedAt}`));
  if (stats.summary) {
    console.log(ok(`rating toko ${stats.summary.score} dari ${stats.summary.totalRatings} penilaian, ${stats.summary.totalWritten} tertulis`));
  }
  console.log(info(`ulasan tertulis tersimpan: ${stats.written.count}, rata-rata ${stats.written.average}, <= ${LOW_RATING_MAX}★: ${stats.written.low}, belum dibalas: ${stats.unreplied}`));
  console.log(info(`30 hari terakhir: ${stats.last30Days.count} ulasan, rata-rata ${stats.last30Days.average ?? '-'}, <= ${LOW_RATING_MAX}★: ${stats.last30Days.low}`));
  console.log(info(`per bintang: ${[5, 4, 3, 2, 1].map((n) => `${n}★ ${stats.byRating[n]}`).join('  ')}`));
  console.log(info('per SKU:'));
  for (const [sku, b] of Object.entries(stats.bySku)) {
    console.log(`         ${sku.padEnd(28)} ${String(b.count).padStart(4)} ulasan  rata-rata ${b.average}  <= ${LOW_RATING_MAX}★ ${b.low}`);
  }
  return 0;
}

async function cmdExport(config, args) {
  const doc = await loadReviews(config.shopId);
  if (!doc.syncedAt) {
    console.log(fail('belum ada ulasan tersimpan - jalankan `npm run tokopedia:reviews` dulu'));
    return 1;
  }
  const list = selectReviews(doc, filterFrom(args));
  const wantJson = flag(args, 'json') || value(args, 'json') !== null;
  const path = value(args, 'csv') || value(args, 'json') || (wantJson ? 'state/tokopedia-reviews.json' : 'state/tokopedia-reviews.csv');
  writeFileSync(path, wantJson ? JSON.stringify(list, null, 2) : toCsv(list));
  console.log(ok(`${list.length} ulasan ditulis ke ${path}`));
  return 0;
}

const COMMANDS = {
  doctor: cmdDoctor,
  reviews: cmdReviews,
  'reviews:list': cmdList,
  'reviews:stats': cmdStats,
  'reviews:export': cmdExport,
};

export async function run(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Perintah tidak dikenal "${command}"\n`);
    console.log(USAGE);
    return 1;
  }
  try {
    return (await handler(loadTokopediaConfig(), args)) ?? 0;
  } catch (error) {
    console.error(fail(error.message));
    if (error.errors?.length) console.error(JSON.stringify(error.errors, null, 2));
    return 1;
  }
}
