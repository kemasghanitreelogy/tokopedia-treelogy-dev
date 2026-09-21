import { spawn } from 'node:child_process';
import { readDoc, updateDoc } from '../store/index.js';
import { callShopApi } from './client.js';

/**
 * Who a Shopee parcel is going to.
 *
 * Shopee's order detail masks the recipient entirely - name, phone and address all come
 * back as "****" for a third-party app, and only the username survives. The same shop
 * printing the same parcel in Seller Centre sees everything, so the data is not secret,
 * it is withheld from the API in a form a machine can read.
 *
 * The one endpoint that still discloses it is the shipping-document data feed, meant for
 * apps that draw their own labels: it answers with the name and the address as small PNG
 * images, one per field, and only while the parcel is in the printable window (arranged,
 * not yet collected). Past that it refuses with error_status. The phone is on offer too,
 * but Shopee masks it to its last two digits even there ("******03"), so it is not asked for.
 *
 * So the recipient is captured during that window, read off the images with Tesseract,
 * and kept here by order number. Both images wrap by pixel, mid-word - a long name runs
 * onto a second line just as an address does - which is why the lines are joined by
 * measuring them: a line that runs to the edge broke inside a word and gets no space; a
 * short one broke at one and does.
 */

export const RECIPIENT_DOC = 'shopee/recipients.json';
const EMPTY = { recipients: {} };
const KEYS = ['name', 'full_address'];
/** Statuses in which Shopee will hand out the shipping document data. */
export const CAPTURABLE = new Set(['PROCESSED']);
const CONCURRENCY = 3;
const CAP_PER_READ = 40;
const KEEP_DAYS = 180;
/** A line whose ink reaches this close to the image edge wrapped inside a word. */
const EDGE_PX = 16;

const decodePng = (dataUri) => {
  const comma = String(dataUri ?? '').indexOf(',');
  return comma > 0 ? Buffer.from(dataUri.slice(comma + 1), 'base64') : null;
};

/** PNG width from the IHDR chunk; the wrap test needs it. */
export function pngWidth(png) {
  if (!png || png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return 0;
  return png.readUInt32BE(16);
}

/** Run Tesseract over one image. `psm` 7 is a single line, 6 a block; `tsv` gives boxes. */
export function tesseract(png, { psm = 7, tsv = false, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['stdin', 'stdout', '--psm', String(psm), ...(tsv ? ['tsv'] : [])];
    // One thread each. Tesseract spawns a thread per core by default, and three of them
    // side by side on four cores turned a 120ms read into a minute of thrashing.
    const child = spawn('tesseract', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    const out = [];
    const err = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tesseract melewati batas waktu')); }, timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`tesseract tidak bisa dijalankan: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`tesseract keluar dengan kode ${code}: ${Buffer.concat(err).toString().trim().slice(0, 200)}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(png);
  });
}

/**
 * Lines with their right edge, out of Tesseract's TSV.
 * @returns {{text: string, right: number}[]}
 */
export function linesFromTsv(tsv) {
  const rows = String(tsv ?? '').split('\n').slice(1).map((r) => r.split('\t'));
  const lines = new Map();
  for (const row of rows) {
    if (row.length < 12 || row[0] !== '5') continue;
    const text = row[11].trim();
    if (!text) continue;
    const key = `${row[2]}-${row[3]}-${row[4]}`;
    const right = Number(row[6]) + Number(row[8]);
    const line = lines.get(key) ?? { words: [], right: 0 };
    line.words.push(text);
    line.right = Math.max(line.right, right);
    lines.set(key, line);
  }
  return [...lines.values()].map((l) => ({ text: l.words.join(' '), right: l.right }));
}

/** Rejoin a pixel-wrapped block into the one string it was rendered from. */
export function joinWrapped(lines, width) {
  let out = '';
  for (const [index, line] of lines.entries()) {
    out += line.text;
    if (index === lines.length - 1) break;
    const next = lines[index + 1].text;
    const hard = width > 0 && line.right >= width - EDGE_PX;
    // A line that reached the edge usually broke inside a word. Not always: a word that
    // ended right at the edge looks the same, so the letters decide the rest - a comma or
    // a full stop at the end, or a lower-case letter running into a capital, is a space.
    const ended = /[,.;:)]$/.test(line.text);
    const caseTurn = /[a-z]$/.test(line.text) && /^[A-Z]/.test(next);
    const startsPunct = /^[,.;:)]/.test(next);
    if (startsPunct) continue;
    if (!hard || ended || caseTurn) out += ' ';
  }
  return tidy(out);
}

/**
 * Region words that Shopee writes in capitals, one after another, so a wrap between two
 * of them cannot be told from a wrap inside one: "KOTA JAKARTASELATAN", "JAWATIMUR".
 * A known word glued to the next capital gets its space back. Kotabaru, Kotawaringin and
 * Kotamobagu are one word and are left alone.
 */
const REGION_WORD = /\b(KOTA(?!BARU|WARINGIN|MOBAGU)|KAB\.|JAWA|DKI|SUMATERA|SULAWESI|KALIMANTAN|KEPULAUAN|NUSA|MALUKU|PAPUA|JAKARTA(?=SELATAN|PUSAT|TIMUR|UTARA|BARAT))(?=[A-Z])/g;

