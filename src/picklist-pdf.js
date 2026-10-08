import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { findProduct } from './master.js';
import { orderCode } from './mekari/prefix.js';

/**
 * A picklist batch as an A4 PDF to print and pick from.
 *
 * Two parts, the order a picker works in: what to take off the shelf (per product,
 * biggest first, with the photo and a box to tick), then what goes in each parcel (per
 * order, with a box per line). Drawn with pdf-lib and the standard Helvetica, so it opens
 * the same on any printer; text a standard font cannot draw is replaced, never dropped.
 */

const A4 = [595.28, 841.89];
const M = 36; // margin
const INK = rgb(0.1, 0.12, 0.11);
const MUTED = rgb(0.42, 0.45, 0.43);
const LINE = rgb(0.85, 0.87, 0.85);
const BRAND = rgb(0.32, 0.4, 0.28);
const CHANNEL = { tokopedia: 'Tokopedia', tiktok_shop: 'TikTok', shopee: 'Shopee', shopify: 'Shopify', manual: 'Manual' };

const WITA_DATE = (date, opts) => new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { ...opts, timeZone: 'UTC' });
const shift = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Fetch a product photo as something pdf-lib can embed: JPEG or PNG only, small. */
async function fetchImage(url, fetcher) {
  try {
    const res = await fetcher(url, { headers: { accept: 'image/jpeg,image/png' }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return { kind: 'jpg', bytes };
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { kind: 'png', bytes };
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {{date: string, orders: Array, picklist: object, images?: object, generatedAt?: number, fetcher?: Function}} input
 * @returns {Promise<Uint8Array>}
 */
export async function picklistPdf({ date, orders, picklist, images = {}, generatedAt = Date.now(), fetcher = fetch }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Picklist batch ${date}`);
  pdf.setProducer('Treelogy omnichannel');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Anything Helvetica (WinAnsi) cannot draw (an emoji in a buyer's name) is left out.
  const safeCache = new Map();
  const safe = (text) => [...String(text ?? '')].map((ch) => {
    if (!safeCache.has(ch)) { try { font.encodeText(ch); safeCache.set(ch, ch); } catch { safeCache.set(ch, ''); } }
    return safeCache.get(ch);
  }).join('').replace(/\s+/g, ' ').trim();
  const fit = (text, f, size, width) => {
    let t = safe(text);
    if (f.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  };

  // Photos, fetched once each and in parallel; a missing one leaves an empty frame.
  const photoUrl = (sku) => {
    const p = findProduct(sku);
    const hit = images[sku] ?? (p && images[p.sku]) ?? (p?.components ?? []).map((c) => images[c.sku] ?? images[findProduct(c.sku)?.sku]).find(Boolean);
    return hit?.thumb || hit?.url || '';
  };
  const wanted = [...new Set(picklist.items.map((i) => photoUrl(i.sku)).filter(Boolean))];
  const embedded = new Map();
  await Promise.all(wanted.map(async (url) => {
    const img = await fetchImage(url, fetcher);
    if (!img) return;
    try { embedded.set(url, img.kind === 'jpg' ? await pdf.embedJpg(img.bytes) : await pdf.embedPng(img.bytes)); } catch { /* unreadable: frame only */ }
  }));

  let page;
  let y;
  let pageNo = 0;
  const footer = () => {
    page.drawText(safe(`Picklist batch ${date} - halaman ${pageNo}`), { x: M, y: 20, size: 7.5, font, color: MUTED });
    const made = `dibuat ${new Date(generatedAt + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} WITA`;
    page.drawText(made, { x: A4[0] - M - font.widthOfTextAtSize(made, 7.5), y: 20, size: 7.5, font, color: MUTED });
  };
  const newPage = () => {
    if (page) footer();
    page = pdf.addPage(A4);
    pageNo += 1;
    y = A4[1] - M;
  };
  const need = (h) => { if (y - h < 40) newPage(); };
  const box = (x, top, s = 10) => page.drawRectangle({ x, y: top - s, width: s, height: s, borderColor: INK, borderWidth: 0.8 });
  const rule = () => page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: LINE });

  /* ---------------------------------------------------------------- heading */
  newPage();
  page.drawText('PICKLIST', { x: M, y: y - 10, size: 9, font: bold, color: BRAND });
  page.drawText(safe(`Batch ${WITA_DATE(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`), { x: M, y: y - 32, size: 18, font: bold, color: INK });
  page.drawText(safe(`${WITA_DATE(shift(date, -1), { day: 'numeric', month: 'short' })} 15.00 - ${WITA_DATE(date, { day: 'numeric', month: 'short' })} 15.00 WITA`), { x: M, y: y - 48, size: 9.5, font, color: MUTED });
  // Totals, right-aligned.
  const stats = [['Unit', picklist.unitCount], ['SKU', picklist.skuCount], ['Pesanan', picklist.orderCount]];
  let sx = A4[0] - M;
  for (const [label, n] of [...stats].reverse()) {
    const v = String(n);
    const w = Math.max(bold.widthOfTextAtSize(v, 18), font.widthOfTextAtSize(label.toUpperCase(), 7));
    page.drawText(v, { x: sx - w, y: y - 32, size: 18, font: bold, color: INK });
    page.drawText(label.toUpperCase(), { x: sx - w, y: y - 46, size: 7, font, color: MUTED });
    sx -= w + 24;
  }
  y -= 66;
  page.drawText('Picker: ______________________     Dicek: ______________________', { x: M, y: y - 4, size: 9, font, color: MUTED });
  y -= 22;

  if (!picklist.items.length) {
    page.drawText('Batch ini tidak berisi pesanan.', { x: M, y: y - 14, size: 11, font, color: MUTED });
    footer();
    return pdf.save();
  }

  /* ------------------------------------------------------ 1. per product */
  const section = (title, sub) => {
    need(44);
    page.drawText(safe(title), { x: M, y: y - 14, size: 11.5, font: bold, color: INK });
    page.drawText(safe(sub), { x: M + bold.widthOfTextAtSize(safe(title), 11.5) + 8, y: y - 14, size: 8.5, font, color: MUTED });
    y -= 22;
    rule();
  };
  section('1. Ambil dari rak', `${picklist.skuCount} produk, ${picklist.unitCount} unit`);
  const ROW = 40;
  for (const item of picklist.items) {
    need(ROW);
    const top = y - 6;
    box(M + 2, top - 9, 12);
    page.drawText(String(item.qty), { x: M + 24, y: top - 21, size: 16, font: bold, color: INK });
    const url = photoUrl(item.sku);
    const imgX = M + 62;
    page.drawRectangle({ x: imgX, y: top - 30, width: 30, height: 30, borderColor: LINE, borderWidth: 0.5, color: rgb(1, 1, 1) });
    const img = embedded.get(url);
    if (img) {
      const s = Math.min(28 / img.width, 28 / img.height);
      page.drawImage(img, { x: imgX + 1 + (28 - img.width * s) / 2, y: top - 29 + (28 - img.height * s) / 2, width: img.width * s, height: img.height * s });
    }
    const textX = imgX + 40;
    const p = findProduct(item.sku);
    const name = p ? `${p.name}${p.variant ? ` - ${p.variant}` : ''}` : `${item.name ?? item.sku}${item.variant ? ` - ${item.variant}` : ''}`;
    page.drawText(fit(name, bold, 10, 290), { x: textX, y: top - 13, size: 10, font: bold, color: INK });
    page.drawText(safe(item.sku), { x: textX, y: top - 26, size: 7.5, font, color: MUTED });
    const split = Object.entries(item.byChannel ?? {}).filter(([, n]) => n > 0).map(([c, n]) => `${CHANNEL[c] ?? c} ${n}`).join('  ');
    const orderText = `${item.orders} pesanan`;
    page.drawText(fit(split, font, 7.5, 150), { x: A4[0] - M - Math.min(150, font.widthOfTextAtSize(fit(split, font, 7.5, 150), 7.5)), y: top - 13, size: 7.5, font, color: MUTED });
    page.drawText(orderText, { x: A4[0] - M - font.widthOfTextAtSize(orderText, 8), y: top - 26, size: 8, font, color: MUTED });
    y -= ROW;
    rule();
  }
  y -= 14;

  /* ------------------------------------------------- 2. per transaction */
  section('2. Isi tiap paket', `${orders.length} pesanan, urut masuk picklist`);
  for (const o of orders) {
    const lines = o.lines ?? [];
    const h = 26 + lines.length * 14 + 8;
    need(Math.min(h, 200));
    const code = o.channel === 'shopify' || o.channel === 'manual' ? o.id : orderCode(o);
    page.drawText(fit(code, bold, 10, 190), { x: M + 18, y: y - 16, size: 10, font: bold, color: INK });
    page.drawText(safe(CHANNEL[o.channel] ?? o.channel), { x: M + 215, y: y - 16, size: 8.5, font: bold, color: BRAND });
    page.drawText(fit(o.buyer ?? '', font, 8.5, 160), { x: M + 285, y: y - 16, size: 8.5, font, color: MUTED });
    const units = lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);
    const ut = `${units} unit`;
    page.drawText(ut, { x: A4[0] - M - font.widthOfTextAtSize(ut, 8.5), y: y - 16, size: 8.5, font, color: MUTED });
    box(M + 2, y - 7, 10);
    y -= 26;
    for (const l of lines) {
      need(14);
      box(M + 22, y + 1, 8);
      page.drawText(`${Number(l.qty) || 0}x`, { x: M + 36, y: y - 6, size: 9, font: bold, color: INK });
      const p = findProduct(l.sku);
      const label = p ? `${p.name}${p.variant ? ` - ${p.variant}` : ''}` : `${l.name ?? l.sku}${l.variant ? ` - ${l.variant}` : ''}`;
      page.drawText(fit(label, font, 9, 340), { x: M + 58, y: y - 6, size: 9, font, color: INK });
      page.drawText(fit(l.sku ?? '', font, 7.5, 110), { x: A4[0] - M - 110, y: y - 6, size: 7.5, font, color: MUTED });
      y -= 14;
    }
    y -= 6;
    rule();
  }
  footer();
  return pdf.save();
}
