# Chennai GPS Camera — self-hosting image.
# Stage 1 builds the PWA; stage 2 serves the static bundle with Caddy.
# Everything runs client-side in the browser: this container only serves
# files — it receives no photos, no locations, no telemetry.

FROM node:24-alpine AS build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ .
RUN npm run build

FROM caddy:2-alpine
LABEL org.opencontainers.image.source="https://github.com/reclaimchennai/chennai-gps-camera" \
      org.opencontainers.image.description="Privacy-first GPS camera PWA — static self-host image" \
      org.opencontainers.image.licenses="MIT"
COPY Caddyfile.selfhost /etc/caddy/Caddyfile
COPY --from=build /build/dist /srv/app
EXPOSE 8080
