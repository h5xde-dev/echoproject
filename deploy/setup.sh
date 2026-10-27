#!/usr/bin/env bash
# One-time (idempotent) server setup for North Echo, run as root:
#   YANDEX_CLIENT_ID=… YANDEX_CLIENT_SECRET=… bash setup.sh
# Creates the user and directories, clones the repo, writes the secrets file,
# gets the Let's Encrypt certificate, installs nginx and systemd units, and
# runs the first deploy. The site stays out of the other sites' way.
set -euo pipefail

DOMAIN=evntary.ru
APP=/var/www/northecho
REPO=https://github.com/h5xde-dev/echoproject.git

id northecho >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin northecho
[[ -d "$APP/.git" ]] || { mkdir -p "$APP"; chown northecho:northecho "$APP"; runuser -u northecho -- git clone -q "$REPO" "$APP"; }
mkdir -p /var/www/letsencrypt /etc/northecho

if [[ ! -f /etc/northecho/env ]]; then
  : "${YANDEX_CLIENT_ID:?}" "${YANDEX_CLIENT_SECRET:?}"
  cat > /etc/northecho/env <<ENV
PORT=8090
HOST=127.0.0.1
ORIGIN=https://$DOMAIN
DB_PATH=/var/lib/northecho/north.db
DIST_DIR=$APP/dist
YANDEX_CLIENT_ID=$YANDEX_CLIENT_ID
YANDEX_CLIENT_SECRET=$YANDEX_CLIENT_SECRET
YANDEX_REDIRECT=https://$DOMAIN/callback
RTC_PORT_BEGIN=40000
RTC_PORT_END=40199
ENV
  chmod 640 /etc/northecho/env
  chgrp northecho /etc/northecho/env
fi

# Certificate first, over plain HTTP (webroot), then the full site config.
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
cp "$APP/deploy/nginx.conf" /etc/nginx/sites-available/$DOMAIN
ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN

cp "$APP"/deploy/northecho.service "$APP"/deploy/northecho-deploy.service "$APP"/deploy/northecho-deploy.timer /etc/systemd/system/
systemctl daemon-reload
FORCE=1 "$APP/deploy/deploy.sh"
systemctl enable -q --now northecho northecho-deploy.timer
nginx -t && systemctl reload nginx
echo "ready: https://$DOMAIN"
