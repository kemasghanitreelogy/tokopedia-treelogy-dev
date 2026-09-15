import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffType, fetchMedia, readCached, ensureMedia, prefetchMedia, attachmentIndex, safeId, safeSize, mediaUrl } from '../src/tokopedia/media.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

let dir;
test.before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tokopedia-media-'));
  process.env.TOKOPEDIA_MEDIA_DIR = dir;
});
test.after(async () => {
  delete process.env.TOKOPEDIA_MEDIA_DIR;
  await rm(dir, { recursive: true, force: true });
});

const serving = (table, log = []) => async (url) => {
  log.push(url);
  const body = table[url];
  if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
};

test('image types are read from the bytes, not from what the CDN claims', () => {
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(PNG), 'image/png');
  assert.equal(sniffType(WEBP), 'image/webp');
  assert.equal(sniffType(Buffer.from('<html>')), null);
});

test('ids and sizes that could reach the filesystem are whitelisted', () => {
  assert.equal(safeId('359838891'), '359838891');
  assert.equal(safeId('../etc/passwd'), null);
  assert.equal(safeId(''), null);
  assert.equal(safeSize('thumb'), 'thumb');
  assert.equal(safeSize('huge'), null);
  assert.equal(mediaUrl('1', 'full'), '/api/tokopedia/media?id=1&s=full');
});

test('a photo is fetched once, kept under its id, and served from disk afterwards', async () => {
  const log = [];
  const fetchImpl = serving({ 'https://cdn/a-thumb': JPEG }, log);
  assert.equal(await readCached('1', 'thumb'), null);
  const first = await ensureMedia({ id: '1', size: 'thumb', url: 'https://cdn/a-thumb', fetchImpl });
  assert.equal(first.type, 'image/jpeg');
  const second = await ensureMedia({ id: '1', size: 'thumb', url: 'https://cdn/expired-does-not-matter', fetchImpl });
  assert.equal(second.type, 'image/jpeg');
  assert.equal(log.length, 1, 'the second read never touched the network');
  assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith('1-')), ['1-thumb']);
});

test('a non-image or a failed download leaves nothing on disk', async () => {
  const fetchImpl = serving({ 'https://cdn/html': Buffer.from('<html>nope</html>') });
  await assert.rejects(fetchMedia({ id: '2', size: 'full', url: 'https://cdn/html', fetchImpl }), /bukan gambar/);
  await assert.rejects(fetchMedia({ id: '3', size: 'full', url: 'https://cdn/missing', fetchImpl }), /HTTP 404/);
  await assert.rejects(fetchMedia({ id: '4', size: 'full', url: '', fetchImpl }), /tidak ada URL/);
  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.startsWith('2-') || f.startsWith('3-') || f.endsWith('.tmp')), files.join(','));
});

test('prefetch walks both sizes, counts outcomes, and defers what is over the limit', async () => {
  const log = [];
  const fetchImpl = serving({ 'https://cdn/t5': JPEG, 'https://cdn/f5': PNG, 'https://cdn/t6': WEBP }, log);
  const reviews = [
    { id: 'r1', images: [{ id: '5', thumbnail: 'https://cdn/t5', full: 'https://cdn/f5' }] },
    { id: 'r2', images: [{ id: '6', thumbnail: 'https://cdn/t6', full: 'https://cdn/f6-missing' }, { id: 'bad id', thumbnail: 'x', full: 'y' }] },
    { id: 'r3', images: [{ id: '7', thumbnail: 'https://cdn/t7', full: 'https://cdn/f7' }] },
  ];
  const result = await prefetchMedia(reviews, { fetchImpl, limit: 4, concurrency: 2 });
  assert.deepEqual(result, { fetched: 3, cached: 0, failed: 1, deferred: 2 });
  const again = await prefetchMedia(reviews.slice(0, 1), { fetchImpl });
  assert.deepEqual(again, { fetched: 0, cached: 2, failed: 0, deferred: 0 });
  // A second bounded run spends its limit on what is still missing, not on what is cached.
  const rest = await prefetchMedia(reviews, { fetchImpl, limit: 2 });
  assert.deepEqual(rest, { fetched: 0, cached: 3, failed: 2, deferred: 1 }, 'the three cached files did not count against the limit of two');
});

test('the attachment index maps ids to the freshest urls and skips unsafe ids', () => {
  const doc = { reviews: { a: { id: 'a', images: [{ id: '9', thumbnail: 't', full: 'f' }, { id: 'nope', thumbnail: 't', full: 'f' }] } } };
  const index = attachmentIndex(doc);
  assert.deepEqual(index.get('9'), { thumb: 't', full: 'f', reviewId: 'a' });
  assert.equal(index.has('nope'), false);
});
