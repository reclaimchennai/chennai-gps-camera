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
  onError?: () => void
): void {
  queue.push({ job, onDone, onError });
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
      } catch {
        item.onError?.();
      } finally {
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
