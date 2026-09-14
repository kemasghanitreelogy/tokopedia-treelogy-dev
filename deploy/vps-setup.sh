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
redis-cli CONFIG REWRITE >/dev/null
systemctl enable --now redis-server >/dev/null
echo "redis $(redis-cli --version | cut -d' ' -f2) · appendonly=$(redis-cli CONFIG GET appendonly | tail -1) · bind=$(redis-cli CONFIG GET bind | tail -1)"

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
ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null

echo "== cek"
sleep 2
curl -fsS http://127.0.0.1:3000/api/status | head -c 300; echo
systemctl --no-pager --lines=5 status treelogy.service | tail -6
