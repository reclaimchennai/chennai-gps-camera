/**
 * Long-press "peek" preview: hold a gallery cell to see the full photo
 * (or the playing, muted video); lift the finger and it vanishes. The
 * tap that follows a peek is swallowed so releasing never navigates.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { getBlob } from "../lib/db";
import type { MediaRecord } from "../types";

const HOLD_MS = 380;
const MOVE_CANCEL_PX = 12;

export function usePeek() {
  const [peek, setPeek] = useState<{ rec: MediaRecord; url: string } | null>(
    null
  );
  const timerRef = useRef(0);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const urlRef = useRef<string | null>(null);

  const close = useCallback(() => {
    window.clearTimeout(timerRef.current);
    startRef.current = null;
    setPeek((p) => {
      if (p) {
        // give the browser a beat to stop using the blob URL
        const u = urlRef.current;
        window.setTimeout(() => u && URL.revokeObjectURL(u), 400);
        urlRef.current = null;
      }
      return null;
    });
  }, []);

  // release anywhere (finger may have drifted off the cell) ends the peek
  useEffect(() => {
    if (!peek) return;
    const end = () => close();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [peek, close]);

  const bind = (rec: MediaRecord) => ({
    onPointerDown: (e: React.PointerEvent) => {
      startRef.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void (async () => {
          const blob = await getBlob(
            rec.id,
            rec.kind === "photo" ? "final" : "source"
          );
          if (!blob || !startRef.current) return;
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          suppressClickRef.current = true;
          setPeek({ rec, url });
        })();
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = startRef.current;
      if (
        s &&
        Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_CANCEL_PX
      ) {
        window.clearTimeout(timerRef.current);
        startRef.current = null;
      }
    },
    onPointerUp: () => {
      window.clearTimeout(timerRef.current);
      startRef.current = null;
    },
    onPointerCancel: () => {
      window.clearTimeout(timerRef.current);
      startRef.current = null;
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClickCapture: (e: React.MouseEvent) => {
      // the click right after a peek must not navigate
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
  });

  const layer = peek ? (
    <div className="peek-layer" aria-hidden>
      {peek.rec.kind === "photo" ? (
        <img src={peek.url} alt="" />
      ) : (
        <video src={peek.url} autoPlay muted playsInline loop />
      )}
    </div>
  ) : null;

  return { bind, layer };
}
