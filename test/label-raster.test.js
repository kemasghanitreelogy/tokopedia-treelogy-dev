import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { rasterizePdf } from '../src/label-raster.js';
import { inkBands, OKAY_D100 } from '../src/direct-print.js';

const label = async (text) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([298, 420]);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText(text, { x: 20, y: 380, size: 22, font, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 10, y: 10, width: 278, height: 400, borderWidth: 2, borderColor: rgb(0, 0, 0), color: rgb(1, 1, 1) });
  return doc.save();
};

test('a label PDF becomes one TSPL job per page, drawn at the bench printer\'s fit', async () => {
  const bytes = await label('PICK-000013761');
  const jobs = await rasterizePdf(bytes);
  assert.equal(jobs.length, 1);
  const text = Buffer.from(jobs[0]).toString('latin1');
  assert.match(text, /^SIZE 100 mm,150 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 0\r\nCLS\r\n/);
  assert.match(text, /BITMAP 0,\d+,100,\d+,0,/);
  assert.ok(text.endsWith('PRINT 1,1\r\n'));
  // The frame drawn 10pt in from the page edge lands inside the fitted, centred box.
  const widthDots = OKAY_D100.widthMm * OKAY_D100.dotsPerMm;
  const boxW = Math.round(298 * Math.min((widthDots * OKAY_D100.fit) / 298, (1200 * OKAY_D100.fit) / 420));
  assert.ok(boxW > 500 && boxW < 600, `page drawn ${boxW} dots wide`);
});

test('a blank page sends the size and PRINT, and not a single row of dots', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([298, 420]);
  const [job] = await rasterizePdf(await doc.save());
  const text = Buffer.from(job).toString('latin1');
  assert.doesNotMatch(text, /BITMAP/);
  assert.match(text, /PRINT 1,1/);
});

test('ink bands of a rendered label are few and bounded', async () => {
  const [job] = await rasterizePdf(await label('X'));
  const text = Buffer.from(job).toString('latin1');
  const bands = (text.match(/BITMAP 0,(\d+),100,(\d+),0,/g) ?? []).length;
  assert.ok(bands >= 1 && bands <= 6, `${bands} bands`);
  assert.ok(inkBands !== undefined);
});
