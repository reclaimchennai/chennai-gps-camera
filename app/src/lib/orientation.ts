/**
 * Physical device orientation from the accelerometer.
 *
 * The app's LAYOUT stays portrait (activity + PWA manifest are locked),
 * and instead the camera UI rotates its elements in place — the way
 * native camera apps behave. Reading gravity from `devicemotion` (not
 * screen.orientation) means the switch works even when the phone's
 * auto-rotate lock is ON and regardless of the activity lock.
 *
 * Published value is the CSS rotation that makes UI elements upright:
 *   0    portrait
 *   90   device turned counter-clockwise (top edge to the left)
 *   -90  device turned clockwise (top edge to the right)
 * Upside-down portrait is treated as 0 (nobody shoots that way on purpose).
 */
import { useLiveStore } from "../store";

export type UiRotation = 0 | 90 | -90;

/**
 * Two readings of the same sensor, for two different jobs.
 *
 * The UI needs to be STABLE: icons should not flicker while the phone
 * wobbles near 45°, so it waits for an orientation to hold briefly.
 *
 * The shutter needs to be RIGHT, now. It used to read the UI's debounced
 * value, which lagged the hand by the dominance threshold plus a 250 ms
 * hold — so turning the phone and shooting straight away saved a photo
 * laid out for the orientation it had just left: a landscape scene with a
 * portrait card. That was the report. The capture now reads `physical`,
 * which follows the hand with no hold at all.
 *
 * Both classify by ANGLE with hysteresis, the way Android's own camera
 * does, rather than by "one axis dominates the other by 1.3x": a band of
 * ±10° around each 45° boundary keeps it from chattering, and nothing is
 * decided while the phone is too flat to tell (within ~26° of flat — the
 * same gate Android's OrientationEventListener uses).
 */
let ui: UiRotation = 0;
let physical: UiRotation = 0;
let pending: UiRotation = 0;
let pendingSince = 0;

/** Past 45° by this much before it counts as turned. */
const HYSTERESIS_DEG = 10;
/** The UI waits this long before following — enough to ride out a wobble,
 *  short enough to feel immediate. It was 250 ms. */
const HOLD_MS = 120;

/** Signed angle difference in degrees, in (-180, 180]. */
const diff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

/** Which orientation this angle belongs to, given where we are now. */
function classify(angle: number, current: UiRotation): UiRotation {
  // upside-down portrait counts as portrait: nobody shoots that way on purpose
  const centres: { r: UiRotation; at: number }[] = [
    { r: 0, at: 0 },
    { r: 0, at: 180 },
    { r: 90, at: 90 },
    { r: -90, at: -90 },
  ];
  const here = Math.min(
    ...centres.filter((c) => c.r === current).map((c) => Math.abs(diff(angle, c.at)))
  );
  if (here <= 45 + HYSTERESIS_DEG) return current;
  let best = centres[0];
  for (const c of centres) {
    if (Math.abs(diff(angle, c.at)) < Math.abs(diff(angle, best.at))) best = c;
  }
  return best.r;
}

function onMotion(e: DeviceMotionEvent): void {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  const z = g.z ?? 0;
  // too flat to tell — keep the last confident answer, as a native camera does
  if (g.x * g.x + g.y * g.y < (z * z) / 4) return;
  // 0 = upright portrait; +90 = top edge turned to the left
  const angle = (Math.atan2(g.x, g.y) * 180) / Math.PI;

  physical = classify(angle, physical);

  const next = classify(angle, ui);
  const now = Date.now();
  if (next !== pending) {
    pending = next;
    pendingSince = now;
    return;
  }
  if (next !== ui && now - pendingSince >= HOLD_MS) {
    ui = next;
    useLiveStore.getState().setUiRotation(next);
  }
}

/**
 * How the phone is held at this instant — what a capture must use.
 *
 * Falls back to the UI value until the sensor has said anything, so a
 * device without motion events behaves exactly as before.
 */
export function physicalRotation(): UiRotation {
  return motionSeen ? physical : useLiveStore.getState().uiRotation;
}

let motionSeen = false;

export function startOrientationWatch(): void {
  // iOS gates devicemotion behind a permission prompt tied to a gesture;
  // Android (app + web) fires freely. Degrade silently where unavailable —
  // the app simply stays portrait-rendered.
  if (typeof DeviceMotionEvent === "undefined") return;
  const req = (
    DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<string>;
    }
  ).requestPermission;
  if (req) {
    // ask on the first user tap (a gesture is required)
    const onFirstTap = () => {
      window.removeEventListener("pointerdown", onFirstTap);
      void req.call(DeviceMotionEvent).then((state) => {
        if (state === "granted") {
          window.addEventListener("devicemotion", (e) => {
            motionSeen = true;
            onMotion(e);
          });
        }
      }).catch(() => {});
    };
    window.addEventListener("pointerdown", onFirstTap);
    return;
  }
  window.addEventListener("devicemotion", (e) => {
    motionSeen = true;
    onMotion(e);
  });
}
