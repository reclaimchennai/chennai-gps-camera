# Native camera migration (CameraX) — engineering plan

Status: **Stage 1 complete** (v1.13.1 — CameraX compiled in, plugin dormant).
Audience: the engineer/model implementing Stages 2–6.

---

## 1. Why. The evidence, not a hunch.

The app draws its viewfinder with `getUserMedia` inside the Android
WebView. That layer exposes a deliberately narrow slice of the camera.
Measured with the app's own capability panel on real devices:

| Device | Cameras offered | Zoom range | Aim points (`pointsOfInterest`) |
|---|---|---|---|
| Pixel 9a | 1 | not offered | not offered |
| Motorola G84 / A024 | 1 | not offered | not offered |
| Galaxy S25+ | 3 | not offered | not offered |

Every remaining complaint descends from that table:

* **No ultra-wide on Pixel / Motorola.** The hardware has one; the WebView
  never shows it. No JavaScript can reach it. `Detect lenses` correctly
  finds nothing.
* **Hitch crossing 0.6×→1× on Samsung.** Three cameras but no zoom range,
  so the app must close one camera and open another. ~300–600 ms of black,
  currently masked with a held frame and a glide animation.
* **Tap-to-focus is hand-written.** Aim points are refused everywhere, so
  `lib/camera.ts` runs a contrast sweep over `focusDistance` in JS: sets a
  distance, waits for frames, measures gradient energy in the tapped
  region, keeps the sharpest. Works, but takes ~1 s and can misjudge.
* **Slow cold start.** `getUserMedia` negotiation plus WebView startup.

CameraX gives all of it directly: a continuous `ZoomState` ratio spanning
the physical lenses (the camera stack crosses between them itself —
seamless, which is what the stock camera app does), hardware
`FocusMeteringAction`, and a preview bound to the activity lifecycle.

> **Caution for whoever reads the next capability report.** Before
> v1.13.2 the panel reported "not offered" for everything when no camera
> was running, which is indistinguishable from a phone that offers
> nothing. The Motorola report showing all-"not offered" was taken with an
> idle viewfinder and is **not** evidence about that phone. v1.13.2 opens
> a temporary camera when idle and labels the reading. Re-collect reports
> on ≥ v1.13.2.

---

## 2. What exists already (Stage 1, shipped dormant in v1.13.1)

`android/app/src/main/java/city/reclaimchennai/cam/NativeCameraPlugin.java`

| Method | Does |
|---|---|
| `isAvailable()` | probe |
| `start()` | inserts `PreviewView` behind the WebView, makes WebView transparent, binds `Preview` + `ImageCapture`, resolves with capabilities |
| `stop()` | unbinds, removes the view, restores the opaque WebView |
| `getCapabilities()` | `minZoom`, `maxZoom`, `zoom`, `hasFlash`, exposure range/step, `focusMetering` |
| `setZoom({zoom})` | `CameraControl.setZoomRatio` — the continuous cross-lens ratio |
| `focusAt({x,y})` | `FocusMeteringAction` at a normalised point (AF+AE), 4 s auto-cancel |
| `setTorch({on})` | `CameraControl.enableTorch` |
| `capture()` | full-res JPEG → base64 |

Registered in `MainActivity.onCreate`. **Nothing calls it.** CameraX
1.4.2 deps are in `app/build.gradle`, version pinned in `variables.gradle`.

---

## 3. Known technical traps (read before writing code)

1. **`PreviewView.ImplementationMode`.** Default `PERFORMANCE` uses a
   `SurfaceView`, which composites in its own hardware layer and will
   **not** reliably sit under a translucent WebView — expect the preview
   over the UI, or invisible. Use `COMPATIBLE` (TextureView) for the
   overlay architecture. Cost: slightly more power/latency. Verify on
   Samsung, Pixel and Motorola separately; this is the single biggest
   go/no-go risk.
2. **The viewfinder is not fullscreen.** The web layout letterboxes the
   picture inside `.cam-video-box`, with the watermark card anchored to
   its bottom and an opaque controls bar below. The native preview must be
   positioned to that rect, not `MATCH_PARENT`. Pass the rect from JS
   (`getBoundingClientRect()` × `devicePixelRatio`) and set layout params;
   re-send on rotation, resize and mode change. Current Stage-1 code uses
   `MATCH_PARENT` — that is a placeholder.
3. **One camera at a time.** The web path and the native path must never
   both hold it. Every switch is: stop one, wait for release (~200 ms —
   see `RELEASE_MS`), start the other.
4. **`display: none` on the camera screen** (v1.11.7, fixes gallery
   flicker) means the WebView's viewfinder element vanishes when
   navigating away. The native preview must be hidden/unbound in step with
   it, or it will show through the gallery.
5. **Transparent WebView repaints.** Setting `Color.TRANSPARENT` can
   expose scrolling artefacts on some WebView builds. Check the gallery
   and map screens, which are opaque full-screen.

---

## 4. Stages

