# Permissions — declarations & justifications

Manifest: `app/android/app/src/main/AndroidManifest.xml`.

| Permission | Why it's needed | Play notes |
| --- | --- | --- |
| `INTERNET` | Reverse-geocode coordinates → address; optional static map; send user-initiated bug reports; download offline data packs. | Standard, no declaration form. |
| `CAMERA` | Core feature — the viewfinder, photos and video. | Core function; described in listing. |
| `RECORD_AUDIO` | Audio track for recorded video and the live sound-level (dB) watermark field. | Described in listing. |
| `MODIFY_AUDIO_SETTINGS` | Configure the audio capture path (choose/route the mic input) for recording and the meter. | Normal permission. |
| `ACCESS_FINE_LOCATION` | Stamp precise GPS coordinates, address, DIGIPIN and jurisdiction onto photos/videos. | **Triggers the Location permission declaration** — see below. |
| `ACCESS_COARSE_LOCATION` | Fallback/faster approximate fix when precise isn't available. | Covered by the same declaration. |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion="28"`) | Save captures to the gallery on Android 9 and below only. Newer versions use the scoped MediaStore, no permission. | Legacy-scoped; fine. |

## Location permission declaration (required by Play)

Because the app requests `ACCESS_FINE_LOCATION`, Play asks you to justify it.

- **Is location access required for core functionality?** Yes.
- **Which feature uses it?** Location stamping — the app writes the current
  coordinates, address, DIGIPIN, and civic jurisdiction (ward/zone/police
  limits) onto every photo and video. This is the app's primary purpose.
- **Does the app access location in the background?** **No.** Location is used
  only while the app is in the foreground and the camera is open. There is no
  `ACCESS_BACKGROUND_LOCATION` permission and no background service.
- **Prominent disclosure:** the listing and privacy policy state that the app
  captures and stamps precise location; the OS runtime prompt is shown before
  first use.

## Foreground-location prominent-disclosure text (in-app, if asked)

> "Chennai GPS Camera uses your device location to stamp coordinates, address,
> DIGIPIN, and civic jurisdiction onto the photos and videos you take. Location
> is used only while the app is open and is never collected by us or used in
> the background."

## Not requested (worth stating in review notes)

No background location, no contacts, no phone/SMS, no accounts, no advertising
ID, no `QUERY_ALL_PACKAGES`, no accessibility service.
