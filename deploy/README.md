# Deploy ke VPS

## Sekali saja

```bash
# dari Mac
scp treelogy.env kemasghani@203.145.35.26:/tmp/treelogy.env

# di VPS
curl -fsSL https://raw.githubusercontent.com/kemasghanitreelogy/tokopedia-treelogy-dev/main/deploy/vps-setup.sh | sudo bash
```

Skrip mencetak `DEPLOY_SECRET` di akhir. Pasang di GitHub:
**Settings → Webhooks → Add webhook**
- Payload URL: `https://api.treelogy-services.my.id/api/deploy`
- Content type: `application/json`
- Secret: nilai `DEPLOY_SECRET` tadi
- Events: **Just the push event**

## Sesudah itu

`git push origin main` → GitHub memanggil `/api/deploy` → berkas pemicu ditulis →
`treelogy-deploy.path` menjalankan `deploy.sh`:

1. `git reset --hard origin/main`
2. `npm ci --omit=dev`
3. **`npm test`** — gagal berarti kode dikembalikan ke commit sebelumnya dan layanan
   **tidak disentuh**; yang berjalan tetap berjalan
4. `systemctl restart treelogy` lalu cek `/api/status`; tidak sehat berarti dikembalikan
5. Hasilnya dikirim ke Telegram

Arahnya sengaja: GitHub hanya memegang rahasia yang kekuatannya "minta server menarik
kodenya sendiri". Alternatif yang umum - GitHub Action yang SSH masuk - menaruh kunci
shell produksi di dalam GitHub.

Satu-satunya hak root milik pengguna `treelogy` ada di `/etc/sudoers.d/treelogy-deploy`:
me-restart layanannya sendiri, bukan yang lain.

## Perintah harian

```bash
systemctl status treelogy            # layanan web
systemctl list-timers 'treelogy-*'   # sapuan 15 menit, tugas harian 02.30 WIB
journalctl -u treelogy -f            # log langsung
tail -f /opt/treelogy/state/deploy.log
sudo systemctl start treelogy-deploy # deploy manual sekarang juga
```
