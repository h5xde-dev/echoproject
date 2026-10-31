#!/usr/bin/env bash
# One-time (idempotent) server setup for North Echo, run as root:
#   YANDEX_CLIENT_ID=… YANDEX_CLIENT_SECRET=… bash setup.sh            # a new server
#   BRANCH=some-branch bash setup.sh                                   # deploy another branch
# Also moves a server from the old single-process layout (northecho.service,
# site in /var/www/northecho/dist) to the API, meta and game services with
# release directories. The other sites on this machine are left alone.
set -euo pipefail

DOMAIN=evntary.ru
APP=/var/www/northecho
REPO=https://github.com/h5xde-dev/echoproject.git
ENVF=/etc/northecho/env
BRANCH=${BRANCH:-main}
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# Node 20.19+ (Vite 8, better-sqlite3); install 22 LTS from NodeSource if missing or older.
if ! command -v node >/dev/null || ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v curl >/dev/null || apt-get install -y curl
command -v sqlite3 >/dev/null || apt-get install -y sqlite3

id northecho >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin northecho
[[ -d "$APP/.git" ]] || { mkdir -p "$APP"; chown northecho:northecho "$APP"; runuser -u northecho -- git clone -q "$REPO" "$APP"; }
mkdir -p /var/www/letsencrypt /etc/northecho /var/lib/northecho
chown northecho:northecho /var/lib/northecho

# Settings and secrets, outside the repository.
if [[ ! -f $ENVF ]]; then
  : "${YANDEX_CLIENT_ID:?}" "${YANDEX_CLIENT_SECRET:?}"
  cat > "$ENVF" <<ENV
HOST=127.0.0.1
ORIGIN=https://$DOMAIN
DB_PATH=/var/lib/northecho/north.db
YANDEX_CLIENT_ID=$YANDEX_CLIENT_ID
YANDEX_CLIENT_SECRET=$YANDEX_CLIENT_SECRET
YANDEX_REDIRECT=https://$DOMAIN/callback
RTC_PORT_BEGIN=40000
RTC_PORT_END=40199
ENV
fi
set_env() { grep -q "^$1=" "$ENVF" && sed -i "s|^$1=.*|$1=$2|" "$ENVF" || echo "$1=$2" >> "$ENVF"; }
grep -q '^SERVICE_SECRET=' "$ENVF" || set_env SERVICE_SECRET "$(openssl rand -hex 32)"
set_env DIST_DIR "$APP/current/apps/web/dist"
set_env ORIGINS "https://$DOMAIN"
# The old single server listened on PORT; each service now has its own.
sed -i '/^PORT=/d' "$ENVF"
chmod 640 "$ENVF"
chgrp northecho "$ENVF"
echo "BRANCH=$BRANCH" > /etc/northecho/deploy.env

# Certificate first, over plain HTTP (webroot), if there is none yet.
if [[ ! -d /etc/letsencrypt/live/$DOMAIN ]]; then
  cat > /etc/nginx/sites-available/$DOMAIN <<NGX
server {
    listen 80;
    server_name $DOMAIN www.$DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
}
NGX
  ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/letsencrypt -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos --keep-until-expiring --deploy-hook "systemctl reload nginx"
fi

# A copy of the database before the new API migrates it.
if [[ -f /var/lib/northecho/north.db ]]; then
  backup=/var/lib/northecho/north.db.$(date +%Y%m%d-%H%M%S).bak
  sqlite3 /var/lib/northecho/north.db ".backup '$backup'"
  chown northecho:northecho "$backup"
  echo "database backed up to $backup"
fi

# Units and the deploy script from this checkout; the first deploy builds a release.
install -m 644 "$SRC"/northecho-api.service "$SRC"/northecho-meta.service "$SRC"/northecho-game.service \
  "$SRC"/northecho.target "$SRC"/northecho-deploy.service "$SRC"/northecho-deploy.timer /etc/systemd/system/
install -m 755 "$SRC/deploy.sh" /usr/local/sbin/northecho-deploy
systemctl daemon-reload

# The old single server holds port 8090 (the API's now): stop it for good.
if systemctl list-unit-files northecho.service >/dev/null 2>&1 && [[ -f /etc/systemd/system/northecho.service ]]; then
  systemctl disable --now northecho.service || true
  rm -f /etc/systemd/system/northecho.service
  systemctl daemon-reload
fi

systemctl stop northecho-deploy.timer 2>/dev/null || true
BRANCH=$BRANCH FORCE=1 /usr/local/sbin/northecho-deploy
systemctl enable -q northecho.target northecho-api northecho-meta northecho-game
systemctl enable -q --now northecho-deploy.timer

# The site config (deploy.sh installs it too, from then on with every release).
cp "$APP/current/deploy/nginx.conf" /etc/nginx/sites-available/$DOMAIN
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
nginx -t && systemctl reload nginx

# Leftovers of the old layout.
rm -rf "$APP/dist" "$APP/dist.old" "$APP/.dist-next" "$APP/server-dist" "$APP/node_modules"
echo "ready: https://$DOMAIN"
