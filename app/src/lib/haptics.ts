/**
 * Shutter feedback.
 *
 * A civic photo is often taken one-handed, in a hurry, without looking at
 * the screen — a short buzz is the only confirmation the user gets that
 * the shutter actually fired. One pulse for a photo and for starting a
 * recording; two for stopping one, so start and stop are distinguishable
 * by feel alone.
 *
 * navigator.vibrate is a no-op where the platform or the user has it
 * disabled (iOS Safari, silenced phones, desktop), which is the correct
 * behaviour — never assume it fired.
 */

import { nativeVibrate } from "./native";

function buzz(pattern: number[]): void {
  // Native first: navigator.vibrate exists in the Android WebView but does
  // not reliably fire there, even with the VIBRATE permission granted —
  // the shutter gave no feedback at all until this went through the
  // system vibrator instead.
  if (nativeVibrate(pattern)) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // vibration unavailable or blocked — the capture still happened
  }
}

/** One short pulse: a photo, or a recording starting. */
export function hapticTap(): void {
  buzz([0, 35]);
}

/** Two pulses: a recording stopping. */
export function hapticDouble(): void {
  buzz([0, 35, 90, 35]);
}
