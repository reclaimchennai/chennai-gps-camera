# Google Play submission pack — Chennai GPS Camera

Everything needed to publish `city.reclaimchennai.cam` to Google Play, and to
answer the Play Console's compliance forms truthfully. Files here are the
**source of truth**; copy their contents into the Console fields.

| Doc | Play Console section |
| --- | --- |
| [`store-listing.md`](store-listing.md) | Main store listing (title, descriptions, graphics) |
| [`data-safety.md`](data-safety.md) | App content → Data safety |
| [`permissions.md`](permissions.md) | Permissions & the sensitive-permission declarations |
| [`content-rating.md`](content-rating.md) | App content → Content ratings (IARC) |
| Privacy policy | Hosted at **https://cam.reclaimchennai.city/privacy.html** (source: `app/public/privacy.html`) |

## App facts (verified against the repo)

- **Package / applicationId:** `city.reclaimchennai.cam`
- **Signing:** release keystore `~/tools/android-keys/gpscam-release.jks`, alias
  `gpscam`, cert SHA-256 `8e111f…4eb7`. **Never lose this** — it's the upload
  key. Enroll in Play App Signing at first upload; keep this as the upload key.
- **minSdk 24 / targetSdk 36 / compileSdk 36** (`android/variables.gradle`) —
  meets Play's current target-API requirement.
- **Format:** Google Play requires an **AAB** (`app-release.aab` from
  `./gradlew bundleRelease`), not the APK. The APK stays for the GitHub /
  Obtainium / self-host channels.
- **No accounts, no ads, no analytics, no tracking SDKs, no in-app purchases.**
- **Data leaves the device only** for: reverse geocoding (coords → address),
  optional Google static map, and user-initiated bug reports (Telegram). See
  `data-safety.md`.

## Build the release bundle (AAB)

Runs entirely userspace on the sister server (see the android-build memory):

```bash
cd app
npm run build && npx cap sync android
cd android
JAVA_HOME=~/tools/jdk-21.0.11+10 ANDROID_HOME=~/tools/android-sdk \
  ./gradlew bundleRelease --no-daemon
# → app/build/outputs/bundle/release/app-release.aab  (signed with the keystore)
```

Verify it's signed by the right key before uploading:

```bash
# unzip the AAB's signature block or check the APKs it generates via bundletool
~/tools/android-sdk/build-tools/36.0.0/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk   # same key as the AAB
```

## Submission checklist

- [ ] Create the app in Play Console (name, default language en-IN, app not game).
- [ ] Upload `app-release.aab` to a **Closed testing** track first.
- [ ] **Store listing** — paste from `store-listing.md`; upload icon, feature
      graphic, and ≥2 phone screenshots (see that file for the shot list).
- [ ] **Privacy policy URL** → `https://cam.reclaimchennai.city/privacy.html`.
- [ ] **Data safety** — fill from `data-safety.md`.
- [ ] **App content**: content rating (IARC, `content-rating.md`), target
      audience (13+), ads = No, news app = No, data safety done, government
      app = No, financial features = No.
- [ ] **Permissions**: complete the Location permission declaration
      (`permissions.md`) — needed because `ACCESS_FINE_LOCATION` is requested.
- [ ] **App access**: choose "All functionality is available without special
      access" (no login) so review isn't blocked.
- [ ] Add testers, roll out to closed testing, then promote to production.

## Open decisions for the owner

- **Final app title / branding** is still a pending owner decision (the
  in-app working name is "Chennai GPS Camera"; the Android launcher label is
  currently "GPS Cam"). Pick the Play title before production rollout.
- **Developer account**: a one-time $25 Google Play developer registration is
  required, plus (for orgs) D-U-N-S verification.
