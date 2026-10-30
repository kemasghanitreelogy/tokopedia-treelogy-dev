import crypto from 'node:crypto';
import { shopifyGraphql } from '../shopify/client.js';
import { loadShopifyConfig } from '../shopify/config.js';
import { readDoc, writeDoc } from '../store/index.js';
import { publicBaseUrl } from '../config.js';
import { mediaSignature } from '../dashboard-auth.js';
import { loadAllReviews } from './combined.js';
import { loadSiteReviews } from './site.js';
import { buildHub, SOURCES } from './hub.js';

/**
 * Puts the review page's data on the storefront.
 *
 * Three places on Shopify, all written through the Admin API with a content token
 * (SHOPIFY_CONTENT_TOKEN: metaobjects + files), not the orders token this service
 * otherwise uses:
 *
 * - Shopify Files: every photo a shown review carries. Marketplace image URLs are not
 *   ours to hotlink - Tokopedia's are signed and expire in about three days - so each
 *   photo is copied once, from this service's own media cache for Tokopedia and from
 *   Shopee's CDN for Shopee, and its Shopify CDN address is remembered in the ledger.
 * - Metaobjects of type `treelogy_review_page`, handle p-001, p-002...: one per page of
 *   cards. Liquid paginates them (`metaobjects.treelogy_review_page.values`), which
 *   gives the page real, crawlable ?page=N addresses. Handles never move: page 1 is
 *   always p-001, and when the content shifts the entry is rewritten in place.
 * - Shop metafield reviews_hub.summary: the numbers.
 *
 * Writes are skipped when nothing changed (content hash in the ledger), so a run every
 * ten minutes with nothing new costs one read of the ledger and nothing on Shopify.
 */

export const HUB_LEDGER_DOC = 'reviews/hub.json';
export const PAGE_TYPE = 'treelogy_review_page';
const UPLOADS_PER_RUN = 120;
const FILE_BATCH = 20;

const hash = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
const pageHandle = (n) => `p-${String(n).padStart(3, '0')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function contentConfig() {
  const base = loadShopifyConfig();
  const token = process.env.SHOPIFY_CONTENT_TOKEN ?? '';
  if (!token) throw new Error('SHOPIFY_CONTENT_TOKEN belum diisi (token Admin dengan write_metaobjects + write_files)');
  return { ...base, token };
}

/** Where Shopify should fetch a photo from. */
export function photoSource(review, image) {
  if (review.channel !== 'tokopedia') return image.full || image.thumbnail || '';
  const sig = mediaSignature(image.id, 'full');
  return `${publicBaseUrl()}/api/tokopedia/media?id=${encodeURIComponent(image.id)}&s=full${sig ? `&sig=${sig}` : ''}`;
}

const FILE_CREATE = `mutation ReviewPhotos($files: [FileCreateInput!]!) {
  fileCreate(files: $files) { files { id fileStatus } userErrors { field message code } }
}`;
const FILE_STATUS = `query ReviewPhotoStatus($ids: [ID!]!) {
  nodes(ids: $ids) { ... on MediaImage { id fileStatus image { url width height } fileErrors { code message } } }
}`;
const UPSERT = `mutation ReviewPage($handle: MetaobjectHandleInput!, $mo: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $mo) { metaobject { id handle } userErrors { field message code } }
}`;
const DELETE = `mutation ReviewPageDelete($id: ID!) { metaobjectDelete(id: $id) { deletedId userErrors { field message } } }`;
const SHOP_ID = `query ReviewShop { shop { id } }`;
const SET_SUMMARY = `mutation ReviewSummary($m: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } }
}`;

const userErrors = (where, errors) => {
  if (errors?.length) throw new Error(`${where}: ${errors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`).join('; ')}`);
};

