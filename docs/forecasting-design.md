# Desain: Peramalan Stok per SKU

Status: disetujui untuk implementasi · 2026-09-14

## 1. Tujuan dan batas kejujuran

Menjawab tiga pertanyaan per SKU komponen, setiap hari, dari data penjualan semua kanal:

1. Berapa unit yang akan terjual dalam 7 / 14 / 30 hari ke depan — **dengan rentang**, bukan satu angka.
2. Berapa hari stok yang ada akan bertahan (*days of cover*).
3. Kapan dan berapa harus produksi/beli agar peluang kehabisan ≤ target (*reorder point*, *safety stock*).

Tidak ada peramalan permintaan retail per-SKU yang "mendekati 100%". Yang diklaim di sini
hanya yang **diukur**: setiap model diuji dengan *rolling-origin backtest* lawan data yang
disembunyikan, dan angka akurasinya (MASE, bias, cakupan interval) ditampilkan di samping
ramalannya. Ramalan tanpa angka akurasi tidak boleh tampil.

## 2. Sumber data

| Kanal | Cara tarik | Kedalaman terukur | Volume |
|---|---|---|---|
| Shopify | Admin GraphQL `orders`, `read_all_orders` | sejak 2025-02-26 | 9.850 order |
| Tokopedia + TikTok Shop | `orders/search` + detail batch 50 | sejak 2025-05-15 | 12.804 order |
| Shopee | `get_order_list` jendela 15 hari + detail batch 50 | diukur saat ingest | — |

Hanya order **berbayar dan tidak batal/retur** (stage `to_ship…completed`) yang dihitung
sebagai permintaan. Order batal dikeluarkan — bukan dinolkan — karena permintaannya nyata
tapi tidak jadi penjualan; ini keputusan yang dicatat, bukan default diam-diam.

## 3. Model data

```
history/<channel>/<YYYY-MM>.json     satu berkas per kanal per bulan, ditulis ulang utuh
  { channel, month, pulled_at, complete: bool, orders: [
      { id, at (epoch), stage, status, buyer_hash,
        lines: [{ sku: <SKU master>, raw_sku, qty, unit_price }] } ] }
history/manifest.json                { channels: { <channel>: { months: { <YYYY-MM>: { orders, complete, pulled_at } } } } }
forecast/latest.json                 hasil run terakhir (lihat §6), dibaca dashboard
```

Bulan berjalan ditandai `complete: false` dan ditarik ulang setiap run; bulan lampau yang
`complete: true` tidak pernah ditarik lagi. Ingest bisa diputus kapan saja dan dilanjutkan.

**Ledakan bundle.** Permintaan dihitung di tingkat **komponen**: `MRS-002` = `MRS-001` +
`OMP-45-001`, jadi satu penjualan MRS-002 menambah permintaan kedua komponennya. Stok yang
diramal adalah stok komponen, karena itulah yang diproduksi.

## 4. Deret waktu

Per SKU komponen: permintaan **harian** (WIB) → dipakai untuk ROP; **mingguan** → dipakai
untuk memilih model dan menampilkan tren. Hari tanpa penjualan = 0, bukan hilang.

## 5. Model dan pemilihan

Semua tanpa dependensi native, semua deterministik:

| Model | Untuk apa |
|---|---|
| Seasonal naive (musim mingguan) | pembanding wajib; sebuah model harus mengalahkannya |
| Simple/Holt exponential smoothing | tren halus |
| Holt-Winters aditif, musim 7 hari | pola hari-dalam-minggu (marketplace sangat berpola) |
| Croston / TSB | SKU jarang terjual (banyak nol) — model biasa gagal di sini |
| Ensemble (median dari yang lolos) | stabil; di M5 ensemble model sederhana mengalahkan model rumit di tingkat SKU |

**Pemilihan per SKU** lewat rolling-origin backtest: ≥ 8 titik asal, horizon 7/14/30 hari,
metrik utama **MASE** (skala-bebas, aman untuk deret dengan nol), bias diawasi. Model yang
tidak mengalahkan seasonal naive dibuang. Interval prediksi dari **kuantil residual empiris**
per horizon — bukan asumsi normal — dan cakupannya (berapa persen aktual jatuh di dalam
interval 80%/95%) dilaporkan.

Peristiwa kalender (Ramadan/Lebaran, 11.11, 12.12, Harbolnas) ditandai dari data; kalau
ada ≥ 1 tahun riwayat, faktor peristiwa dihitung sebagai rasio terhadap baseline dan
diterapkan ke horizon yang memuat peristiwa berikutnya.

## 6. Kebijakan stok

Parameter per SKU (default global, bisa diubah): *lead time* hari, *service level* (default
95%), *review period*. Turunan:

- permintaan selama lead time = jumlah ramalan harian sepanjang L
- safety stock = kuantil (service level) dari distribusi empiris permintaan-L − mediannya
- ROP = median permintaan-L + safety stock
- days of cover = hari sampai stok kumulatif ramalan median melewati stok sekarang
- rekomendasi = `max(0, ROP + permintaan periode review − stok − yang sedang dipesan)`

Keluaran per SKU: `{ forecast: {7,14,30: {p10,p50,p90}}, accuracy: {model, mase, bias,
coverage80, coverage95, naive_mase}, stock: {on_hand, days_of_cover, rop, safety, reorder_qty,
stockout_date_p50, stockout_date_p10} }`.

## 7. Komputasi dan batas platform

Ingest dan peramalan **tidak** dijalankan di fungsi Vercel (batas 120 dtk, kuota API):
keduanya perintah CLI (`npm run history:pull`, `npm run forecast`) dan job GitHub Actions
harian yang menulis `forecast/latest.json`. Dashboard hanya membaca. Ini juga membuat
pindah ke VPS trivial: job yang sama jadi *systemd timer*.

## 8. Antarmuka

- Tab **Prakiraan**: tabel per SKU — stok, hari tersisa (warna oleh risiko), ramalan 30 hari
  dengan rentang, akurasi model, rekomendasi. Baris bisa dibuka: grafik 12 minggu aktual vs
  ramalan (SVG inline, tanpa library).
- Peringatan Telegram harian: SKU yang `days_of_cover < lead time` (akan habis sebelum
  pesanan tiba).

## 9. Validasi sebelum dianggap selesai

- Backtest dilaporkan untuk setiap SKU; SKU dengan riwayat < 8 minggu ditandai "belum cukup data".
- Cakupan interval 80% harus 70–90% di backtest, kalau tidak intervalnya dikalibrasi ulang.
- Uji unit untuk setiap model lawan deret sintetis dengan jawaban yang diketahui.
