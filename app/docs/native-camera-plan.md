# Native camera (CameraX) — staged plan

## Why (measured, not assumed)
From the app's own capability report on real devices:
| Device | Cameras offered to the WebView | Zoom range | Aim points |
|---|---|---|---|
| Pixel 9a | 1 | not offered | not offered |
| Motorola A024 | 1 | not offered | not offered |
| Galaxy S25+ | 3 | not offered | not offered |

Everything still on the list traces to that table: no ultra-wide on
Pixel/Motorola, a close-and-reopen hitch crossing 0.6x on Samsung, and
tap-to-focus written as a JavaScript contrast sweep.

## Stage 1 — DONE (this release, dormant)
CameraX in the build; `NativeCameraPlugin` with preview, capability
readout, continuous zoom, hardware focus metering, torch, full-res still.
Registered but never started: the shipping app is byte-for-byte unchanged
in behaviour.

## Stage 2 — prove it on real hardware (next)
Add a hidden Settings switch "Native camera (experimental)". On:
  - stop the web camera, start the native preview
  - report min/max zoom in the capability panel
Success = Pixel 9a reports minZoom 0.5, tap-to-focus reports supported,
and the preview appears behind the existing UI.
This is the go/no-go gate. Cheap to abandon if compositing misbehaves.

## Stage 3 — capture on the native path
Route photos through `capture()`; keep the whole existing watermark,
queue, gallery and share pipeline (it takes a JPEG either way).

## Stage 4 — video
The hard part: today the watermark is burned in by recording a canvas that
composites the <video>. With a native preview there is no <video>. Options
to weigh then: CameraX VideoCapture + OpenGL overlay, or keep video on the
web path and switch camera ownership per mode.

## Stage 5 — cut over
Native becomes default per device only where Stage 2 proved better;
the web path stays as the fallback and for the PWA, which keeps
cam.reclaimchennai.city working unchanged.