async function uploadPhotos(wanted, ledger, { gql, log, limit = UPLOADS_PER_RUN }) {
  const media = ledger.media;
  const fresh = wanted.filter((w) => !media[w.key]).slice(0, limit);
  for (let i = 0; i < fresh.length; i += FILE_BATCH) {
    const batch = fresh.slice(i, i + FILE_BATCH).map((w) => ({ ...w, src: photoSource(w.review, w.image) })).filter((w) => w.src);
    if (!batch.length) continue;
    const files = batch.map((w) => ({
      originalSource: w.src,
      contentType: 'IMAGE',
      alt: `Foto ulasan pembeli Treelogy dari ${SOURCES[w.review.channel]?.label ?? 'treelogy.com'}`,
    }));
    const data = await gql(FILE_CREATE, { files });
    if (!data.fileCreate.userErrors?.length) {
      data.fileCreate.files.forEach((file, j) => {
        media[batch[j].key] = { id: file.id, pending: true };
      });
      continue;
    }
    // One bad source rejects the whole batch; send them one by one so a single dead
    // marketplace URL is recorded as such and never blocks the photos around it.
    for (let j = 0; j < batch.length; j++) {
      const one = await gql(FILE_CREATE, { files: [files[j]] });
      const error = one.fileCreate.userErrors?.[0];
      if (error) {
        media[batch[j].key] = { failed: true, error: error.message };
        log(`foto ${batch[j].key} ditolak: ${error.message}`);
      } else media[batch[j].key] = { id: one.fileCreate.files[0].id, pending: true };
    }
  }
  // Shopify processes uploads asynchronously; collect whatever is ready now, the rest next run.
  const pending = Object.entries(media).filter(([, m]) => m.pending);
  for (let round = 0; round < 6 && pending.some(([, m]) => m.pending); round++) {
    if (round) await sleep(2500);
    const open = pending.filter(([, m]) => m.pending);
    for (let i = 0; i < open.length; i += 100) {
      const slice = open.slice(i, i + 100);
      const data = await gql(FILE_STATUS, { ids: slice.map(([, m]) => m.id) });
      data.nodes.forEach((node, j) => {
        const [key, m] = slice[j];
        if (!node) return;
        if (node.fileStatus === 'READY' && node.image?.url) media[key] = { id: m.id, u: node.image.url, w: node.image.width, h: node.image.height };
        else if (node.fileStatus === 'FAILED') {
          media[key] = { id: m.id, failed: true, error: node.fileErrors?.[0]?.code ?? 'FAILED' };
          log(`foto ${key} gagal: ${media[key].error}`);
        }
      });
    }
  }
  return fresh.length;
}

async function publishPages(pages, ledger, { gql, log }) {
  let written = 0;
  for (let i = 0; i < pages.length; i++) {
    const handle = pageHandle(i + 1);
    const digest = hash(pages[i]);
    if (ledger.pages[handle]?.hash === digest) continue;
    const data = await gql(UPSERT, {
      handle: { type: PAGE_TYPE, handle },
      mo: { fields: [{ key: 'page_no', value: String(i + 1) }, { key: 'reviews', value: JSON.stringify(pages[i]) }] },
    });
    userErrors(`metaobjectUpsert ${handle}`, data.metaobjectUpsert.userErrors);
    ledger.pages[handle] = { id: data.metaobjectUpsert.metaobject.id, hash: digest };
    written += 1;
  }
  // Pages past the end (fewer reviews than before) are removed, so ?page=N never shows a stale tail.
  for (const [handle, entry] of Object.entries(ledger.pages)) {
    if (Number(handle.slice(2)) <= pages.length) continue;
    const data = await gql(DELETE, { id: entry.id });
    userErrors(`metaobjectDelete ${handle}`, data.metaobjectDelete.userErrors);
    delete ledger.pages[handle];
    log(`halaman ${handle} dihapus`);
  }
  return written;
}

async function publishSummary(summary, ledger, { gql }) {
  // updated_at changes every run; the hash ignores it so an unchanged summary is not rewritten.
  const { updated_at: _ignored, ...stable } = summary;
  const digest = hash(stable);
  if (ledger.summaryHash === digest) return false;
  ledger.shopId ??= (await gql(SHOP_ID)).shop.id;
  const data = await gql(SET_SUMMARY, {
    m: [{ ownerId: ledger.shopId, namespace: 'reviews_hub', key: 'summary', type: 'json', value: JSON.stringify(summary) }],
  });
  userErrors('metafieldsSet', data.metafieldsSet.userErrors);
  ledger.summaryHash = digest;
  return true;
}

/**
 * One full pass: read every source, upload new photos, rebuild pages and summary, write
 * what changed. `dryRun` builds and reports without touching Shopify or the ledger.
 */
export async function publishHub({ dryRun = false, log = () => {}, now = new Date().toISOString() } = {}) {
  const [doc, site, saved] = await Promise.all([loadAllReviews(), loadSiteReviews({ log }), readDoc(HUB_LEDGER_DOC)]);
  const ledger = { media: {}, pages: {}, summaryHash: null, shopId: null, ...(saved ?? {}) };

  let built = buildHub({ doc, site, media: ledger.media, now });
  if (dryRun) return { dryRun: true, summary: built.summary, pages: built.pages.length, wantedImages: built.wantedImages.length };

  const config = contentConfig();
  const gql = (query, variables) => shopifyGraphql(query, variables, config);

  const uploaded = await uploadPhotos(built.wantedImages, ledger, { gql, log });
  if (uploaded) built = buildHub({ doc, site, media: ledger.media, now });
  // The ledger is saved after every stage, so a failure later never re-uploads photos.
  await writeDoc(HUB_LEDGER_DOC, ledger);

  const pagesWritten = await publishPages(built.pages, ledger, { gql, log });
  await writeDoc(HUB_LEDGER_DOC, ledger);
  const summaryWritten = await publishSummary(built.summary, ledger, { gql });
  await writeDoc(HUB_LEDGER_DOC, { ...ledger, publishedAt: now });

  return {
    summary: built.summary,
    pages: built.pages.length,
    pagesWritten,
    summaryWritten,
    photosRequested: uploaded,
    photosWaiting: built.wantedImages.length,
  };
}
