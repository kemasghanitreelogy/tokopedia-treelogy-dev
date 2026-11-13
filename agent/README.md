# Agen printer meja packing

Program kecil di laptop Windows yang tersambung USB ke printer label. Ia mengambil
antrian label dari server dan mengirimnya ke printer, sehingga semua HP dan laptop
mencetak lewat satu tombol **Cetak langsung** tanpa Bluetooth, dan cetakan dari
beberapa orang masuk antrian berurutan.

## Pasang (sekali)

1. Pastikan printer label (OKAY D100) sudah terpasang di Windows dan bisa cetak tes.
2. Salin folder `agent/` ini ke laptop (atau unduh dua berkas `.ps1`-nya).
3. Buka PowerShell di folder itu, jalankan:

       powershell -ExecutionPolicy Bypass -File .\install-print-agent.ps1

4. Isi: alamat server (biarkan bawaan), token agen (minta ke Kemas), pilih printer.
5. Selesai. Agen jalan tersembunyi dan otomatis menyala tiap laptop login.

Dalam satu menit, menu **Label** di dashboard menampilkan panel **Printer gudang · siap**.

## Cara kerja

- Agen bertanya ke server setiap ~20 detik ("ada label?"); server menahan jawaban
  sampai ada pekerjaan, jadi label keluar dalam ~1 detik setelah tombol ditekan.
- Label dirender di server ke bahasa printer (TSPL). Agen hanya meneruskan byte.
- Kalau internet putus, antrian menunggu di server dan dicetak saat tersambung lagi.
- Kalau agen mati di tengah pekerjaan, pekerjaan dikembalikan ke antrian setelah
  3 menit (bisa tercetak dua kali, tidak pernah hilang).

## Memeriksa

- Log: `%LOCALAPPDATA%\Treelogy\print-agent.log`
- Status tugas: Task Scheduler → "Treelogy Print Agent"
- Ganti printer/token: jalankan ulang pemasang.
