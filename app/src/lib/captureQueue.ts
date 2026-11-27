/**
 * Background capture pipeline.
 *
 * The shutter path does the sensor-bound work only (grabFrame) and hands
 * the rest to this queue, which processes one photo at a time off the
 * critical path: blur, watermark, encode, EXIF, thumbnail, IndexedDB
 * write, download scheduling. That lets the user fire the shutter back
 * to back — limited only by how fast the camera can grab a frame — while
 * saving lags behind without ever stalling the UI.
 */
import { processCapture, type CaptureJob, type CaptureResult } from "./capture";

interface Item {
  job: CaptureJob;
  onDone?: (result: CaptureResult) => void;
  onError?: () => void;
  shot: PendingShot;
}

/**
 * A photo taken but not yet in the gallery, for the gallery to show as a
 * placeholder tile.
 *
 * The gallery read its list once, when it opened. In a burst the last
 * photos are still being finished then — one at a time, a second or more
 * each — and they did not appear until the gallery was left and opened
 * again. Now it shows these at once, with the viewfinder's frame from the
 * press, and swaps each for the real photo as it is saved
 * ("gpscam:media-added").
 */
export interface PendingShot {
  key: number;
  at: number;
  /** a small image of the frame at the press, once there is one */
  preview: string | null;
}

let nextKey = 1;
const shots: PendingShot[] = [];
const shotListeners = new Set<(s: PendingShot[]) => void>();

function emitShots(): void {
  const list = shots.slice();
  for (const cb of shotListeners) cb(list);
}

/** Photos still being finished, newest first. */
export function onPendingShots(cb: (s: PendingShot[]) => void): () => void {
  shotListeners.add(cb);
  cb(shots.slice());
  return () => shotListeners.delete(cb);
}

const queue: Item[] = [];
let running = false;

/** Number of photos still being processed (drives the "saving" pulse). */
let pending = 0;
const listeners = new Set<(n: number) => void>();

export function onPendingChange(cb: (n: number) => void): () => void {
  listeners.add(cb);
  cb(pending);
  return () => listeners.delete(cb);
}

function setPending(n: number): void {
  pending = n;
  for (const cb of listeners) cb(n);
}

export function enqueueCapture(
  job: CaptureJob,
  onDone?: (result: CaptureResult) => void,
  onError?: () => void,
  preview?: string | Promise<string | null | undefined> | null
): void {
  const shot: PendingShot = { key: nextKey++, at: Date.now(), preview: null };
  if (typeof preview === "string") shot.preview = preview;
  else if (preview) {
    void preview
      .then((src) => {
        if (!src || !shots.includes(shot)) return;
        shot.preview = src;
        emitShots();
      })
      .catch(() => {});
  }
  shots.unshift(shot);
  emitShots();
  queue.push({ job, onDone, onError, shot });
  setPending(pending + 1);
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        const result = await processCapture(item.job);
        item.onDone?.(result);
        window.dispatchEvent(
          new CustomEvent("gpscam:media-added", { detail: { id: result.record.id } })
        );
      } catch {
        item.onError?.();
      } finally {
        const i = shots.indexOf(item.shot);
        if (i >= 0) shots.splice(i, 1);
        emitShots();
        // release the held frame bitmap-backed canvas ASAP
        item.job.canvas.width = 0;
        item.job.canvas.height = 0;
        setPending(Math.max(0, pending - 1));
      }
      // yield a frame so the viewfinder + animations stay at 60fps
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
  } finally {
    running = false;
  }
}
