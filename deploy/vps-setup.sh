#!/usr/bin/env bash
# Sekali jalan di VPS sebagai root (sudo). Idempoten: aman diulang.
set -euo pipefail

REPO="https://github.com/kemasghanitreelogy/tokopedia-treelogy-dev.git"
APP=/opt/treelogy/app
STATE=/opt/treelogy/state

echo "== paket"
apt-get update -qq
apt-get install -y -qq curl git nginx redis-server ufw >/dev/null
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

echo "== pengguna & direktori"
id -u treelogy >/dev/null 2>&1 || useradd --system --home /opt/treelogy --shell /usr/sbin/nologin treelogy
mkdir -p "$APP" "$STATE" /opt/treelogy/backup /etc/treelogy
chown -R treelogy:treelogy /opt/treelogy

echo "== kode"
if [ -d "$APP/.git" ]; then sudo -u treelogy git -C "$APP" pull -q --ff-only; else sudo -u treelogy git clone -q "$REPO" "$APP"; fi
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

echo "== redis: persistensi AOF (default Ubuntu hanya snapshot RDB berkala)"
redis-cli CONFIG SET appendonly yes >/dev/null
redis-cli CONFIG SET appendfsync everysec >/dev/null
redis-cli CONFIG SET maxmemory-policy noeviction >/dev/null   # state bukan cache: jangan pernah dibuang
redis-cli CONFIG REWRITE >/dev/null
systemctl enable --now redis-server >/dev/null
echo "redis $(redis-cli --version | cut -d' ' -f2) · appendonly=$(redis-cli CONFIG GET appendonly | tail -1) · bind=$(redis-cli CONFIG GET bind | tail -1)"

echo "== systemd"
cp "$APP/deploy/treelogy.service" "$APP/deploy/treelogy-sweep.service" "$APP/deploy/treelogy-sweep.timer" \
   "$APP/deploy/treelogy-daily.service" "$APP/deploy/treelogy-daily.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now treelogy.service treelogy-sweep.timer treelogy-daily.timer
systemctl restart treelogy.service

echo "== nginx"
cp "$APP/deploy/nginx-api.conf" /etc/nginx/sites-available/api.treelogy-services.my.id
ln -sf /etc/nginx/sites-available/api.treelogy-services.my.id /etc/nginx/sites-enabled/api.treelogy-services.my.id
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "== firewall"
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

echo "== cek"
sleep 2
curl -fsS http://127.0.0.1:3000/api/status | head -c 300; echo
systemctl --no-pager --lines=5 status treelogy.service | tail -6
