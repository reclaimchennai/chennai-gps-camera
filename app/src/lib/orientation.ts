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

let current: UiRotation = 0;
let pending: UiRotation = 0;
let pendingSince = 0;

/** Gravity must dominate the other axis by this factor to count. */
const DOMINANCE = 1.3;
/** ~m/s² of gravity along an axis before we trust it (phone not flat). */
const MIN_G = 4;
/** A new orientation must hold this long before we commit (debounce). */
const HOLD_MS = 250;

function onMotion(e: DeviceMotionEvent): void {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  const ax = Math.abs(g.x);
  const ay = Math.abs(g.y);

  let next: UiRotation;
  if (ax > ay * DOMINANCE && ax > MIN_G) {
    // device x-axis carries gravity → held landscape.
    // x ≈ +g: device turned counter-clockwise → rotate UI +90 (CSS deg);
    // x ≈ -g: turned clockwise → -90.
    next = g.x > 0 ? 90 : -90;
  } else if (ay > ax * DOMINANCE && ay > MIN_G) {
    next = 0; // portrait (or upside down — treated as portrait)
  } else {
    return; // flat / ambiguous — keep whatever we have
  }

  const now = Date.now();
  if (next !== pending) {
    pending = next;
    pendingSince = now;
    return;
  }
  if (next !== current && now - pendingSince >= HOLD_MS) {
    current = next;
    useLiveStore.getState().setUiRotation(next);
  }
}

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
          window.addEventListener("devicemotion", onMotion);
        }
      }).catch(() => {});
    };
    window.addEventListener("pointerdown", onFirstTap);
    return;
  }
  window.addEventListener("devicemotion", onMotion);
}
