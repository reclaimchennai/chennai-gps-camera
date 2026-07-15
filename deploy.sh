#!/usr/bin/env bash
# Build the PWA and activate it as a new release.
#
# Mirrors the police-locator release pattern: each build lands in
# deploy/releases/<timestamp>/ and deploy/current (a RELATIVE symlink,
# so it resolves inside the cam-app container mount) is swapped
# atomically. Rollback = repoint the symlink at the previous release.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/app"
DEPLOY="$ROOT/deploy"
TS="$(date +%Y%m%d-%H%M%S)"
RELEASE="$DEPLOY/releases/$TS"

echo "==> Building (geodata filter + icons run only if inputs exist)"
cd "$APP"
if [[ -d "$HOME/projects/police/police-locator-20260525-1033/public/data" ]]; then
  node scripts/filter-geodata.mjs
fi
npm run build

echo "==> Staging release $TS"
mkdir -p "$RELEASE"
cp -r "$APP/dist/." "$RELEASE/"

echo "==> Activating"
mkdir -p "$DEPLOY"
TMP_LINK="$DEPLOY/.current.new.$$"
ln -s "releases/$TS" "$TMP_LINK"
if [[ -L "$DEPLOY/current" ]]; then
  readlink "$DEPLOY/current" > "$DEPLOY/.current.previous"
fi
mv -Tf "$TMP_LINK" "$DEPLOY/current"

echo "==> Pruning old releases (keeping 5)"
ls -1dt "$DEPLOY/releases"/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf

echo
echo "Activated: deploy/current -> releases/$TS"
if [[ -f "$DEPLOY/.current.previous" ]]; then
  echo "Rollback:  ln -sfn \"\$(cat $DEPLOY/.current.previous)\" $DEPLOY/current"
fi
echo "Served by the cam-app container (docker compose up -d to start it)."
