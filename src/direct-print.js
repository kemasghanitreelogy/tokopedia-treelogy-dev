/**
 * Printing a label straight to a Bluetooth label printer from the phone, no print dialog.
 *
 * Kemas prints from an Android phone to an OKAY D100 (110 mm thermal, USB + Bluetooth,
 * A6 / 100x150 labels). Chrome on Android talks to it over Web Bluetooth (BLE GATT): the
 * label PDF the server already builds is rendered page by page in the browser, turned
 * into 1-bit dots at 203 dpi (8 dots per mm) and sent as a TSPL job - the command
 * language A6 thermal label printers of this kind speak. ESC/POS is kept as a fallback,
 * and both the protocol and the dot polarity can be switched on the page, because a
 * cheap printer's documentation is rarely enough to know in advance.
 *
 * Offered per person: the printer is a device on one person's desk, not a property of
 * the shop. Everybody else keeps the print dialog exactly as before.
 */

export const DIRECT_PRINTERS = {
  'kemas@treelogy.com': { model: 'OKAY D100', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, size: '100x150' },
};

export function directPrinterFor(user) {
  const email = String(user?.email ?? '').toLowerCase();
  return DIRECT_PRINTERS[email] ?? null;
}

/*
 * The encoders below run in the browser - their source is sent with the page - and are
 * exported so the exact bytes can be checked here. Keep them self-contained: no imports,
 * no closures over module scope.
 */

/**
 * RGBA pixels to packed 1-bit rows, MSB first, `black` bits set for dark pixels.
 * Returns { bytes, widthBytes, height }.
 */
export function packMono(rgba, width, height, { threshold = 160, black = 1 } = {}) {
  const widthBytes = Math.ceil(width / 8);
  const bytes = new Uint8Array(widthBytes * height);
  if (!black) bytes.fill(0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3] / 255;
      // Transparent counts as paper, not ink.
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * alpha + 255 * (1 - alpha);
      if (lum < threshold) {
        const at = y * widthBytes + (x >> 3);
        const bit = 0x80 >> (x & 7);
        if (black) bytes[at] |= bit; else bytes[at] &= ~bit;
      }
    }
  }
  return { bytes, widthBytes, height };
}

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * One TSPL label. TSPL's BITMAP prints a dot where the bit is 0, so the image is packed
 * with `black: 0` unless the page's "balik warna" switch says this printer differs.
 */
export function tsplJob(mono, { widthMm = 100, heightMm = 150, gapMm = 2, rotate = false } = {}) {
  return join([
    ascii(`SIZE ${widthMm} mm,${heightMm} mm\r\nGAP ${gapMm} mm,0 mm\r\nDIRECTION ${rotate ? 1 : 0}\r\nCLS\r\n`),
    ascii(`BITMAP 0,0,${mono.widthBytes},${mono.height},0,`),
    mono.bytes,
    ascii('\r\nPRINT 1,1\r\n'),
  ]);
}

/** The same image as ESC/POS raster (GS v 0), a dot where the bit is 1, then a feed. */
export function escposJob(mono) {
  const { widthBytes, height } = mono;
  return join([
    Uint8Array.of(0x1b, 0x40),
    Uint8Array.of(0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, height & 0xff, height >> 8),
    mono.bytes,
    Uint8Array.of(0x1b, 0x64, 0x03),
  ]);
}

/**
 * BLE services cheap thermal printers expose their write characteristic under. Web
 * Bluetooth only lets a page reach services it named up front, so the common ones are
 * all named; the first writable characteristic found is used.
 */
export const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

