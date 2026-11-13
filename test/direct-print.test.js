import test from 'node:test';
import assert from 'node:assert/strict';
import { packMono, tsplJob, escposJob, directPrinterFor, directPrintScript } from '../src/direct-print.js';
import { renderLabels } from '../src/dashboard-page.js';

// 16x2 image: top row all black, bottom row white except the last pixel.
const rgba = new Uint8Array(16 * 2 * 4);
for (let x = 0; x < 16; x += 1) { rgba.set([0, 0, 0, 255], x * 4); rgba.set([255, 255, 255, 255], (16 + x) * 4); }
rgba.set([0, 0, 0, 255], (16 + 15) * 4);

test('pixels pack to one bit each, MSB first, with either polarity', () => {
  const ink1 = packMono(rgba, 16, 2, { black: 1 });
  assert.deepEqual([...ink1.bytes], [0xff, 0xff, 0x00, 0x01]);
  const ink0 = packMono(rgba, 16, 2, { black: 0 });
  assert.deepEqual([...ink0.bytes], [0x00, 0x00, 0xff, 0xfe]);
  assert.equal(ink1.widthBytes, 2);
});

test('a transparent pixel is paper', () => {
  const px = new Uint8Array([0, 0, 0, 0]);
  assert.deepEqual([...packMono(px, 1, 1).bytes], [0x00]);
});

test('the TSPL job names the label size and carries the raw rows, then prints once', () => {
  const mono = packMono(rgba, 16, 2, { black: 0 });
  const text = Buffer.from(tsplJob(mono, { widthMm: 100, heightMm: 150, gapMm: 2 })).toString('latin1');
  assert.match(text, /^SIZE 100 mm,150 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 0\r\nCLS\r\nBITMAP 0,0,2,2,0,/);
  assert.ok(text.endsWith('\r\nPRINT 1,1\r\n'));
  assert.equal(text.indexOf('\x00\x00\xff\xfe'), text.indexOf('BITMAP 0,0,2,2,0,') + 'BITMAP 0,0,2,2,0,'.length);
});

test('the ESC/POS job is a GS v 0 raster with little-endian dimensions', () => {
  const mono = packMono(rgba, 16, 2);
  const bytes = [...escposJob(mono)];
  assert.deepEqual(bytes.slice(0, 10), [0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
  assert.deepEqual(bytes.slice(10, 14), [0xff, 0xff, 0x00, 0x01]);
});

test('only Kemas gets the direct printer, and only his page carries the panel', () => {
  assert.equal(directPrinterFor({ email: 'KEMAS@treelogy.com' })?.model, 'OKAY D100');
  assert.equal(directPrinterFor({ email: 'vanya@treelogy.com' }), null);
  assert.equal(directPrinterFor(null), null);
  const args = { orders: [], range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6' };
  assert.doesNotMatch(renderLabels(args), /id="dp"/);
  const his = renderLabels({ ...args, directPrinter: directPrinterFor({ email: 'kemas@treelogy.com' }) });
  assert.match(his, /id="dp-connect"/);
  assert.match(his, /navigator\.bluetooth\.requestDevice/);
});

test('the browser script is self-contained: the encoders are inlined, not imported', () => {
  const script = directPrintScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8 });
  assert.doesNotMatch(script, /\bimport\b|\brequire\(/);
  assert.match(script, /function packMono/);
  assert.match(script, /function tsplJob/);
  new Function(script); // parses
});
