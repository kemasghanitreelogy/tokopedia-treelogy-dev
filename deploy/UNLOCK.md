# Terkunci dari VPS

Kalau port 22/80/443 tertutup dan ping tetap jalan, hampir pasti firewall menyala tanpa
aturan izin. Satu-satunya jalan masuk adalah **Terminal web IdCloudHost**
(panel → VPS → tombol Terminal). Di sana:

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw reload
sudo ufw status numbered
```

Atau matikan saja dulu: `sudo ufw disable`

## Kenapa ini pernah terjadi

`vps-setup.sh` menjalankan `ufw allow OpenSSH >/dev/null` lalu `ufw --force enable`.
Perintah `allow` gagal (nama profil berbeda di Ubuntu 26.04) tapi errornya ditelan oleh
`>/dev/null`, jadi firewall menyala dengan kebijakan *deny semua*.

Skrip sekarang memasang aturan per-nomor-port, **mencetak** hasilnya, memeriksa ketiganya
benar-benar ada di tabel aturan, dan hanya menyalakan firewall kalau ketiganya terpasang.
Kalau tidak, firewall dibiarkan mati dan alasannya dicetak.
