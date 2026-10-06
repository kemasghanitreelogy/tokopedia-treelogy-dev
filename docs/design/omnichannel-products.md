# Produk omnichannel — rancangan UX & alur data

Status: rancangan (sc:design), 6 Okt 2026. Pembanding: alur produk Jubelio/Ginee.

## 1. Prinsip

1. **Satu sumber kebenaran per jenis data.** Tidak ada angka yang disimpan dua kali.
2. **Satu layar per tugas, satu tombol simpan.** Operator tidak perlu tahu data mana disimpan di mana.
3. **Status kanal selalu terlihat**, dengan satu aksi yang masuk akal di tempat itu.
4. **Kirim hanya yang berubah**, hanya ke kanal yang dicentang.
5. **Tidak ada peringatan stok.** Angka stok adalah angka tampilan, bukan isi gudang.
6. **Hasil per kanal selalu dilaporkan.** Kalau sebagian gagal, yang berhasil tetap tersimpan dan yang gagal disebut dengan alasannya.

## 2. Model data — siapa pemilik apa

| Data | Pemilik (sumber kebenaran) | Disimpan di | Ditulis oleh |
|---|---|---|---|
| Identitas produk: SKU, nama, varian, kategori, keluarga, alias, isi bundle, hadiah | **Dashboard** | `src/master.js` (dasar) + `catalog/master.json` (lapisan) | Edit produk, Tambah produk, Hapus dari daftar |
| Stok | **Dashboard** (stok induk) | `inventory/ledger.json` (`skus`, `applied`) | Edit produk, tab Stok, pesanan (webhook/sweep), top-up +100 |
| Konten listing: judul, deskripsi, foto, berat, dimensi | **Kanal** | Tokopedia/TikTok, Shopee, Shopify | Edit produk (dikirim), Tambah/Publikasikan (dibuat) |
| Harga | **Kanal** | Masing-masing kanal | Edit produk, aksi massal |
| Status tayang | **Kanal** | Masing-masing kanal | Nonaktifkan / Aktifkan |
| Kategori, atribut, brand, logistik, sertifikat | **Kanal** | Disalin dari listing contoh | Tambah / Publikasikan |
| Thumbnail dashboard | Shopify | `mekari/images.json` (manifest) | Job harian + segarkan manual |
| Jejak perubahan | Dashboard | `audit/{tanggal}` | Setiap aksi tulis |

Konsekuensi: dashboard **tidak** menyimpan salinan judul atau harga. Saat halaman dibuka, konten dibaca dari kanal sumber (kanal pertama yang tayang, cache 60 detik), jadi tidak pernah basi.

## 3. Alur data

```
                    ┌────────────── Edit produk: satu form, satu simpan ──────────────┐
                    │                                                                  │
 before (JSON) ─────┤  diff per bagian: hanya yang berubah                             │
                    ▼                                                                  │
   ┌──────────────┬──────────────────┬───────────────────┬────────────────────────┐   │
   │ Informasi    │ Stok induk       │ Harga             │ Konten listing         │   │
   │ (master)     │                  │                   │ (judul/desk/foto/berat │   │
   │              │                  │                   │  /dimensi)             │   │
   └──────┬───────┴────────┬─────────┴─────────┬─────────┴───────────┬────────────┘   │
          ▼                ▼                   ▼                     ▼                │
 catalog/master.json   ledger.json        kanal tercentang      kanal tercentang      │
 (updateDoc)           (updateDoc)        applyPrice            partial_edit /        │
          │                │                                    update_item /         │
          │                ▼                                    productUpdate         │
          │        stock follower ──► semua listing semua kanal = stok induk          │
          ▼                                                                            │
   applyMasterOverlay ──► semua modul (daftar, form manual, ekspor, forecast, Jurnal)  │
                                                                                       │
 Ringkasan hasil per bagian & per kanal ◄────────────────────────────────────────────┘

 Pesanan (webhook / input manual / sweep 7 hari) ──► ledger.applied (sekali per pesanan)
   ──► stok induk −qty ──► follower menulis ke semua kanal       batal/retur ──► +qty sekali
```

Konkurensi: semua penulisan ke `ledger.json` dan `catalog/master.json` memakai `updateDoc` (WATCH/MULTI). Tidak ada lagi penulisan ulang seluruh dokumen dari salinan lama.

## 4. Alur UX

### 4.1 Daftar produk (layar utama)
- **Bar atas:** cari · filter status kanal (Semua · Tayang di semua · Belum di Shopee · Belum di Tokopedia/TikTok · Belum di Shopify · Nonaktif) · tampilan Grid/Tabel · **+ Tambah produk**.
- **Kartu / baris:** foto, nama + varian, SKU, stok per kanal, harga, **titik status per kanal** (● tayang, ○ nonaktif, + belum ada). Kelompok per kategori → keluarga, seperti sekarang.
- **Pilih massal:** kotak centang di setiap kartu, plus "pilih semua di kelompok". Saat ada yang dipilih, muncul **bar aksi** di bawah:
  - **Ubah harga…** (harga + kanal)
  - **Set stok induk…**
  - **Nonaktifkan di…** / **Aktifkan di…** (pilih kanal)
  - **Publikasikan ke…** (kanal; listing contoh dipilih otomatis per kategori)
  - **Hapus dari daftar**
