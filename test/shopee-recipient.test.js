import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pngWidth, linesFromTsv, joinWrapped, readRecipientImages, fetchRecipientImages,
  captureShopeeRecipients, loadShopeeRecipients, applyShopeeRecipients, RECIPIENT_DOC,
} from '../src/shopee/recipient.js';
import { deleteDoc } from '../src/store/index.js';

/** A PNG header for a given width; nothing here decodes pixels. */
const png = (width) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(40, 20);
  return b;
};
const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

// The real TSV Tesseract produced for a Makassar address Shopee wrapped at 227px: every
// line but the last ran to the edge, so every break is inside a word.
const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (block, par, line, n, left, width, text) => `5\t1\t${block}\t${par}\t${line}\t${n}\t${left}\t5\t${width}\t20\t96\t${text}`;
const ADDRESS_TSV = [TSV_HEADER,
  word(1, 1, 1, 1, 1, 55, 'Jalan'), word(1, 1, 1, 2, 64, 47, 'Andi'), word(1, 1, 1, 3, 119, 62, 'Tonro'), word(1, 1, 1, 4, 188, 16, 'V'), word(1, 1, 1, 5, 212, 14, 'B'),
  word(1, 1, 2, 1, 2, 28, 'lok'), word(1, 1, 2, 2, 37, 29, 'A3'), word(1, 1, 2, 3, 75, 80, 'No.18a,'), word(1, 1, 2, 4, 166, 48, 'Para'),
  word(1, 2, 1, 1, 2, 23, 'ng'), word(1, 2, 1, 2, 34, 105, 'Tambung,'), word(1, 2, 1, 3, 148, 65, 'Tamal'),
  word(1, 3, 1, 1, 1, 31, 'ate'), word(1, 3, 1, 2, 41, 63, '(Perm'), word(1, 3, 1, 3, 114, 76, 'pondok'), word(1, 3, 1, 4, 199, 16, 'in'),
  word(1, 4, 1, 1, 1, 52, 'dah),'), word(1, 4, 1, 2, 63, 64, 'KOTA'), word(1, 4, 1, 3, 135, 81, 'MAKAS'),
  word(1, 5, 1, 1, 1, 53, 'SAR,'), word(1, 5, 1, 2, 63, 131, 'TAMALATE,'), word(1, 5, 1, 3, 204, 14, 'S'),
  word(1, 6, 1, 1, 2, 104, 'ULAWESI'), word(1, 6, 1, 2, 116, 106, 'SELATAN'),
  word(1, 6, 2, 1, 2, 3, ','), word(1, 6, 2, 2, 15, 27, 'ID,'), word(1, 6, 2, 3, 52, 64, '90223'),
].join('\n');

test('a pixel-wrapped address is rejoined into the string it was rendered from', () => {
  const lines = linesFromTsv(ADDRESS_TSV);
  assert.equal(lines.length, 8);
  assert.equal(lines[0].text, 'Jalan Andi Tonro V B');
  assert.equal(lines[0].right, 226);
  assert.equal(joinWrapped(lines, 227),
    'Jalan Andi Tonro V Blok A3 No.18a, Parang Tambung, Tamalate (Perm pondok indah), KOTA MAKASSAR, TAMALATE, SULAWESI SELATAN, ID, 90223');
});

test('a short line broke at a space and gets one back', () => {
  const lines = [{ text: 'Jl. Raya Kuta No. 5,', right: 150 }, { text: 'Badung, Bali', right: 100 }];
  assert.equal(joinWrapped(lines, 227), 'Jl. Raya Kuta No. 5, Badung, Bali');
  assert.equal(pngWidth(png(227)), 227);
  assert.equal(pngWidth(Buffer.from('not a png')), 0);
});

