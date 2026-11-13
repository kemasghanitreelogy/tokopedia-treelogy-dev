/**
 * Printing a label straight to a Bluetooth label printer from the phone, no print dialog.
 *
 * Kemas prints from an Android phone to an OKAY D100 (110 mm thermal, USB + Bluetooth,
 * 100x150 labels; the seller lists TSPL/EPL/ZPL/DPL emulation). Chrome on Android talks
 * to it over Web Bluetooth (BLE GATT): the label PDF the server already builds is
 * rendered page by page in the browser, turned into 1-bit dots at 8 dots/mm and sent as
 * a TSPL job. Confirmed on 13 Nov 2026: the printer took TSPL over BLE and printed.
 *
 * What the first print taught:
 *
 * - The output came out about twice too large. Whether the head is narrower than the
 *   label or the firmware stretches the bitmap, the cure is the same: draw the label
 *   into the first W mm of the bitmap, where W is what the printer actually puts on
 *   100 mm of paper. W is found once by printing a ruler and tapping the last number
 *   that reached the edge (`fit`), and remembered on the phone.
 * - A full label is 120 KB of dots and BLE moves a few hundred bytes per packet, so the
 *   bytes are what the print costs. Blank rows are not sent at all (one BITMAP per band
 *   of ink), the packet size is probed upward from the safe 20 bytes and remembered, and
 *   the printer stays connected between prints. "Pencet, langsung kekirim."
 * - The printer is remembered by id and reconnected on page load without a tap where
 *   Chrome allows it (getDevices); otherwise one tap on "Sambungkan".
 *
 * Offered per person: the printer is a device on one person's desk, not a property of
 * the shop. Everybody else keeps the print dialog exactly as before.
 */

export const DIRECT_PRINTERS = {
  'kemas@treelogy.com': { model: 'OKAY D100', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8 },
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
 * The rows that carry ink, as [from, to) bands. `blank` is the byte value of a row with
 * no ink (0xff when 0 means black, as TSPL has it). Bands closer than `gap` rows are
 * merged, because a BITMAP header costs more than a few empty rows.
 */
export function inkBands(mono, { blank = 0xff, gap = 8 } = {}) {
  const { bytes, widthBytes, height } = mono;
  const bands = [];
  let start = -1;
  for (let y = 0; y < height; y += 1) {
    let ink = false;
    const row = y * widthBytes;
    for (let b = 0; b < widthBytes; b += 1) { if (bytes[row + b] !== blank) { ink = true; break; } }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      const last = bands[bands.length - 1];
      if (last && start - last[1] < gap) last[1] = y; else bands.push([start, y]);
      start = -1;
    }
  }
  if (start >= 0) {
    const last = bands[bands.length - 1];
    if (last && start - last[1] < gap) last[1] = height; else bands.push([start, height]);
  }
  return bands;
}

/**
 * One TSPL label: the size, then one BITMAP per band of ink, then PRINT. TSPL's BITMAP
 * prints a dot where the bit is 0, so the image is packed with `black: 0` unless the
 * page's "balik warna" switch says this printer differs - in which case `blank` is 0x00.
 */
export function tsplJob(mono, { widthMm = 100, heightMm = 150, gapMm = 2, rotate = false, blank = 0xff } = {}) {
  const parts = [ascii(`SIZE ${widthMm} mm,${heightMm} mm\r\nGAP ${gapMm} mm,0 mm\r\nDIRECTION ${rotate ? 1 : 0}\r\nCLS\r\n`)];
  for (const [from, to] of inkBands(mono, { blank })) {
    parts.push(ascii(`BITMAP 0,${from},${mono.widthBytes},${to - from},0,`));
    parts.push(mono.bytes.subarray(from * mono.widthBytes, to * mono.widthBytes));
    parts.push(ascii('\r\n'));
  }
  parts.push(ascii('PRINT 1,1\r\n'));
  return join(parts);
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
 * Where a page goes on the bitmap: fitted inside the first `fit` of the label on both
 * axes and centred there, so a printer that puts our 800 dots across W mm of paper
 * prints the label at its true size. {x, y, scale} for a page of `pageW`x`pageH` points.
 */
export function placePage(pageW, pageH, { width, height, fit = 1 }) {
  const boxW = Math.round(width * fit);
  const boxH = Math.round(height * fit);
  const scale = Math.min(boxW / pageW, boxH / pageH);
  return { x: Math.round((boxW - pageW * scale) / 2), y: Math.round((boxH - pageH * scale) / 2), scale };
}

/** Which label widths the calibration offers, in mm; the ruler is marked to match. */
export const CALIBRATION_STOPS = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];

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

