import { writeFileSync } from 'node:fs';
import { loadAllReviews, REVIEW_CHANNELS } from './combined.js';
import { selectReviews, reviewStats, toCsv, LOW_RATING_MAX } from '../tokopedia/reviews.js';
import { prefetchMedia, mediaDir } from '../tokopedia/media.js';
import { ok, fail, warn, info } from '../format.js';

/**
 * Reading reviews across both marketplaces. Syncing stays with each channel's own CLI
 * (`tokopedia:reviews`, `shopee:reviews`); everything here only reads what they wrote.
 */

const USAGE = `reviews - ulasan Tokopedia + Shopee yang sudah disinkronkan

Pakai:
  npm run reviews:list       Ulasan tersimpan, terbaru dulu
      --channel=shopee|tokopedia  --rating=1,2,3  --sku=OMC-180-001  --product=<id>  --days=30  --text  --limit=20  --json
  npm run reviews:stats      Rangkuman: per kanal, per bintang, per SKU, 30 hari terakhir, belum dibalas
  npm run reviews:export     Tulis ke berkas: --csv[=path] | --json[=path] (bawaan state/reviews.csv / .json), filter sama seperti list
  npm run reviews:media      Unduh foto semua ulasan ke cache lokal (--limit=600 berkas per jalan)

Sinkron: npm run tokopedia:reviews  ·  npm run shopee:reviews
`;

const flag = (args, name) => args.includes(`--${name}`);
const value = (args, name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

export function filterFrom(args) {
  const ratings = value(args, 'rating')?.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  const days = Number(value(args, 'days')) || 0;
  const channel = value(args, 'channel');
  return {
    ratings,
    channel: channel && REVIEW_CHANNELS[channel] ? channel : undefined,
    sku: value(args, 'sku') ?? undefined,
    productId: value(args, 'product') ?? undefined,
    sinceEpoch: days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined,
    withText: flag(args, 'text'),
    limit: Number(value(args, 'limit')) || undefined,
  };
}

const when = (r) => (r.createdAt ? r.createdAt.slice(0, 10) + (r.createdAtPrecision === 'approx' ? '~' : '') : '?');

export function printReview(r) {
  const who = r.anonymous ? '(anonim)' : r.reviewerName;
  const channel = REVIEW_CHANNELS[r.channel]?.short ?? 'TP';
  console.log(`  ${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}  ${when(r)}  ${channel}  ${r.sku ?? '-'}  ${r.variantName || r.productName}`);
  if (r.text) console.log(`      "${r.text.replace(/\s+/g, ' ').slice(0, 200)}"  — ${who}`);
  if (r.badRatingReason) console.log(`      alasan: ${r.badRatingReason}`);
  if (r.images.length || r.videos.length) console.log(`      lampiran: ${r.images.length} foto, ${r.videos.length} video`);
  console.log(`      balasan: ${r.reply ? r.reply.text.replace(/\s+/g, ' ').slice(0, 120) : 'belum'}`);
}

async function loaded() {
  const doc = await loadAllReviews();
  if (!doc.syncedAt) {
    console.log(fail('belum ada ulasan tersimpan - jalankan `npm run tokopedia:reviews` atau `npm run shopee:reviews` dulu'));
    return null;
  }
  return doc;
}

export async function cmdList(args) {
  const doc = await loaded();
  if (!doc) return 1;
  const list = selectReviews(doc, filterFrom(args));
  if (flag(args, 'json')) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  console.log(info(`${list.length} ulasan (sinkron terakhir ${doc.syncedAt}); tanggal dengan ~ adalah perkiraan`));
  list.forEach(printReview);
  return 0;
}

export async function cmdStats(args) {
  const doc = await loaded();
  if (!doc) return 1;
  const stats = reviewStats(doc);
  if (flag(args, 'json')) {
    console.log(JSON.stringify({ ...stats, channels: doc.channels }, null, 2));
    return 0;
  }
  for (const [id, meta] of Object.entries(REVIEW_CHANNELS)) {
    const c = doc.channels[id];
    const b = stats.byChannel[id];
    if (!c?.syncedAt) {
      console.log(warn(`${meta.label}: belum disinkronkan`));
      continue;
    }
    console.log(ok(`${meta.label}: rating ${c.summary?.score ?? '-'} dari ${c.summary?.totalRatings ?? 0} penilaian, ${b?.count ?? 0} tersimpan, rata-rata ${b?.average ?? '-'}, <= ${LOW_RATING_MAX}★ ${b?.low ?? 0} · sinkron ${c.syncedAt}`));
  }
  console.log(info(`gabungan: ${stats.written.count} ulasan, rata-rata ${stats.written.average}, <= ${LOW_RATING_MAX}★: ${stats.written.low}, belum dibalas: ${stats.unreplied}`));
  console.log(info(`30 hari terakhir: ${stats.last30Days.count} ulasan, rata-rata ${stats.last30Days.average ?? '-'}, <= ${LOW_RATING_MAX}★: ${stats.last30Days.low}`));
  console.log(info(`per bintang: ${[5, 4, 3, 2, 1].map((n) => `${n}★ ${stats.byRating[n]}`).join('  ')}`));
  console.log(info('per SKU:'));
  for (const [sku, b] of Object.entries(stats.bySku)) {
    console.log(`         ${sku.slice(0, 40).padEnd(42)} ${String(b.count).padStart(4)} ulasan  rata-rata ${b.average}  <= ${LOW_RATING_MAX}★ ${b.low}`);
  }
  return 0;
}

export async function cmdExport(args) {
  const doc = await loaded();
  if (!doc) return 1;
  const list = selectReviews(doc, filterFrom(args));
  const wantJson = flag(args, 'json') || value(args, 'json') !== null;
  const path = value(args, 'csv') || value(args, 'json') || (wantJson ? 'state/reviews.json' : 'state/reviews.csv');
  writeFileSync(path, wantJson ? JSON.stringify(list, null, 2) : toCsv(list));
  console.log(ok(`${list.length} ulasan ditulis ke ${path}`));
  return 0;
}

export async function cmdMedia(args) {
  const doc = await loaded();
  if (!doc) return 1;
  const withPhotos = Object.values(doc.reviews).filter((r) => r.images.length);
  const files = withPhotos.reduce((n, r) => n + r.images.length * 2, 0);
  console.log(info(`${withPhotos.length} ulasan berfoto, ${files} berkas (thumb + full) → ${mediaDir()}`));
  const result = await prefetchMedia(withPhotos, { limit: Number(value(args, 'limit')) || 600, log: (line) => console.log(warn(line.trim())) });
  console.log(ok(`${result.fetched} diunduh, ${result.cached} sudah ada, ${result.failed} gagal${result.deferred ? `, ${result.deferred} ditunda (jalankan lagi)` : ''}`));
  return result.failed && !result.fetched && !result.cached ? 1 : 0;
}

const COMMANDS = { list: cmdList, stats: cmdStats, export: cmdExport, media: cmdMedia };

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
    return (await handler(args)) ?? 0;
  } catch (error) {
    console.error(fail(error.message));
    return 1;
  }
}