- Setiap aksi massal memakai konfirmasi berisi angka yang akan ditulis, lalu menampilkan ringkasan "N berhasil, M gagal (alasan)".

### 4.2 Halaman produk (editor tunggal)
```
‹ Produk                                        [Duplikat] [Hapus dari daftar]
┌ foto ┐  Nama · varian · SKU                    ┌ Isi bundle (bila bundle) ┐
│      │  ● Tokopedia+TikTok  ● Shopee  + Shopify │ foto · nama · ×qty · stok│
└──────┘                                          └──────────────────────────┘
[Kartu kanal: status · stok · harga · judul · aksi Nonaktifkan / Aktifkan / Publikasikan]
┌ 1 Informasi produk ─ nama, varian, kategori, keluarga, alias, isi bundle, hadiah ┐
┌ 2 Konten listing  ─ judul, deskripsi, foto (galeri + ganti)                      ┐
┌ 3 Harga, stok & pengiriman ─ harga, stok induk, berat, dimensi                   ┐
[bar menempel:  Kirim ke ☑Tokopedia+TikTok ☑Shopee ☑Shopify · "3 perubahan" · Simpan & sinkronkan]
```
- Penghitung perubahan aktif saat mengetik. Tombol simpan nonaktif selama belum ada perubahan.
- Yang tidak berlaku disembunyikan: bagian Konten dan Harga tidak muncul kalau produk belum tayang di mana pun.

### 4.3 Tambah produk (3 langkah, satu halaman)
Produk → Listing → Kanal + mode (Tayang / Draft). Listing contoh dipilih otomatis berdasarkan kategori. Stok awal menjadi stok induk.

### 4.4 Duplikat
Dari halaman produk, **Duplikat** membuka Tambah produk yang **sudah terisi**: kategori, keluarga, judul, deskripsi, berat, dimensi, dan listing contoh sama dengan produk asal. Hanya SKU dan varian yang dikosongkan. Kotak "Pakai foto produk asal" tercentang, jadi foto tidak perlu diunggah ulang.

### 4.5 Publikasikan ke kanal yang belum ada
Satu klik dari kartu kanal atau dari aksi massal. Konten, foto, berat, dan dimensi diambil dari listing yang sedang tayang, stok dari stok induk, harga dari harga yang berlaku.

## 5. Antarmuka aksi (POST dashboard)

| action | Input | Efek |
|---|---|---|
| `product_save` | sku, before, field master, qty, price, konten, foto, channel[] | Diff → master / ledger+follower / harga / konten, hanya yang berubah |
| `product_create` | field master + listing + foto atau `photos_from`, channel[], template_*, mode | Buat listing per kanal; master + stok induk ditulis kalau ≥1 kanal berhasil |
| `product_publish` | sku, channel, template, mode | Buat listing dari konten kanal sumber |
| `listing_active` | sku, channel, active | Deactivate/unlist/archive atau sebaliknya |
| `product_remove` | sku, removed | Sembunyikan / kembalikan di master |
| `bulk_price` | sku[], price, channel[] | `applyPrice` per SKU |
| `bulk_stock` | sku[], qty | Satu `updateDoc` ledger → follower |
| `bulk_active` | sku[], channel, active | `listing_active` per SKU |
| `bulk_publish` | sku[], channel, mode | `product_publish` per SKU, listing contoh dipilih per kategori |
| `bulk_remove` | sku[] | `setMasterRemoved` per SKU |

Semua aksi mencatat audit dan mengembalikan ringkasan per kanal. Aksi massal dibatasi 50 SKU per kiriman supaya kuota kanal aman.

## 6. Validasi rancangan
- **Satu pemilik per data:** dipenuhi (tabel §2).
- **Tidak ada penulisan ganda:** stok hanya lewat ledger → follower. Harga dan konten langsung ke kanal.
- **Aman untuk Jurnal:** SKU yang dihapus tetap dikenali. SKU tidak bisa diubah setelah dibuat, karena SKU menyambungkan pesanan, stok, dan faktur.
- **Sebagian gagal tidak membatalkan yang berhasil.** Semuanya dilaporkan.
- **Tetap dalam batas API:** pembatas per menit di klien yang sudah ada, dan aksi massal dijalankan berurutan.

## 7. QA
Unit: diff, validasi master, rencana follower, pemilihan contoh per kategori, aksi massal (mock).
Produksi: buat → duplikat → publikasikan → edit → massal (harga/stok/nonaktif/aktif) pada produk **QA draft**, lalu hapus. Render semua halaman (desktop + 390 px) tanpa error.