/** The panel. One primary action; everything else is a text button or folded away. */
export function directPrintPanel(printer, { escape }) {
  return `<section class="dp" id="dp" aria-label="Cetak langsung ke ${escape(printer.model)}">
    <div class="dp__head">
      <span class="dp__dot" id="dp-dot" aria-hidden="true"></span>
      <span class="dp__name">${escape(printer.model)}</span>
      <span class="dp__state" id="dp-state" role="status" aria-live="polite">Mencari printer…</span>
    </div>
    <button class="cta dp__go" type="button" id="dp-go" disabled>
      <span class="dp__go-label">Cetak langsung</span><span class="dp__go-n" id="dp-n"></span>
    </button>
    <div class="dp__bar" id="dp-bar" hidden><span id="dp-fill"></span></div>
    <div class="dp__tools">
      <button class="dp__link" type="button" id="dp-connect">Sambungkan</button>
      <button class="dp__link" type="button" id="dp-cal" disabled>Kalibrasi ukuran</button>
      <button class="dp__link" type="button" id="dp-test" disabled>Halaman tes</button>
      <details class="dp__adv">
        <summary class="dp__link">Lanjutan</summary>
        <div class="dp__advrow">
          <label>Bahasa <select class="dr__in" id="dp-proto"><option value="tspl">TSPL</option><option value="escpos">ESC/POS</option></select></label>
          <label><input type="checkbox" id="dp-invert"> balik warna</label>
          <label><input type="checkbox" id="dp-rotate"> putar 180&deg;</label>
          <span class="dim" id="dp-meta"></span>
        </div>
      </details>
    </div>
    <div class="dp__cal" id="dp-calrow" hidden>
      <p>Angka terakhir yang masih terbaca di tepi kanan kertas:</p>
      <div class="dp__stops">${CALIBRATION_STOPS.map((mm) => `<button class="chip" type="button" data-fit="${mm}">${mm}</button>`).join('')}</div>
    </div>
  </section>`;
}

export const DIRECT_PRINT_CSS = `
.dp{margin:.75rem 0 1rem; padding:.9rem 1rem 1rem; border:1px solid var(--line); border-radius:12px; background:var(--panel-2)}
.dp__head{display:flex; flex-wrap:wrap; align-items:center; gap:.3rem .5rem; margin-bottom:.7rem; min-height:1.5rem}
.dp__dot{width:.6rem; height:.6rem; border-radius:50%; background:var(--dim); flex:none; transition:background .2s}
.dp__dot.is-busy{background:var(--warn)} .dp__dot.is-on{background:var(--good); box-shadow:0 0 8px var(--good)} .dp__dot.is-off{background:var(--bad)}
.dp__name{font-weight:600; white-space:nowrap}
.dp__state{color:var(--muted); font-size:.9rem; flex-basis:100%; padding-left:1.1rem}
.dp__go{width:100%; min-height:48px; justify-content:center; gap:.5rem; font-size:1.05rem; cursor:pointer}
.dp__go:disabled{opacity:.5; cursor:default}
.dp__go-n:not(:empty)::before{content:'· '}
.dp__bar{height:4px; margin:.6rem 0 0; border-radius:2px; background:var(--line); overflow:hidden}
.dp__bar span{display:block; height:100%; width:0; background:var(--good); transition:width .15s}
.dp__tools{display:flex; flex-wrap:wrap; align-items:center; gap:.25rem 1rem; margin-top:.7rem}
.dp__link{background:none; border:0; padding:.5rem 0; color:var(--muted); font:inherit; font-size:.9rem; cursor:pointer; text-decoration:underline; text-underline-offset:3px; text-decoration-color:transparent; transition:color .15s, text-decoration-color .15s}
.dp__link:hover, .dp__link:focus-visible{color:var(--fg); text-decoration-color:currentColor; outline:none}
.dp__link:disabled{opacity:.45; cursor:default; text-decoration:none}
.dp__adv{flex-basis:100%} .dp__adv summary{list-style:none; display:inline-block} .dp__adv summary::-webkit-details-marker{display:none}
.dp__advrow{display:flex; flex-wrap:wrap; gap:.5rem 1rem; align-items:center; padding:.4rem 0 .2rem; font-size:.9rem; color:var(--muted)}
.dp__advrow label{display:inline-flex; align-items:center; gap:.3rem}
.dp__cal{margin-top:.6rem; padding-top:.6rem; border-top:1px solid var(--line)}
.dp__cal p{margin:0 0 .5rem; color:var(--muted); font-size:.9rem}
.dp__stops{display:flex; flex-wrap:wrap; gap:.4rem}
.dp__stops .chip{min-height:40px; min-width:44px; justify-content:center; cursor:pointer}
@media (prefers-reduced-motion: reduce){.dp__dot,.dp__bar span,.dp__link{transition:none}}
`;

