#!/usr/bin/env bash
# Dijalankan oleh treelogy-deploy.service saat berkas pemicu berubah.
#
# Urutannya dipilih supaya push yang rusak tidak pernah menjatuhkan produksi: tarik kode,
# pasang dependensi, JALANKAN TEST, baru restart. Kalau test gagal, kode dikembalikan ke
# commit sebelumnya dan layanan tidak pernah disentuh - yang sedang berjalan tetap berjalan.
set -euo pipefail

APP=/opt/treelogy/app
TRIGGER=/opt/treelogy/state/deploy-requested
LOG=/opt/treelogy/state/deploy.log

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

cd "$APP"
BEFORE=$(git rev-parse HEAD)
WANTED=$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sha||"")}catch{}' "$TRIGGER" 2>/dev/null || true)
log "deploy diminta: ${WANTED:0:8} (sekarang ${BEFORE:0:8})"

git fetch --quiet origin main
git reset --hard --quiet origin/main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  log "tidak ada perubahan (${AFTER:0:8}); tidak restart"
  exit 0
fi
log "kode: ${BEFORE:0:8} -> ${AFTER:0:8}"

# Dependensi produksi saja; test hanya memakai node:test, tidak butuh devDependencies.
npm ci --omit=dev --no-audit --no-fund --silent

if ! npm test >>"$LOG" 2>&1; then
  log "TEST GAGAL - dikembalikan ke ${BEFORE:0:8}, layanan tidak disentuh"
  git reset --hard --quiet "$BEFORE"
  npm ci --omit=dev --no-audit --no-fund --silent
  node bin/notify.mjs "<b>🛑 Deploy ditolak</b>%0ATest gagal pada <code>${AFTER:0:8}</code>. Kode dikembalikan ke <code>${BEFORE:0:8}</code>; produksi tetap berjalan versi lama." 2>/dev/null || true
  exit 1
fi

sudo -n /bin/systemctl restart treelogy.service
sleep 2
if ! curl -fsS --max-time 20 http://127.0.0.1:3000/api/status >/dev/null; then
  log "LAYANAN TIDAK SEHAT setelah restart - dikembalikan ke ${BEFORE:0:8}"
  git reset --hard --quiet "$BEFORE"
  npm ci --omit=dev --no-audit --no-fund --silent
  sudo -n /bin/systemctl restart treelogy.service
  node bin/notify.mjs "<b>🛑 Deploy dikembalikan</b>%0A<code>${AFTER:0:8}</code> lolos test tapi layanan tidak sehat setelah restart. Kembali ke <code>${BEFORE:0:8}</code>." 2>/dev/null || true
  exit 1
fi

log "deploy selesai: ${AFTER:0:8} sehat"
node bin/notify.mjs "<b>✅ Deploy</b> <code>${AFTER:0:8}</code> aktif$(git log -1 --pretty=%s | sed 's/[<>&]//g' | cut -c1-120 | sed 's/^/%0A/')" 2>/dev/null || true