/** The reading errors that happen every day, put right. */
export function tidy(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    // A pipe is never in an address; it is a capital I that Tesseract lost the serifs of.
    .replace(/\|/g, 'I')
    // The one abbreviation on nearly every Indonesian address, and the one Tesseract
    // misreads: a lower-case l beside a capital J comes out as a capital I.
    .replace(/\bJI\.?(?=\s)/g, 'Jl.')
    .replace(REGION_WORD, '$1 ')
    // A capital I at the start of a word reads as a lower-case l: "lffan", "lndah".
    // Only before a consonant, where no Indonesian word starts with an l.
    .replace(/\bl(?=[bcdfghjkmnpqrstvwxz][a-z])/g, 'I')
    .trim();
}

/** One wrapped image to one line of text, with its boxes deciding the joins. */
async function readBlock(png, ocr) {
  const tsv = await ocr(png, { psm: 6, tsv: true });
  return joinWrapped(linesFromTsv(tsv), pngWidth(png));
}

/**
 * Read the images into text.
 * @param {{name?: Buffer, address?: Buffer}} images
 */
export async function readRecipientImages(images, { ocr = tesseract } = {}) {
  const out = { name: '', phone: '', address: '' };
  // The name is read as a block too: "Deazy Christine Sebayang" arrives on two lines,
  // and a single-line read of that image loses its first word.
  if (images.name) out.name = await readBlock(images.name, ocr);
  if (images.address) out.address = await readBlock(images.address, ocr);
  return out;
}

/** The images Shopee hands out for one order, or a throw when it will not. */
export async function fetchRecipientImages(config, auth, orderSn, { call = callShopApi } = {}) {
  const result = await call(config, '/api/v2/logistics/get_shipping_document_data_info', auth, {}, {
    order_sn: orderSn,
    recipient_address_info: KEYS.map((key) => ({ key })),
  });
  const fields = result?.response?.recipient_address_info ?? [];
  const byKey = Object.fromEntries(fields.map((f) => [f.key, decodePng(f.image)]));
  return { name: byKey.name ?? null, address: byKey.full_address ?? null };
}

export async function loadShopeeRecipients() {
  const doc = await readDoc(RECIPIENT_DOC).catch(() => null);
  return doc?.recipients ?? {};
}

async function limited(items, limit, worker) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) await worker(queue.shift());
  }));
}

/**
 * Capture whoever can be captured right now, and keep it.
 *
 * Runs on every live Shopee read - the sweep, the dashboard when it has to go live, the
 * webhook's re-read - so a parcel arranged at 15:00 is named by the 15:15 sweep at the
 * latest. Orders already captured cost nothing. Nothing here can fail the read that
 * called it: a refusal or an OCR that will not run is a warning and an empty name.
 *
 * @returns {Promise<{captured: number, skipped: number, failed: number}>}
 */
export async function captureShopeeRecipients(orders, {
  config, auth, call = callShopApi, ocr = tesseract, now = Math.floor(Date.now() / 1000), known = null,
} = {}) {
  const have = known ?? await loadShopeeRecipients();
  const wanted = orders
    .filter((o) => o.channel === 'shopee' && CAPTURABLE.has(o.status) && !have[o.id])
    .slice(0, CAP_PER_READ);
  const tally = { captured: 0, skipped: orders.length - wanted.length, failed: 0 };
  if (wanted.length === 0) return tally;

  const found = {};
  await limited(wanted, CONCURRENCY, async (order) => {
    try {
      const images = await fetchRecipientImages(config, auth, order.id, { call });
      const text = await readRecipientImages(images, { ocr });
      if (!text.name && !text.phone && !text.address) { tally.failed += 1; return; }
      found[order.id] = { ...text, at: now };
      tally.captured += 1;
    } catch (error) {
      // error_status is the parcel being outside its window, which is ordinary; anything
      // else is worth a line in the log and nothing more.
      if (error?.code !== 'error_status') console.warn(`shopee/recipient: ${order.id} - ${error.message}`);
      tally.failed += 1;
    }
  });

  if (tally.captured > 0) {
    await updateDoc(RECIPIENT_DOC, (current) => {
      const next = current ?? structuredClone(EMPTY);
      Object.assign(next.recipients, found);
      const floor = now - KEEP_DAYS * 86400;
      for (const [id, entry] of Object.entries(next.recipients)) {
        if ((entry?.at ?? 0) < floor) delete next.recipients[id];
      }
      return next;
    });
  }
  return tally;
}

/**
 * Put the captured recipient onto the orders it belongs to.
 *
 * The username Shopee did disclose is kept beside the name, because it is what the
 * buyer is called everywhere else in Shopee and what the books were opened under.
 */
export function applyShopeeRecipients(orders, recipients) {
  if (!recipients) return orders;
  for (const order of orders) {
    if (order.channel !== 'shopee') continue;
    const entry = recipients[order.id];
    if (!entry) continue;
    if (entry.name) {
      if (!order.buyerUsername && order.buyer !== entry.name) order.buyerUsername = order.buyer;
      order.buyer = entry.name;
    }
    if (entry.phone) order.buyerPhone = entry.phone;
    if (entry.address) order.shipTo = entry.address;
  }
  return orders;
}