test('the three images become a name, a phone and an address', async () => {
  const calls = [];
  const ocr = async (image, opts) => {
    calls.push(opts);
    if (opts.tsv) return ADDRESS_TSV;
    return image.length === 33 && opts.psm === 7 && calls.length === 1 ? ' Stefani Wijaya \n' : ' 0812-3456 7890\n';
  };
  const text = await readRecipientImages({ name: png(227), phone: png(227), address: png(227) }, { ocr });
  assert.equal(text.name, 'Stefani Wijaya');
  assert.equal(text.phone, '0812-3456 7890');
  assert.match(text.address, /^Jalan Andi Tonro V Blok A3/);
  assert.deepEqual(calls.map((c) => c.psm), [7, 7, 6], 'lines for name and phone, a block with boxes for the address');
});

test('the shipping-document feed is asked for exactly the three fields, and decoded', async () => {
  let sent = null;
  const call = async (config, path, auth, params, body) => {
    sent = { path, body };
    return { response: { recipient_address_info: [
      { key: 'name', image: dataUri(png(227)) }, { key: 'phone', image: dataUri(png(227)) }, { key: 'full_address', image: dataUri(png(227)) },
    ] } };
  };
  const images = await fetchRecipientImages({}, {}, '260921JXKTVPFW', { call });
  assert.equal(sent.path, '/api/v2/logistics/get_shipping_document_data_info');
  assert.deepEqual(sent.body, { order_sn: '260921JXKTVPFW', recipient_address_info: [{ key: 'name' }, { key: 'phone' }, { key: 'full_address' }] });
  assert.equal(pngWidth(images.name), 227);
  assert.equal(pngWidth(images.address), 227);
});

test('capture names what is printable, skips what is known, and never throws for a refusal', async () => {
  await deleteDoc(RECIPIENT_DOC).catch(() => {});
  const orders = [
    { channel: 'shopee', id: 'A', status: 'PROCESSED', buyer: 'stefani_w' },
    { channel: 'shopee', id: 'B', status: 'PROCESSED', buyer: 'refused' },
    { channel: 'shopee', id: 'C', status: 'SHIPPED', buyer: 'gone' },
    { channel: 'shopify', id: '#1', status: 'PAID', buyer: 'Honey Halim' },
  ];
  const call = async (config, path, auth, params, body) => {
    if (body.order_sn === 'B') { const e = new Error('cannot be printed now'); e.code = 'error_status'; throw e; }
    return { response: { recipient_address_info: [{ key: 'name', image: dataUri(png(227)) }, { key: 'phone', image: dataUri(png(227)) }, { key: 'full_address', image: dataUri(png(227)) }] } };
  };
  const ocr = async (image, opts) => (opts.tsv ? ADDRESS_TSV : opts.psm === 7 ? 'Stefani Wijaya' : '');
  const tally = await captureShopeeRecipients(orders, { config: {}, auth: {}, call, ocr, now: 1_790_000_000 });
  assert.deepEqual(tally, { captured: 1, skipped: 2, failed: 1 });

  const kept = await loadShopeeRecipients();
  assert.equal(kept.A.name, 'Stefani Wijaya');
  assert.match(kept.A.address, /MAKASSAR/);
  assert.equal(kept.B, undefined);

  // Known already: no call is made for A the second time round.
  let calls = 0;
  const again = await captureShopeeRecipients(orders, { config: {}, auth: {}, call: async (...a) => { calls += 1; return call(...a); }, ocr, now: 1_790_000_100 });
  assert.equal(again.captured, 0);
  assert.equal(calls, 1, 'only the refused one is tried again');

  // Applied: the name replaces the username and the username is kept beside it.
  const named = applyShopeeRecipients(structuredClone(orders), kept);
  assert.equal(named[0].buyer, 'Stefani Wijaya');
  assert.equal(named[0].buyerUsername, 'stefani_w');
  assert.match(named[0].shipTo, /Parang Tambung/);
  assert.equal(named[1].buyer, 'refused', 'nothing captured, nothing changed');
  assert.equal(named[3].buyer, 'Honey Halim', 'other channels are untouched');
  await deleteDoc(RECIPIENT_DOC).catch(() => {});
});
