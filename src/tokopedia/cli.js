import { loadTokopediaConfig, syncReviews, fetchShopSummary, shopReviewUrl, LOW_RATING_MAX } from './reviews.js';
import { notifyReviewSync } from './notify.js';
import { cmdList, cmdStats, cmdExport, cmdMedia, printReview } from '../reviews/cli.js';
import { ok, fail, warn, info } from '../format.js';

const USAGE = `tokopedia - ulasan toko Tokopedia (dibaca dari storefront, bukan Open API)

Pakai:
  npm run tokopedia:doctor             Satu permintaan: rating toko, jumlah penilaian, sebaran bintang
  npm run tokopedia:reviews            Sinkronkan semua ulasan tertulis ke store (aman diulang)
      --quick                          Berhenti di halaman pertama yang tidak berisi ulasan baru
      --notify                         Kirim Telegram untuk ulasan baru <= ${LOW_RATING_MAX} bintang + ringkasan
      --json                           Cetak hasil sinkron sebagai JSON

Membaca ulasan (Tokopedia + Shopee): npm run reviews:list / reviews:stats / reviews:export / reviews:media

Sumber: ${shopReviewUrl(loadTokopediaConfig().shopSlug)}
Ubah toko lewat TOKOPEDIA_SHOP_ID dan TOKOPEDIA_SHOP_SLUG di .env.
`;

const flag = (args, name) => args.includes(`--${name}`);

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
    if (result.media) {
      const m = result.media;
      console.log(info(`foto: ${m.fetched} diunduh, ${m.cached} sudah ada, ${m.failed} gagal${m.deferred ? `, ${m.deferred} ditunda ke saat dibuka` : ''}`));
    }
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

// The read commands moved to bin/reviews.mjs, where they cover both marketplaces; the
// old names keep working so nothing scripted against them breaks.
const COMMANDS = {
  doctor: cmdDoctor,
  reviews: cmdReviews,
  'reviews:list': (_config, args) => cmdList(args),
  'reviews:stats': (_config, args) => cmdStats(args),
  'reviews:export': (_config, args) => cmdExport(args),
  'reviews:media': (_config, args) => cmdMedia(args),
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
