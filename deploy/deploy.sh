#!/usr/bin/env bash
# Autodeploy (run by northecho-deploy.timer every minute, as root): if main on
# GitHub moved, pull it, build the site and the server, swap the site in
# atomically, and restart the game server only when its code changed.
set -euo pipefail

APP=/var/www/northecho
USER_=northecho
BRANCH=${BRANCH:-main}
as_app() { runuser -u "$USER_" -- env HOME="$APP" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$@"; }

cd "$APP"
exec 9>/run/northecho-deploy.lock
flock -n 9 || exit 0

as_app git fetch -q origin "$BRANCH"
OLD=$(as_app git rev-parse HEAD)
NEW=$(as_app git rev-parse "origin/$BRANCH")
if [[ "$OLD" == "$NEW" && -d dist && -f server-dist/main.mjs && "${FORCE:-}" != 1 ]]; then exit 0; fi

echo "deploy $OLD -> $NEW"
as_app git reset -q --hard "origin/$BRANCH"
if [[ ! -d node_modules ]] || ! as_app git diff --quiet "$OLD" "$NEW" -- package-lock.json; then
  as_app npm ci --include=dev --no-audit --no-fund
fi

# Typecheck, then build the site next to the live one and swap it in.
as_app npx tsc --noEmit
as_app npx vite build --outDir .dist-next --emptyOutDir --logLevel warn
rm -rf dist.old
[[ -d dist ]] && mv dist dist.old
mv .dist-next dist

BEFORE=$(sha1sum server-dist/main.mjs 2>/dev/null | cut -d' ' -f1 || true)
as_app npm run -s build:server
AFTER=$(sha1sum server-dist/main.mjs | cut -d' ' -f1)
if [[ "$BEFORE" != "$AFTER" ]] || ! systemctl is-active -q northecho; then
  systemctl restart northecho
  echo "server restarted"
fi
echo "deployed $(as_app git log -1 --format='%h %s')"
