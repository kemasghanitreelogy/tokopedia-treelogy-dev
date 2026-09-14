#!/usr/bin/env bash
# Sekali jalan di VPS sebagai root (sudo). Idempoten: aman diulang.
set -euo pipefail

REPO="https://github.com/kemasghanitreelogy/tokopedia-treelogy-dev.git"
APP=/opt/treelogy/app
STATE=/opt/treelogy/state

echo "== paket"
apt-get update -qq
apt-get install -y -qq curl git nginx redis-server ufw ca-certificates >/dev/null

# Node 22+ dibutuhkan (node:sqlite dipakai test, plus API modern di kode).
# Coba repo Ubuntu dulu - 26.04 sudah membawa Node LTS - baru NodeSource kalau kurang.
node_major() { command -v node >/dev/null && node -v | sed 's/^v//' | cut -d. -f1 || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
fi
if [ "$(node_major)" -lt 22 ]; then
  echo "   node dari repo Ubuntu kurang ($(node_major)); mencoba NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs >/dev/null 2>&1 || true
fi
if [ "$(node_major)" -lt 22 ]; then
  echo "!! Node 22+ tidak bisa dipasang otomatis di distro ini (dapat: $(node -v 2>/dev/null || echo tidak ada))."
  echo "   Pasang manual, lalu jalankan skrip ini lagi:"
  echo "     curl -fsSL https://fnm.vercel.app/install | bash   # atau snap install node --classic --channel=24"
  exit 1
fi
echo "node $(node -v) · npm $(npm -v)"

echo "== pengguna & direktori"
id -u treelogy >/dev/null 2>&1 || useradd --system --home /opt/treelogy --shell /usr/sbin/nologin treelogy
mkdir -p "$APP" "$STATE" /opt/treelogy/backup /etc/treelogy
chown -R treelogy:treelogy /opt/treelogy

echo "== kode"
# root dan treelogy sama-sama menyentuh repo ini; tanpa ini git menolak dengan
# "detected dubious ownership" dan deploy berhenti di tengah.
git config --system --add safe.directory "$APP" 2>/dev/null || true
if [ -d "$APP/.git" ]; then
  sudo -u treelogy git -C "$APP" fetch -q origin main && sudo -u treelogy git -C "$APP" reset -q --hard origin/main
else
  sudo -u treelogy git clone -q "$REPO" "$APP"
fi
echo "commit $(sudo -u treelogy git -C "$APP" rev-parse --short HEAD)"
sudo -u treelogy bash -c "cd $APP && npm ci --omit=dev --no-audit --no-fund --silent"

echo "== env"
# A file dropped at /tmp/treelogy.env (scp'd from the workstation) is installed and removed.
if [ -f /tmp/treelogy.env ]; then
  install -o root -g treelogy -m 640 /tmp/treelogy.env /etc/treelogy/env && rm -f /tmp/treelogy.env
  echo "env dipasang dari /tmp/treelogy.env"
fi
if [ ! -f /etc/treelogy/env ]; then
  cp "$APP/deploy/env.example" /etc/treelogy/env
  echo "!! Isi /etc/treelogy/env dulu (nilai dari Vercel & .env lokal), lalu jalankan skrip ini lagi."
fi
chown root:treelogy /etc/treelogy/env && chmod 640 /etc/treelogy/env

# Rahasia webhook deploy: dibuat sekali, lalu dicetak supaya bisa dipasang di GitHub.
if ! grep -q '^DEPLOY_SECRET=.\+' /etc/treelogy/env 2>/dev/null; then
  SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  sed -i "s|^DEPLOY_SECRET=.*|DEPLOY_SECRET=${SECRET}|" /etc/treelogy/env || echo "DEPLOY_SECRET=${SECRET}" >> /etc/treelogy/env
fi
echo "DEPLOY_SECRET (pasang di webhook GitHub): $(grep '^DEPLOY_SECRET=' /etc/treelogy/env | cut -d= -f2)"

echo "== redis: persistensi AOF (default Ubuntu hanya snapshot RDB berkala)"
redis-cli CONFIG SET appendonly yes >/dev/null
redis-cli CONFIG SET appendfsync everysec >/dev/null
redis-cli CONFIG SET maxmemory-policy noeviction >/dev/null   # state bukan cache: jangan pernah dibuang
# Tanpa batas, Redis tumbuh sampai kernel membunuh sesuatu - bisa saja proses lain. Dengan
# batas + noeviction, penulisan gagal dengan pesan jelas dan mesinnya tetap hidup. 512 MB
# kira-kira 75x pemakaian sekarang, jadi ini pagar, bukan kendala.
redis-cli CONFIG SET maxmemory 536870912 >/dev/null
redis-cli CONFIG REWRITE >/dev/null
systemctl enable --now redis-server >/dev/null
echo "redis $(redis-cli --version | cut -d' ' -f2) · appendonly=$(redis-cli CONFIG GET appendonly | tail -1) · bind=$(redis-cli CONFIG GET bind | tail -1)"

echo "== rotasi log"
cat > /etc/logrotate.d/treelogy <<'ROTATE'
/opt/treelogy/state/*.log {
    weekly
    rotate 8
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su treelogy treelogy
}
ROTATE
logrotate -d /etc/logrotate.d/treelogy >/dev/null 2>&1 && echo "logrotate: ok" || echo "!! logrotate: konfigurasi ditolak"

echo "== systemd"
cp "$APP/deploy/treelogy.service" "$APP/deploy/treelogy-sweep.service" "$APP/deploy/treelogy-sweep.timer" \
   "$APP/deploy/treelogy-daily.service" "$APP/deploy/treelogy-daily.timer" \
   "$APP/deploy/treelogy-deploy.service" "$APP/deploy/treelogy-deploy.path" /etc/systemd/system/
install -m 440 -o root -g root "$APP/deploy/treelogy-deploy.sudoers" /etc/sudoers.d/treelogy-deploy
visudo -c -q || { echo "sudoers tidak valid, dibatalkan"; rm -f /etc/sudoers.d/treelogy-deploy; exit 1; }
systemctl daemon-reload
systemctl enable --now treelogy.service treelogy-sweep.timer treelogy-daily.timer treelogy-deploy.path
systemctl restart treelogy.service

echo "== nginx"
SITE=/etc/nginx/sites-available/api.treelogy-services.my.id
# Simpan config yang sedang berjalan, dan kembalikan kalau yang baru tidak lolos uji -
# lebih baik tetap dengan yang lama daripada meninggalkan nginx mati.
[ -f "$SITE" ] && cp "$SITE" "$SITE.bak.$(date +%s)"
cp "$APP/deploy/nginx-api.conf" "$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/api.treelogy-services.my.id
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "nginx: config baru dipasang"
else
  LAST_BAK=$(ls -1t "$SITE".bak.* 2>/dev/null | head -1)
  if [ -n "$LAST_BAK" ]; then
    cp "$LAST_BAK" "$SITE"
    nginx -t && systemctl reload nginx
    echo "!! config nginx baru TIDAK lolos uji - dikembalikan ke yang lama"
    nginx -t
  else
    echo "!! config nginx baru tidak lolos uji dan tidak ada cadangan"; nginx -t
  fi
fi

echo "== firewall"
# Order and verification matter more than brevity here. Enabling a default-deny firewall
# before its allow rules exist locks everyone out of the machine, including whoever is
# running this script - which is exactly what happened once, because the allow commands
# were silenced with >/dev/null and their failure went unseen. Rules first, printed, then
# verified in the rule table, and only then is the firewall switched on.
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http'
ufw allow 443/tcp comment 'https'

missing=""
for port in 22 80 443; do
  ufw status | grep -qE "^${port}/tcp" || missing="$missing $port"
done
if [ -n "$missing" ]; then
  echo "!! aturan ufw untuk port$missing tidak terpasang - firewall TIDAK dinyalakan"
  echo "   (menyalakannya sekarang akan mengunci mesin ini)"
  ufw status
else
  ufw --force enable
  echo "firewall aktif dengan: $(ufw status | grep -cE '^(22|80|443)/tcp') aturan port"
  ufw status numbered | grep -E '^\[|22|80|443' | head -8
fi

echo "== cek"
sleep 3
echo "-- lokal :3000"
curl -fsS --max-time 20 http://127.0.0.1:3000/api/status | head -c 400 || echo "(belum menjawab - lihat: journalctl -u treelogy -n 40)"
echo
echo "-- lewat nginx :443"
curl -fsS --max-time 20 https://api.treelogy-services.my.id/api/status -o /dev/null -w "   https -> %{http_code}\n" || echo "   https -> gagal"
echo "-- layanan & timer"
systemctl is-active treelogy.service redis-server nginx | paste -sd' ' -
systemctl list-timers --no-pager 'treelogy-*' | head -4
echo
echo "SELESAI. Webhook deploy sudah terdaftar di GitHub; push ke main akan ter-deploy sendiri."