### Stage 2 — prove it on hardware (the gate)
Hidden switch in Settings → Advanced: **"Native camera (experimental)"**.
On: stop the web camera, `NativeCamera.start()`, show reported
capabilities in the existing panel.

**Acceptance:**
- Pixel 9a and Motorola G84 report `minZoom ≤ 0.6` (proves the ultra-wide
  is reachable) and `focusMetering: true`.
- Preview appears *behind* the existing UI, correct aspect, no flicker.
- Back/minimise/restore leaves no orphaned surface.

If the preview cannot be composited correctly on all three phones, stop
here and reconsider — nothing else depends on it yet.

### Stage 3 — controls
Route zoom, tap-to-focus and torch to the native plugin when active.
Delete nothing: the web implementations remain the fallback.
- Zoom chips take their stops from `minZoom`/`maxZoom` (e.g. `.5×` appears
  on Pixel for the first time).
- Pinch maps directly to `setZoomRatio` — continuous, no lens switching,
  no freeze-frame masking needed.
- `focusAt` replaces the JS contrast sweep when native is active.

### Stage 4 — stills
`capture()` → base64 JPEG → existing `enqueueCapture` pipeline unchanged
(it already takes a JPEG). Set `setTargetRotation` from the app's
orientation store so EXIF matches. Verify the watermark, plate reader and
face blur still receive what they expect.

### Stage 5 — video (the hard part; budget most of the time here)
Today the watermark is burned in by recording a **canvas** that
composites the `<video>` element every frame (`CameraView.tsx`, the
`paint()` loop). With a native preview there is no `<video>`, so that
pipeline cannot work as-is.

Options, in the order I would try them:

**(a) CameraX `OverlayEffect` (recommended).** `androidx.camera:camera-effects`
(1.4+) draws an overlay onto preview, capture and video from one place.
Keep the *existing* watermark renderer: the web layer already draws the
card to an offscreen canvas — export it as a bitmap (~1 Hz, it only
changes when the clock/dB/address change), pass to native, draw it in the
overlay. Reuses all watermark logic, layout, themes and per-platform
handle formatting. No native re-implementation of the card.

**(b) `VideoCapture` + custom `SurfaceProcessor`.** Full control, most
code, most device-specific risk.

**(c) Keep video on the web path.** Switch camera ownership when entering
video mode. Cheapest, but the mode switch costs a camera reopen and
video loses the native zoom — a visible inconsistency.

**Live face blur** must move with it: it currently blurs on the web
canvas. Under (a) the blur rectangles have to be drawn in the same
overlay, which means face detection needs frames — either `ImageAnalysis`
feeding boxes natively (MediaPipe Android), or accepting that live blur is
preview-only on the native path. **Decide this explicitly; do not let it
be discovered late.**

### Stage 6 — cut over
Enable native by default **per device**, only where Stage 2/3 measured
better. Keep the web path for:
- the PWA at cam.reclaimchennai.city (unchanged, no native layer),
- any device where native misbehaves,
- a user-visible escape hatch in Settings.

---

## 5. Suggested execution order for a fresh session

1. Read `docs/native-camera-plan.md` (this file), `lib/camera.ts`
   (controller + contrast AF), `components/CameraView.tsx` (viewfinder,
   overlay paint loop, recording composite).
2. Stage 2 only. Ship it dormant-but-switchable and **get one capability
   report per phone** before writing Stage 3.
3. Do not touch `setZoom`, `useDevice` or the freeze/glide path in
   `lib/camera.ts` — the owner has confirmed the current 0.6×↔1× masking
   as acceptable and asked for it to be left alone. It becomes dead code
   only when native is default for that device.
4. Every release: `npm run build` → `npx cap sync android` → gradle **in
   that order** (building after sync ships a stale web bundle — this has
   happened), then verify the APK actually contains the change before
   uploading.

---

## 6. Testing without a device

The Playwright harness in this repo simulates the WebView convincingly:
stub `navigator.mediaDevices`, one camera at a time, slow async release,
mic killed on teardown, deviceIds re-salted per launch. It caught the
lens-switch black flash, the exposure-slider touch bug and the focus lag.

It **cannot** test CameraX. Stage 2's acceptance criteria must be checked
on the three real phones. Plan for that round trip.

---

## 7. Honest cost estimate

| Stage | Effort | Risk |
|---|---|---|
| 2 — preview + capabilities | 0.5–1 day | **High** (compositing) |
| 3 — zoom/focus/torch | 0.5 day | Low |
| 4 — stills | 0.5–1 day | Medium (rotation/EXIF) |
| 5 — video + blur | 3–5 days | **High** |
| 6 — cutover + per-device gating | 1 day | Medium |

Roughly **1–2 focused weeks**, most of it Stage 5. Expect a tail of
device-specific bugs after release, as with every camera change on this
project.

**Recommendation:** ship the current build to Play testing now; run
Stage 2 in parallel. It is small, reversible, and answers the only
question that matters — whether a native preview composites cleanly under
this app's UI on all three phones.
