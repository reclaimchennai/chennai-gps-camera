/**
 * Long-press to start selecting (§ gallery).
 *
 * The gallery's hold gesture enters selection mode; the collage and poster
 * pickers use `usePeek` instead, where a hold previews the photo. Both hold
 * gestures share the same browser quirks, learned the hard way in peek.tsx:
 *
 *  - a long-press makes the browser fire `pointercancel` the moment the
 *    gesture is recognised, so cancel must only ever kill a PENDING timer;
 *  - the `click` that follows the release must be swallowed, or the tap
 *    that ended the hold immediately toggles back off what it just chose;
 *  - the swallow flag has to expire, or the NEXT tap gets eaten too
 *    ("gallery taps randomly dead"). It is cleared on release, giving the
 *    click a short window to arrive and consume it.
 */
import { useCallback, useRef } from "react";

const HOLD_MS = 380;
const MOVE_CANCEL_PX = 12;

export function useLongPress(
  onLongPress: (id: string) => void,
  enabled = true
) {
  const timerRef = useRef(0);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const clearRef = useRef(0);

  const cancel = useCallback(() => {
    window.clearTimeout(timerRef.current);
    startRef.current = null;
  }, []);

  const release = useCallback(() => {
    cancel();
    if (!suppressClickRef.current) return;
    // the click lands a beat after the lift; give it that beat to be
    // swallowed, then stop swallowing so the next tap works normally
    window.clearTimeout(clearRef.current);
    clearRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 350);
  }, [cancel]);

  const bind = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!enabled) return;
      startRef.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        if (!startRef.current) return;
        suppressClickRef.current = true;
        onLongPress(id);
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startRef.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_CANCEL_PX) {
        cancel();
      }
    },
    onPointerUp: release,
    // only the pending timer dies here — see the note above
    onPointerCancel: release,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClickCapture: (e: React.MouseEvent) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  });

  return bind;
}
