import test from 'node:test';
import assert from 'node:assert/strict';
import { packMono, tsplJob, escposJob, inkBands, placePage, directPrinterFor, directPrintScript, directPrintHostPage, hostScript, safeGo, HOST_PATH } from '../src/direct-print.js';
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

test('only the packers get the direct printer, and only their pages carry the panel', () => {
  assert.equal(directPrinterFor({ email: 'KEMAS@treelogy.com' })?.model, 'OKAY D100');
  assert.equal(directPrinterFor({ email: 'agas@treelogy.com' })?.model, 'OKAY D100', 'Agas packs at the same bench');
  assert.equal(directPrinterFor({ email: 'vanya@treelogy.com' }), null);
  assert.equal(directPrinterFor(null), null);
  const args = { orders: [], range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6' };
  assert.doesNotMatch(renderLabels(args), /id="dp"/);
  const kemas = { email: 'kemas@treelogy.com', name: 'Kemas', role: 'owner' };
  const his = renderLabels({ ...args, user: kemas, directPrinter: directPrinterFor(kemas) });
  assert.match(his, /id="dp-go"/);
  assert.match(his, /dp:hello/, 'the panel asks the host, it does not own the printer');
  assert.doesNotMatch(his, /requestDevice/);
  assert.match(his, /localStorage\.getItem\('dp\.host'\)/, 'a page outside the host moves into it once entered');
  assert.doesNotMatch(renderLabels(args), /dp\.host/);
});

test('the host script is self-contained: the encoders are inlined, not imported', () => {
  const script = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.65 });
  assert.doesNotMatch(script, /\bimport\b|\brequire\(/);
  assert.match(script, /function packMono/);
  assert.match(script, /function tsplJob/);
  assert.match(script, /requestDevice/);
  new Function(script); // parses
  new Function(directPrintScript({ model: 'x' })); // so does the panel's
});

test('the host frames only dashboard pages, never itself or another site', () => {
  assert.equal(safeGo('/api/dashboard?view=labels&reprint=1'), '/api/dashboard?view=labels&reprint=1');
  assert.equal(safeGo('/api/dashboard'), '/api/dashboard');
  assert.equal(safeGo('https://evil.example/x'), '/api/dashboard?view=labels');
  assert.equal(safeGo('//evil.example/x'), '/api/dashboard?view=labels');
  assert.equal(safeGo('/api/labels'), '/api/dashboard?view=labels');
  assert.equal(safeGo(HOST_PATH + '&go=x'), '/api/dashboard?view=labels', 'no host inside the host');
  assert.equal(safeGo(null), '/api/dashboard?view=labels');
  const html = directPrintHostPage({ printer: directPrinterFor({ email: 'kemas@treelogy.com' }), go: '/api/dashboard?view=orders&q="x"' });
  assert.match(html, /<iframe id="frame" src="\/api\/dashboard\?view=orders&amp;q=&quot;x&quot;"/);
  assert.match(html, /id="connect"/);
  assert.match(html, /dp:print/);
});

test('blank rows are not sent: one BITMAP per band of ink, close bands merged', () => {
  // 8 px wide, 40 rows: ink on rows 2-3, 30, and 36-39 (gap of 5 blank rows from 30).
  const rgba = new Uint8Array(8 * 40 * 4).fill(255);
  const inkRow = (y) => { for (let x = 0; x < 8; x += 1) rgba.set([0, 0, 0, 255], (y * 8 + x) * 4); };
  [2, 3, 30, 36, 37, 38, 39].forEach(inkRow);
  const mono = packMono(rgba, 8, 40, { black: 0 });
  assert.deepEqual(inkBands(mono), [[2, 4], [30, 40]]);
  const text = Buffer.from(tsplJob(mono)).toString('latin1');
  assert.match(text, /BITMAP 0,2,1,2,0,\x00\x00\r\nBITMAP 0,30,1,10,0,/);
  assert.equal((text.match(/BITMAP/g) ?? []).length, 2);
  assert.ok(text.endsWith('PRINT 1,1\r\n'));
  // A white label sends no bitmap at all.
  const white = packMono(new Uint8Array(8 * 4 * 4).fill(255), 8, 4, { black: 0 });
  assert.doesNotMatch(Buffer.from(tsplJob(white)).toString('latin1'), /BITMAP/);
  // The inverted polarity reads 0x00 as blank.
  assert.deepEqual(inkBands(packMono(rgba, 8, 40, { black: 1 }), { blank: 0x00 }), [[2, 4], [30, 40]]);
});

test('a page is drawn at the calibrated size, centred across and flush to the top', () => {
  const full = placePage(298, 420, { width: 800, height: 1200, fit: 1 });
  assert.equal(Math.round(298 * full.scale), 800);
  assert.deepEqual([full.x, full.y], [0, 0]);
  // The measured D100: 1.5x enlargement about the centre, down from the top.
  const d100 = placePage(298, 420, { width: 800, height: 1200, fit: 0.70 });
  assert.equal(Math.round(298 * d100.scale), 560);
  assert.equal(d100.x, 120, 'centred: the printer enlarges about the middle of the paper');
  assert.equal(d100.y, 0, 'flush to the top: the printer runs down from the top edge');
  assert.ok(420 * d100.scale <= 840);
  assert.equal(directPrinterFor({ email: 'kemas@treelogy.com' }).fit, 0.70, 'the measured figure, fixed in code');
});

test('the panel is on the reprint list too, with one primary button and nothing to calibrate', () => {
  const args = { orders: [], range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', directPrinter: directPrinterFor({ email: 'kemas@treelogy.com' }) };
  const reprint = renderLabels({ ...args, showReprints: true });
  assert.match(reprint, /id="dp-go"/);
  assert.doesNotMatch(reprint, /alibrasi/);
  assert.doesNotMatch(directPrintScript({ model: 'x', fit: 0.65 }), /dp\.fit/, 'the scale is never read from the phone');
  assert.equal((reprint.match(/class="cta dp__go"/g) ?? []).length, 1);
  assert.match(reprint, /dp:print/);
});