/** The browser half, as source: the encoders plus the Bluetooth and PDF plumbing. */
export function directPrintScript(printer) {
  return `
(function () {
  var printer = ${JSON.stringify(printer)};
  var SERVICES = ${JSON.stringify(PRINTER_SERVICES)};
  var packMono = ${packMono.toString()};
  var ascii = ${ascii.toString()};
  var join = ${join.toString()};
  var tsplJob = ${tsplJob.toString()};
  var escposJob = ${escposJob.toString()};

  var box = document.getElementById('dp');
  var form = document.getElementById('lbform');
  if (!box || !form) return;
  var state = box.querySelector('.dp__state');
  var connectBtn = document.getElementById('dp-connect');
  var testBtn = document.getElementById('dp-test');
  var goBtn = document.getElementById('dp-go');
  var protoSel = document.getElementById('dp-proto');
  var invertBox = document.getElementById('dp-invert');
  var rotateBox = document.getElementById('dp-rotate');
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  protoSel.value = store.get('dp.proto') || 'tspl';
  invertBox.checked = store.get('dp.invert') === '1';
  rotateBox.checked = store.get('dp.rotate') === '1';
  protoSel.onchange = function () { store.set('dp.proto', protoSel.value); };
  invertBox.onchange = function () { store.set('dp.invert', invertBox.checked ? '1' : '0'); };
  rotateBox.onchange = function () { store.set('dp.rotate', rotateBox.checked ? '1' : '0'); };

  var device = null, ch = null;
  function say(text, tone) { state.textContent = text; state.className = 'dp__state ' + (tone || ''); }
  function ready() { testBtn.disabled = !ch; goBtn.disabled = !ch; connectBtn.textContent = ch ? 'Ganti printer' : 'Sambungkan printer'; }

  if (!navigator.bluetooth) {
    say('Browser ini tidak mendukung Bluetooth. Buka di Chrome Android.', 'stop');
    connectBtn.disabled = true; ready(); return;
  }

  async function connect() {
    say('Memilih printer...');
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    device.addEventListener('gattserverdisconnected', function () { ch = null; ready(); say('Printer terputus - sambungkan lagi.', 'flag'); });
    var server = await device.gatt.connect();
    var services = await server.getPrimaryServices();
    for (var s = 0; s < services.length && !ch; s++) {
      var chars = await services[s].getCharacteristics();
      for (var c = 0; c < chars.length; c++) {
        if (chars[c].properties.writeWithoutResponse || chars[c].properties.write) { ch = chars[c]; break; }
      }
    }
    if (!ch) throw new Error('printer tersambung tapi tidak ada jalur tulis Bluetooth (BLE) yang dikenal');
    ready();
    say('Tersambung: ' + (device.name || printer.model), 'ok');
  }

  async function send(bytes) {
    var size = 180, quick = !!ch.properties.writeWithoutResponse;
    for (var at = 0; at < bytes.length; at += size) {
      var part = bytes.slice(at, at + size);
      if (quick) { await ch.writeValueWithoutResponse(part); await new Promise(function (r) { setTimeout(r, 12); }); }
      else await ch.writeValue(part);
    }
  }

  function job(canvas) {
    var ctx = canvas.getContext('2d');
    var px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var tspl = protoSel.value === 'tspl';
    // TSPL prints where the bit is 0, ESC/POS where it is 1; the switch flips either.
    var blackBit = (tspl ? 0 : 1) ^ (invertBox.checked ? 1 : 0);
    var mono = packMono(px, canvas.width, canvas.height, { black: blackBit });
    return tspl
      ? tsplJob(mono, { widthMm: printer.widthMm, heightMm: printer.heightMm, gapMm: printer.gapMm, rotate: rotateBox.checked })
      : escposJob(mono);
  }

  function blankCanvas() {
    var c = document.createElement('canvas');
    c.width = printer.widthMm * printer.dotsPerMm;
    c.height = printer.heightMm * printer.dotsPerMm;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  var pdfjs = null;
  function loadPdfjs() {
    if (pdfjs) return Promise.resolve(pdfjs);
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      tag.onload = function () {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        pdfjs = window.pdfjsLib; resolve(pdfjs);
      };
      tag.onerror = function () { reject(new Error('pembaca PDF gagal dimuat')); };
      document.head.appendChild(tag);
    });
  }

  async function printPdf(base64) {
    var lib = await loadPdfjs();
    var raw = atob(base64), data = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    var doc = await lib.getDocument({ data: data }).promise;
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var base = page.getViewport({ scale: 1 });
      var canvas = blankCanvas();
      // Fitted inside the label, centred: a marketplace waybill is not always 100x150.
      var scale = Math.min(canvas.width / base.width, canvas.height / base.height);
      var view = page.getViewport({ scale: scale });
      var ctx = canvas.getContext('2d');
      ctx.save();
      ctx.translate(Math.round((canvas.width - view.width) / 2), Math.round((canvas.height - view.height) / 2));
      await page.render({ canvasContext: ctx, viewport: view }).promise;
      ctx.restore();
      say('Mengirim label ' + p + ' dari ' + doc.numPages + '...');
      await send(job(canvas));
    }
    return doc.numPages;
  }

  connectBtn.addEventListener('click', function () {
    connect().catch(function (e) { ch = null; ready(); say(e.name === 'NotFoundError' ? 'Batal memilih printer.' : 'Gagal menyambung: ' + e.message, 'stop'); });
  });

  testBtn.addEventListener('click', async function () {
    try {
      var c = blankCanvas(), ctx = c.getContext('2d');
      ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.strokeRect(20, 20, c.width - 40, c.height - 40);
      ctx.fillStyle = '#000'; ctx.font = 'bold 64px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('TES ' + printer.model, c.width / 2, c.height / 2 - 40);
      ctx.font = '40px sans-serif';
      ctx.fillText(protoSel.value.toUpperCase() + (invertBox.checked ? ' · dibalik' : ''), c.width / 2, c.height / 2 + 40);
      say('Mengirim halaman tes...');
      await send(job(c));
      say('Halaman tes terkirim. Kalau hitam semua, centang "balik warna"; kalau kosong, coba ESC/POS.', 'ok');
    } catch (e) { say('Tes gagal: ' + e.message, 'stop'); }
  });

  goBtn.addEventListener('click', async function () {
    var body = new URLSearchParams(new FormData(form));
    body.set('format', 'json');
    var picked = body.getAll('order').length;
    if (!picked) { say('Centang minimal satu pesanan.', 'flag'); return; }
    goBtn.disabled = true;
    try {
      say('Menyiapkan ' + picked + ' label...');
      var res = await fetch('/api/labels', { method: 'POST', body: body, credentials: 'same-origin' });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
      var pages = 0;
      for (var g = 0; g < out.groups.length; g++) pages += await printPdf(out.groups[g].pdfBase64);
      var failed = (out.failures || []).length;
      say(pages + ' label terkirim ke printer' + (failed ? ' · ' + failed + ' gagal disiapkan: ' + out.failures.map(function (f) { return f.id; }).join(', ') : ''), failed ? 'flag' : 'ok');
      // The print is recorded server-side; the list should show it.
      setTimeout(function () { location.reload(); }, failed ? 6000 : 2500);
    } catch (e) {
      say('Gagal mencetak: ' + e.message, 'stop');
    } finally { ready(); }
  });
  ready();
})();
`;
}
