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

function buzz(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // vibration unavailable or blocked — the capture still happened
  }
}

/** One short pulse: a photo, or a recording starting. */
export function hapticTap(): void {
  buzz(35);
}

/** Two pulses: a recording stopping. */
export function hapticDouble(): void {
  buzz([35, 90, 35]);
}
