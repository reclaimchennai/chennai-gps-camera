# Chennai GPS Camera

A fast, privacy-first, location-stamped camera you can install as a web app.
Open it, tap the shutter, and the photo is saved instantly with a clean
address card burned into the pixels — GPS coordinates, date & time, street
address, and (in the Chennai pilot area) the municipal ward, zone, and the
exact Law & Order and Traffic police-station jurisdictions, all resolved
**on your device, offline**. True GPS EXIF metadata is written alongside,
whatever the visible card shows.

Live instance: **https://cam.reclaimchennai.city**

## Why this exists

Civic reporting needs photos that prove *where* and *when* — and often need
bystanders' privacy protected before sharing. Generic GPS-camera apps wait on
the network, stamp only coordinates, and upload your photos to someone's
cloud. This one doesn't: everything happens in your browser, on your phone.

## Features

- **Instant capture** — the camera pre-warms on launch; a shutter tap
  persists a full-resolution watermarked JPEG with GPS EXIF in well under a
  second, with zero network on the capture path.
- **Offline jurisdiction lookup across 9 region packs**: ward, zone
  ("Zone Teynampet (9)"), and — where published — Law & Order and Traffic
  police stations, from boundary polygons evaluated on-device. Coverage:
  **all of Tamil Nadu** (every corporation/municipality/town panchayat +
  statewide police), **Bengaluru** (GBA wards + city & traffic police),
  **Hyderabad**, **Delhi**, **Kolkata**, **Mumbai**, **Pune**, and
  **Visakhapatnam**. The pack for wherever you are downloads automatically,
  caches for offline use, and updates over the air. Honest about data gaps:
  fields are omitted rather than guessed (Avadi shows "ward not yet
  available" until its boundaries are published).
- **DIGIPIN** — India Post's open 10-character digital address code,
  computed offline from the official algorithm (optional field, works
  country-wide).
- **Fully customizable watermark** — three layouts, top or bottom placement,
  per-field toggles (address, coordinates, DIGIPIN, altitude, compass, date
  in three formats, mini-map, police fields…), style controls, and a
  branding-free card. Social handles render as a rotated strip with platform
  logos along the photo edge; the street address backfills automatically
  when you come online, without touching the capture path.
- **Offline vector mini-map** of the surrounding ward drawn from bundled
  data — or genuine Google Maps imagery if you supply your own API key.
- **Annotate & redact** — Telegram-style editor: pen (multi-stroke marks
  group into one movable object), highlighter, arrows, circles, styled text
  with fonts, and pixelation blur (box, freehand, and **on-device face
  detection** that also catches side profiles via pose landmarks).
  Everything is draggable/resizable with round outside handles; originals
  are never modified — edits flatten onto a copy.
- **Experimental live face blur** — detect and blur faces in the viewfinder
  and burn them into photos at capture (opt-in).
- **Video** — record with the same overlay, then trim/crop/annotate/blur and
  export in a single pass with the watermark burned in.
- **Gallery** with search (locations, stations, dates, custom tags), tag
  chips, and auto-save of every capture to the device.
- **Installable PWA** with automatic updates, light/dark themes, and full
  offline operation after the first visit.

## Privacy

- **Everything runs on-device.** Photos, videos, location fixes, face
  detection, and jurisdiction lookups never leave your phone.
- **No accounts, no telemetry, no analytics.** This server only serves
  static files.
- The only outbound requests are ones you control: the optional background
  address lookup (OpenStreetMap Nominatim, or Google with your own key) and
  the optional Google map thumbnail. Turn the geocoder off in Settings and
  the app makes no network requests at all after install.
- Auto face blurring is best-effort, not a guarantee — always review before
  sharing.
- Don't take our word for it: the entire client is in this repository, and
  you can self-host it.

## Self-hosting

Quickest — the prebuilt image from Docker Hub:

```bash
docker run -d --name gps-camera -p 8080:8080 --restart unless-stopped \
  reclaimchennai/chennai-gps-camera
# → http://localhost:8080
```

Or build from source (verifiable):

```bash
git clone git@github.com:reclaimchennai/chennai-gps-camera.git
cd chennai-gps-camera
docker compose -f compose.selfhost.yml up -d --build
# → http://localhost:8080
```

One important browser rule: **camera and GPS only work in a secure
context** — `http://localhost` is fine for personal use, but any LAN or
public deployment needs HTTPS in front. The simplest way is Caddy on the
host:

```
your.domain.example {
    reverse_proxy 127.0.0.1:8080
}
```

which obtains certificates automatically.

## Development

```bash
cd app
npm install
npm run dev        # dev server (camera works on localhost)
npm run build      # production build → app/dist
npm run smoke      # end-to-end suite: headless Chromium, fake camera + GPS,
                   # capture → EXIF → jurisdiction → gallery → PWA checks
```

### Android app (APK)

A native Android build wraps the same PWA with two OS-level upgrades: the
phone's own geocoder (`android.location.Geocoder`, forced to English) for
human-readable addresses, and MediaStore saves so captures land in the
device gallery (`DCIM/GPS Camera`). Download it from a running instance at
`/download/chennai-gps-camera.apk`, or build it yourself:

```bash
cd app
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Signing: put a `keystore.properties` (storeFile / storePassword / keyAlias /
keyPassword) next to `app/android/build.gradle`; without it the build
produces an unsigned APK. The custom native bridge (English reverse
geocoding + gallery save) is
`app/android/app/src/main/java/city/reclaimchennai/cam/NativeBridgePlugin.java`.

### Repository layout

```
app/                      the PWA (React + TypeScript + Vite + Capacitor)
  src/lib/geo/            offline lookup, DIGIPIN, formatting
  src/lib/watermark/      the single watermark renderer + social strip
  src/lib/detect/         on-device face/head detection
  src/lib/editor/         annotation shape model
  src/components/         screens and editors
  public/data/            filtered Chennai boundary bundle (committed, so
                          self-hosters don't need the upstream dataset)
  scripts/                geodata filter, icon generation, smoke suite
Dockerfile                self-hosting image (build → static serve)
compose.selfhost.yml      one-command self-host
Caddyfile.selfhost        the container's internal web server config
deploy.sh, Caddyfile.inner, docker-compose.yml
                          production wiring for cam.reclaimchennai.city —
                          specific to that server, safe to ignore
```

## Data sources & licences

- **Tamil Nadu boundary data**: derived from public Tamil Nadu government
  datasets, processed by the Reclaim Chennai project.
- **Bengaluru, Delhi, Hyderabad, Kolkata, Mumbai, Pune, Visakhapatnam
  boundary data**: from
  [Vonter/city-officials](https://github.com/Vonter/city-officials)
  (GPL-3.0; interactive version at
  [cityofficials.bengawalk.com](https://cityofficials.bengawalk.com)),
  which builds on datasets published at
  [data.opencity.in](https://data.opencity.in) and the respective
  government sources. The derived pack files in `app/public/data/packs/`
  for those cities inherit that data's licence.
- All boundaries are indicative — for official information always confirm
  with local authorities.
- **DIGIPIN**: © India Post, Department of Posts — ported from the official
  open-source reference implementation.
- **Geocoding**: © OpenStreetMap contributors (Nominatim), used under the
  ODbL/fair-use policy; optionally Google Geocoding with your own key.
- **Icons**: [Lucide](https://lucide.dev) (ISC) and
  [Simple Icons](https://simpleicons.org) (CC0).
- **Fonts**: Roboto, Open Sans, Montserrat, Oswald, Caveat via Fontsource
  (OFL/Apache).
- **Face detection**: MediaPipe Tasks (Apache-2.0), models served from this
  origin and cached for offline use.

## Scope & roadmap

The jurisdiction layer covers all of Tamil Nadu plus seven other major
Indian cities (see Features). GPS, DIGIPIN, address lookup, annotation, and
everything else work anywhere. More regions are planned — packs are
bbox-indexed, versioned, and update over the air without an app release, so
adding a city is a data change, not a code change
(`app/scripts/build-packs.mjs`).

## Contributing

Issues and pull requests are welcome. Keep the ground rules in mind: no
telemetry, nothing leaves the device without an explicit user action, no
branding on output, and the capture path never waits on the network.

## License

[MIT](LICENSE)
