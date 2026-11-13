import { createRequire } from 'node:module';
import { packMono, tsplJob, placePage, OKAY_D100 } from './direct-print.js';

/**
 * A label PDF, rendered here into the printer's own language.
 *
 * The bench agent only moves bytes; everything that needs a brain - reading the PDF,
 * drawing it, packing it to dots - happens on this machine, once, whoever pressed the
 * button and whatever they pressed it on. The same encoders the phone uses over
 * Bluetooth, so a label looks the same whichever road it took.
 *
 * pdf.js and the canvas are loaded on first use: they are the heaviest modules in the
 * project and most requests never print.
 */

const require = createRequire(import.meta.url);
const STANDARD_FONTS = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/');

let engine = null;
const load = () => {
  engine ??= Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('@napi-rs/canvas')])
    .then(([pdfjs, canvas]) => ({ getDocument: pdfjs.getDocument, createCanvas: canvas.createCanvas }));
  return engine;
};

/** @returns {Promise<Uint8Array[]>} one TSPL job per page */
export async function rasterizePdf(bytes, printer = OKAY_D100) {
  const { getDocument, createCanvas } = await load();
  const width = printer.widthMm * printer.dotsPerMm;
  const height = printer.heightMm * printer.dotsPerMm;
  const doc = await getDocument({
    data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, useSystemFonts: false,
    standardFontDataUrl: STANDARD_FONTS, verbosity: 0,
  }).promise;
  const jobs = [];
  try {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const sized = page.getViewport({ scale: 1 });
      const at = placePage(sized.width, sized.height, { width, height, fit: printer.fit ?? 1 });
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(at.x, at.y);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: at.scale }) }).promise;
      ctx.restore();
      const px = ctx.getImageData(0, 0, width, height).data;
      const mono = packMono(px, width, height, { black: 0 });
      jobs.push(tsplJob(mono, { widthMm: printer.widthMm, heightMm: printer.heightMm, gapMm: printer.gapMm, blank: 0xff }));
      page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => {});
  }
  return jobs;
}
