#!/usr/bin/env bash
# North Echo autodeploy (northecho-deploy.timer, every minute, as root).
#
# Builds every new commit of $BRANCH in a release directory of its own and
# switches the site and services to it only once the build passed and the
# services answer their health checks; otherwise it goes back to the previous
# release and does not retry that commit. The live release is never touched
# while a new one builds.
#
#   /var/www/northecho/           the git clone (fetch only) and:
#     releases/<sha>/             one build per commit (the last 3 are kept)
#     releases/.failed            commits that did not deploy (not retried)
#     current -> releases/<sha>   what nginx and systemd run
#
# FORCE=1 rebuilds even a deployed or failed commit.
set -euo pipefail
# nginx reads the build: files must be world-readable whatever umask we came with.
umask 022

APP=/var/www/northecho
USER_=northecho
BRANCH=${BRANCH:-main}
RELEASES=$APP/releases
KEEP=3
SERVICES=(api meta game)
PORTS=(8090 8091 8092)
NODE_MIN=20.19

log() { echo "$*"; }
as_app() { runuser -u "$USER_" -- env HOME="$APP" PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$@"; }

exec 9>/run/northecho-deploy.lock
flock -n 9 || exit 0

cd "$APP"
mkdir -p "$RELEASES"
chown "$USER_:$USER_" "$RELEASES"
touch "$RELEASES/.failed"

as_app git -c safe.directory="$APP" fetch -q origin "$BRANCH"
NEW=$(as_app git -c safe.directory="$APP" rev-parse "origin/$BRANCH")
CUR=$(basename "$(readlink -f "$APP/current" 2>/dev/null || echo none)")
if [[ "${FORCE:-}" != 1 ]]; then
  [[ "$NEW" == "$CUR" ]] && exit 0
  grep -qx "$NEW" "$RELEASES/.failed" && exit 0
fi

# Node: Vite needs 20.19+, the native modules are built for the running major.
NODE_V=$(node -p 'process.versions.node')
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);const [x,y]='$NODE_MIN'.split('.').map(Number);process.exit(a>x||(a===x&&b>=y)?0:1)"; then
  log "node $NODE_V is too old (need $NODE_MIN+): not deploying"
  exit 1
fi

log "deploy ${CUR:0:7} -> ${NEW:0:7} ($BRANCH)"
REL=$RELEASES/$NEW
TMP=$RELEASES/.build-$NEW
rm -rf "$TMP"
install -d -o "$USER_" -g "$USER_" "$TMP"

fail() {
  log "FAILED ${NEW:0:7}: $1 — staying on ${CUR:0:7}"
  echo "$NEW" >> "$RELEASES/.failed"
  rm -rf "$TMP"
  exit 1
}

# 1. Sources of the commit, then dependencies and the build, all in the new directory.
as_app bash -c "git -c safe.directory='$APP' archive '$NEW' | tar -x -C '$TMP'" || fail "git archive"
as_app bash -c "cd '$TMP' && npm ci --include=dev --no-audit --no-fund --prefer-offline" || fail "npm ci"
as_app bash -c "cd '$TMP' && NODE_OPTIONS=--max-old-space-size=768 nice -n 10 npm run -s build" || fail "build"
for s in "${SERVICES[@]}"; do [[ -f "$TMP/apps/$s/dist/main.mjs" ]] || fail "no bundle for $s"; done
[[ -f "$TMP/apps/web/dist/play.html" ]] || fail "no site build"

# Pages open in a browser still ask for the old hashed bundles: keep them reachable.
PREV=$(readlink -f "$APP/current" 2>/dev/null || true)
if [[ -n "$PREV" && -d "$PREV/apps/web/dist/assets" ]]; then
  cp -rn "$PREV/apps/web/dist/assets/." "$TMP/apps/web/dist/assets/" 2>/dev/null || true
fi
rm -rf "$REL"
mv "$TMP" "$REL"

# 2. Which services changed: their bundle, or the dependencies they load at run time.
changed=()
for s in "${SERVICES[@]}"; do
  if [[ -z "$PREV" ]] || ! cmp -s "$PREV/apps/$s/dist/main.mjs" "$REL/apps/$s/dist/main.mjs" \
    || ! cmp -s "$PREV/package-lock.json" "$REL/package-lock.json" \
    || ! systemctl is-active -q "northecho-$s"; then
    changed+=("$s")
  fi
done

# systemd units and the nginx site come with the release; install them when they changed.
units_changed=0
for u in northecho-api.service northecho-meta.service northecho-game.service northecho.target northecho-deploy.service northecho-deploy.timer; do
  if ! cmp -s "$REL/deploy/$u" "/etc/systemd/system/$u"; then
    install -m 644 "$REL/deploy/$u" "/etc/systemd/system/$u"
    units_changed=1
  fi
done
[[ $units_changed == 1 ]] && systemctl daemon-reload

switch_to() {
  ln -sfn "$1" "$APP/current.next"
  mv -T "$APP/current.next" "$APP/current"
}

healthy() {
  local s=$1 port=$2
  for _ in $(seq 1 30); do
    curl -fsS -m 2 "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# 3. Switch: the site at once (one rename), then the services that changed.
switch_to "$REL"
for s in "${changed[@]}"; do systemctl restart "northecho-$s" || true; done

ok=1
for i in "${!SERVICES[@]}"; do
  healthy "${SERVICES[$i]}" "${PORTS[$i]}" || { log "health check failed: ${SERVICES[$i]}"; ok=0; }
done

if [[ $ok != 1 ]]; then
  if [[ -n "$PREV" ]]; then
    switch_to "$PREV"
    for s in "${changed[@]}"; do systemctl restart "northecho-$s" || true; done
    log "rolled back to $(basename "$PREV" | cut -c1-7)"
  fi
  echo "$NEW" >> "$RELEASES/.failed"
  journalctl -u 'northecho-*' --since '-3min' --no-pager -n 40 | grep -v northecho-deploy || true
  exit 1
fi

# nginx: the site config of this release (checked before it is used).
SITE=/etc/nginx/sites-available/evntary.ru
if [[ -f "$REL/deploy/nginx.conf" ]] && ! cmp -s "$REL/deploy/nginx.conf" "$SITE"; then
  cp "$SITE" "$SITE.prev" 2>/dev/null || true
  cp "$REL/deploy/nginx.conf" "$SITE"
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log "nginx config updated"
  else
    cp "$SITE.prev" "$SITE"
    log "new nginx config rejected by nginx -t: kept the old one"
  fi
fi

# 4. This script updates itself; old releases go (the live and previous stay).
install -m 755 "$REL/deploy/deploy.sh" /usr/local/sbin/northecho-deploy
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  [[ "$(readlink -f "$old")" == "$(readlink -f "$APP/current")" ]] || rm -rf "$old"
done
log "deployed $(as_app git -c safe.directory="$APP" log -1 --format='%h %s' "$NEW") · restarted: ${changed[*]:-none}"
