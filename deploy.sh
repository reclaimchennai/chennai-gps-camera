#!/usr/bin/env bash
# Build the site image and put it live as cam-app.
#
# cam.reclaimchennai.city is served by the cam-app container running the
# published image, with the built app baked in (see Dockerfile); the edge
# Caddy proxies cam.reclaimchennai.city -> cam-app:8080 on the `web`
# network. This script used to build into deploy/releases and swap a
# symlink that only a bind-mount setup ever read. cam-app has no mounts,
# so it reported success and changed nothing the site served.
#
#   ./deploy.sh                    build vX (the Android versionName) and go live
#   ./deploy.sh --push             ...and push vX and latest to Docker Hub
#   ./deploy.sh --rollback v1.46.0 put an earlier image back live
#
# Going live recreates only cam-app: the site is down for about a second,
# and nothing else on the server is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="reclaimchennai/chennai-gps-camera"
NAME="cam-app"
NET="web"
SITE="https://cam.reclaimchennai.city/"

version() {
  sed -n 's/.*versionName "\(.*\)".*/v\1/p' "$ROOT/app/android/app/build.gradle" | head -1
}

# The main bundle an index.html loads — what proves which build is live.
bundle() {
  grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
}

go_live() {
  local tag="$1"
  docker image inspect "$IMAGE:$tag" >/dev/null 2>&1 || docker pull "$IMAGE:$tag"
  local want
  want="$(docker run --rm --entrypoint cat "$IMAGE:$tag" /srv/app/index.html | bundle)"
  echo "==> Recreating $NAME on $IMAGE:$tag ($want)"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --network "$NET" --restart unless-stopped "$IMAGE:$tag" >/dev/null
  # by content, through the edge: the bundle the site serves must be the
  # one in the image
  local got=""
  for _ in $(seq 1 30); do
    got="$(curl -fsS "$SITE" 2>/dev/null | bundle || true)"
    if [[ "$got" == "$want" ]]; then
      echo "==> Live: $SITE serves $got"
      return 0
    fi
    sleep 1
  done
  echo "!! $SITE serves ${got:-nothing}, expected $want" >&2
  return 1
}

case "${1:-}" in
  --rollback)
    [[ -n "${2:-}" ]] || { echo "usage: $0 --rollback vX.Y.Z" >&2; exit 2; }
    go_live "$2"
    exit 0
    ;;
  ""|--push) ;;
  *) echo "usage: $0 [--push | --rollback vX.Y.Z]" >&2; exit 2 ;;
esac

TAG="$(version)"
[[ -n "$TAG" ]] || { echo "no versionName in app/android/app/build.gradle" >&2; exit 1; }
PREVIOUS="$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)"

echo "==> Building $IMAGE:$TAG"
docker build -t "$IMAGE:$TAG" -t "$IMAGE:latest" "$ROOT"

if [[ "${1:-}" == "--push" ]]; then
  echo "==> Pushing $TAG and latest"
  docker push "$IMAGE:$TAG"
  docker push "$IMAGE:latest"
fi

go_live "$TAG"
if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$IMAGE:$TAG" ]]; then
  echo "Rollback:  $0 --rollback ${PREVIOUS##*:}"
fi