/** The browser half, as source: the encoders plus the Bluetooth and PDF plumbing. */
export function directPrintScript(printer) {
  return `
(function () {
  var printer = ${JSON.stringify(printer)};
  var SERVICES = ${JSON.stringify(PRINTER_SERVICES)};
  var packMono = ${packMono.toString()};
  var ascii = ${ascii.toString()};
  var join = ${join.toString()};
  var inkBands = ${inkBands.toString()};
  var tsplJob = ${tsplJob.toString()};
  var escposJob = ${escposJob.toString()};
  var placePage = ${placePage.toString()};

  var box = document.getElementById('dp');
  var form = document.getElementById('lbform');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var dot = $('dp-dot'), state = $('dp-state'), goBtn = $('dp-go'), goN = $('dp-n'), bar = $('dp-bar'), fill = $('dp-fill');
  var connectBtn = $('dp-connect'), calBtn = $('dp-cal'), testBtn = $('dp-test'), calRow = $('dp-calrow');
  var protoSel = $('dp-proto'), invertBox = $('dp-invert'), rotateBox = $('dp-rotate'), meta = $('dp-meta');

  /* ---- remembered on this phone: printer, packet size, scale, switches ---- */
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} } };
  var prefs = {
    proto: store.get('dp.proto') || 'tspl',
    invert: store.get('dp.invert') === '1',
    rotate: store.get('dp.rotate') === '1',
    fit: Math.min(1, Math.max(0.3, Number(store.get('dp.fit')) || 1)),
    chunk: Number(store.get('dp.chunk')) || 0,
    device: store.get('dp.device') || '',
  };
  protoSel.value = prefs.proto; invertBox.checked = prefs.invert; rotateBox.checked = prefs.rotate;
  protoSel.onchange = function () { prefs.proto = protoSel.value; store.set('dp.proto', prefs.proto); showMeta(); };
  invertBox.onchange = function () { prefs.invert = invertBox.checked; store.set('dp.invert', prefs.invert ? 1 : 0); };
  rotateBox.onchange = function () { prefs.rotate = rotateBox.checked; store.set('dp.rotate', prefs.rotate ? 1 : 0); };
  function showMeta() {
    meta.textContent = 'skala ' + Math.round(prefs.fit * 100) + '%' + (prefs.chunk ? ' · paket ' + prefs.chunk + ' B' : '') + ' · ' + prefs.proto.toUpperCase();
  }
  showMeta();

  /* ---- status ---- */
  var device = null, ch = null, busy = false;
  function say(text, tone) { state.textContent = text; dot.className = 'dp__dot ' + (tone || ''); }
  function picked() {
    if (!form) return 0;
    return form.querySelectorAll('.pick:checked:not(:disabled)').length;
  }
  function ready() {
    var n = picked();
    goN.textContent = n ? n + ' label' : '';
    goBtn.disabled = !ch || busy || n === 0;
    testBtn.disabled = !ch || busy; calBtn.disabled = !ch || busy;
    connectBtn.textContent = ch ? 'Ganti printer' : 'Sambungkan';
    connectBtn.disabled = busy;
  }
  if (form) form.addEventListener('change', ready);
  // The search adds rows after the fact; count again when the list changes.
  if (form) new MutationObserver(ready).observe(form, { childList: true, subtree: true });

  if (!navigator.bluetooth) {
    say('Buka di Chrome Android untuk mencetak langsung.', 'is-off');
    connectBtn.disabled = true; ready(); return;
  }

  /* ---- connection ---- */
  function wire(dev) {
    device = dev;
    dev.addEventListener('gattserverdisconnected', function () {
      ch = null; ready(); say('Terputus - menyambung lagi…', 'is-busy');
      // Printers nap; wake them with a retry or three rather than a tap.
      attach(dev, 3).catch(function () { say('Printer terputus. Nyalakan lagi, lalu ketuk Sambungkan.', 'is-off'); ready(); });
    });
  }
  async function attach(dev, tries) {
    var server = null, err = null;
    for (var t = 0; t < (tries || 1) && !server; t++) {
      try { server = await dev.gatt.connect(); } catch (e) { err = e; await sleep(600 * (t + 1)); }
    }
    if (!server) throw err || new Error('tidak tersambung');
    var services = await server.getPrimaryServices();
    ch = null;
    for (var s = 0; s < services.length && !ch; s++) {
      var chars = await services[s].getCharacteristics();
      for (var c = 0; c < chars.length; c++) {
        if (chars[c].properties.writeWithoutResponse || chars[c].properties.write) { ch = chars[c]; break; }
      }
    }
    if (!ch) throw new Error('printer tersambung tapi tidak ada jalur tulis Bluetooth (BLE) yang dikenal');
    store.set('dp.device', dev.id); prefs.device = dev.id;
    ready();
    say('Siap · ' + (dev.name || printer.model), 'is-on');
  }
  async function choose() {
    say('Pilih printer di daftar…', 'is-busy');
    var dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    wire(dev);
    prefs.chunk = 0; store.set('dp.chunk', 0);
    await attach(dev, 1);
  }
  // Without a tap: Chrome hands back devices this page was allowed before.
  async function resume() {
    if (!prefs.device || !navigator.bluetooth.getDevices) { say('Ketuk Sambungkan untuk memilih printer.', ''); ready(); return; }
    try {
      var known = (await navigator.bluetooth.getDevices()).filter(function (d) { return d.id === prefs.device; })[0];
      if (!known) { say('Ketuk Sambungkan untuk memilih printer.', ''); ready(); return; }
      say('Menyambung ke ' + (known.name || printer.model) + '…', 'is-busy');
      wire(known);
      try { await attach(known, 2); return; } catch (e) {}
      // Not reachable yet: wait for it to advertise, then connect.
      if (known.watchAdvertisements) {
        var done = false;
        known.addEventListener('advertisementreceived', function () {
          if (done) return; done = true;
          attach(known, 2).catch(function () { say('Printer tidak merespons. Ketuk Sambungkan.', 'is-off'); ready(); });
        });
        await known.watchAdvertisements();
        say('Menunggu printer menyala…', 'is-busy');
      } else { say('Printer tidak terjangkau. Ketuk Sambungkan.', 'is-off'); }
    } catch (e) { say('Ketuk Sambungkan untuk memilih printer.', ''); }
    ready();
  }
  connectBtn.addEventListener('click', function () {
    if (device && device.gatt.connected) device.gatt.disconnect();
    choose().catch(function (e) { ch = null; ready(); say(e.name === 'NotFoundError' ? 'Batal memilih printer.' : 'Gagal menyambung: ' + e.message, 'is-off'); });
  });

  /* ---- transfer: the biggest packet the link takes, found once, no idle waits ---- */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var SIZES = [244, 180, 120, 60, 20];
  async function writeChunk(part) {
    if (ch.properties.writeWithoutResponse) await ch.writeValueWithoutResponse(part);
    else await ch.writeValue(part);
  }
  async function probeChunk() {
    if (prefs.chunk) return prefs.chunk;
    for (var i = 0; i < SIZES.length; i++) {
      try { await writeChunk(ascii('\\r\\n'.padEnd(SIZES[i], ' '))); prefs.chunk = SIZES[i]; break; } catch (e) {}
    }
    prefs.chunk = prefs.chunk || 20; store.set('dp.chunk', prefs.chunk); showMeta();
    return prefs.chunk;
  }
  async function send(bytes, onProgress) {
    var size = await probeChunk();
    var quick = !!ch.properties.writeWithoutResponse;
    for (var at = 0; at < bytes.length; at += size) {
      try { await writeChunk(bytes.subarray(at, at + size)); }
      catch (e) {
        // A packet the link refused mid-job: drop a size and go on from the same place.
        var smaller = SIZES.filter(function (s) { return s < size; })[0];
        if (!smaller) throw e;
        size = smaller; prefs.chunk = size; store.set('dp.chunk', size); showMeta();
        await sleep(50); at -= size; continue;
      }
      // Write-without-response has no back-pressure; a breath every few packets keeps a
      // small printer buffer from overflowing without idling the link.
      if (quick && ((at / size) & 3) === 3) await sleep(2);
      if (onProgress) onProgress(Math.min(1, (at + size) / bytes.length));
    }
  }

  /* ---- image to job ---- */
  function blankCanvas() {
    var c = document.createElement('canvas');
    c.width = printer.widthMm * printer.dotsPerMm; c.height = printer.heightMm * printer.dotsPerMm;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function job(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var tspl = prefs.proto === 'tspl';
    // TSPL prints where the bit is 0, ESC/POS where it is 1; the switch flips either.
    var blackBit = (tspl ? 0 : 1) ^ (prefs.invert ? 1 : 0);
    var mono = packMono(px, canvas.width, canvas.height, { black: blackBit });
    return tspl
      ? tsplJob(mono, { widthMm: printer.widthMm, heightMm: printer.heightMm, gapMm: printer.gapMm, rotate: prefs.rotate, blank: blackBit ? 0x00 : 0xff })
      : escposJob(mono);
  }
  function progress(frac) { bar.hidden = false; fill.style.width = Math.round(frac * 100) + '%'; }
  function progressOff() { bar.hidden = true; fill.style.width = '0'; }

  /* ---- pdf.js, fetched while the page is still being read ---- */
  var pdfjsReady = new Promise(function (resolve, reject) {
    var tag = document.createElement('script');
    tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    tag.onload = function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    tag.onerror = function () { reject(new Error('pembaca PDF gagal dimuat')); };
    document.head.appendChild(tag);
  });

  async function renderPages(base64) {
    var lib = await pdfjsReady;
    var raw = atob(base64), data = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    var doc = await lib.getDocument({ data: data }).promise;
    var canvases = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var base = page.getViewport({ scale: 1 });
      var canvas = blankCanvas();
      var at = placePage(base.width, base.height, { width: canvas.width, height: canvas.height, fit: prefs.fit });
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.save(); ctx.translate(at.x, at.y);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: at.scale }) }).promise;
      ctx.restore();
      canvases.push(canvas);
    }
    return canvases;
  }

  /* ---- the one button ---- */
  goBtn.addEventListener('click', async function () {
    if (!form || busy) return;
    var body = new URLSearchParams(new FormData(form));
    body.set('format', 'json');
    var n = body.getAll('order').length;
    if (!n) { say('Centang pesanan dulu.', 'is-on'); return; }
    busy = true; ready();
    try {
      say('Menyiapkan ' + n + ' label…', 'is-busy'); progress(0);
      var res = await fetch('/api/labels', { method: 'POST', body: body, credentials: 'same-origin' });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
      // Every stack is rasterised first so the printer gets one steady stream.
      var canvases = [];
      for (var g = 0; g < out.groups.length; g++) canvases = canvases.concat(await renderPages(out.groups[g].pdfBase64));
      var jobs = canvases.map(job);
      var total = jobs.reduce(function (s, j) { return s + j.length; }, 0), sent = 0;
      for (var j = 0; j < jobs.length; j++) {
        say('Mengirim ' + (j + 1) + '/' + jobs.length + '…', 'is-busy');
        var before = sent;
        await send(jobs[j], function (f) { progress((before + f * jobs[j].length) / total); });
        sent += jobs[j].length;
      }
      var failed = (out.failures || []).length;
      say(jobs.length + ' label terkirim' + (failed ? ' · ' + failed + ' gagal: ' + out.failures.map(function (f) { return f.id; }).join(', ') : ''), failed ? 'is-busy' : 'is-on');
      // The print is on record server-side; take the printed rows off the list here
      // rather than reloading, which would drop the Bluetooth link.
      body.getAll('order').forEach(function (v) {
        var id = v.slice(v.indexOf(':') + 1).toLowerCase();
        var row = form.querySelector('tr[data-id="' + id.replace(/"/g, '') + '"]');
        if (!row) return;
        var pick = row.querySelector('.pick');
        if (pick) { pick.checked = false; pick.disabled = true; }
        var note = row.querySelector('td:last-child');
        if (note && !out.failures.some(function (f) { return String(f.id).toLowerCase() === id; })) note.innerHTML = '<span class="ok">dicetak langsung</span>';
      });
      form.dispatchEvent(new Event('change'));
    } catch (e) {
      say('Gagal: ' + e.message, 'is-off');
    } finally { busy = false; progressOff(); ready(); }
  });

  /* ---- test page and calibration ---- */
  function framed() {
    var c = blankCanvas(), ctx = c.getContext('2d', { willReadFrequently: true });
    var w = Math.round(c.width * prefs.fit), h = Math.round(c.height * prefs.fit);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.strokeRect(16, 16, w - 32, h - 32);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center';
    ctx.font = 'bold ' + Math.round(56 * prefs.fit) + 'px sans-serif';
    ctx.fillText('TES ' + printer.model, w / 2, h / 2 - 30 * prefs.fit);
    ctx.font = Math.round(34 * prefs.fit) + 'px sans-serif';
    ctx.fillText('bingkai harus pas di tepi kertas', w / 2, h / 2 + 40 * prefs.fit);
    return c;
  }
  function ruler() {
    var c = blankCanvas(), ctx = c.getContext('2d', { willReadFrequently: true });
    var d = printer.dotsPerMm;
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.font = 'bold 44px sans-serif';
    for (var mm = 5; mm <= printer.widthMm; mm += 5) {
      var x = mm * d, tall = mm % 10 === 0;
      ctx.fillRect(x - 2, 0, 4, tall ? 70 : 40);
      ctx.fillRect(x - 2, c.height - (tall ? 70 : 40), 4, tall ? 70 : 40);
      if (tall) { ctx.fillText(String(mm), x, 120); ctx.fillText(String(mm), x, c.height - 85); }
    }
    ctx.font = '30px sans-serif';
    ctx.fillText('angka terakhir yang terbaca di kanan = lebar cetak', c.width / 2, c.height / 2);
    return c;
  }
  async function oneOff(label, canvas, after) {
    if (busy) return; busy = true; ready();
    try { say(label, 'is-busy'); await send(job(canvas), progress); say(after, 'is-on'); }
    catch (e) { say('Gagal: ' + e.message, 'is-off'); }
    finally { busy = false; progressOff(); ready(); }
  }
  testBtn.addEventListener('click', function () {
    oneOff('Mengirim halaman tes…', framed(), 'Halaman tes terkirim. Bingkai pas di tepi = ukuran benar.');
  });
  calBtn.addEventListener('click', function () {
    calRow.hidden = false;
    oneOff('Mengirim penggaris…', ruler(), 'Lihat kertasnya, lalu ketuk angka terakhir yang terbaca.');
  });
  calRow.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fit]'); if (!b) return;
    prefs.fit = Number(b.getAttribute('data-fit')) / printer.widthMm;
    store.set('dp.fit', prefs.fit); showMeta(); calRow.hidden = true;
    oneOff('Skala ' + Math.round(prefs.fit * 100) + '% disimpan · mencetak halaman tes…', framed(), 'Skala disimpan. Bingkai harus pas di tepi kertas sekarang.');
  });

  ready();
  resume();
})();
`;
}
