/** Small canvas/blob helpers shared by capture, gallery, and editors. */

/**
 * A canvas as an image file.
 *
 * Large JPEGs and WebPs are encoded on a worker. The WebView's own
 * canvas.toBlob runs the encoder on the page's thread, in slices fitted
 * between frames: on a Galaxy S25 a 12 MP JPEG took 2.5–4.3 s that way —
 * the wait after the tick in the annotation editor — and 265 ms on a
 * worker, the same encoder, byte for byte the same size. Small images,
 * and any browser without OffscreenCanvas, go the old way; so does any
 * encode the worker fails.
 */
export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = 0.92
): Promise<Blob> {
  if (canvas.width * canvas.height >= WORKER_MIN_PIXELS && type !== "image/png") {
    try {
      const b = await encodeOnWorker(canvas, type, quality);
      if (b) return b;
    } catch {
      // the page's own encoder below
    }
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      type,
      quality
    );
  });
}

/** Below about 1 MP the page encodes fast enough on its own. */
const WORKER_MIN_PIXELS = 1_000_000;

const ENCODER_SRC = `
onmessage = async (e) => {
  const { id, bmp, type, quality } = e.data;
  try {
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    oc.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await oc.convertToBlob({ type, quality });
    postMessage({ id, blob });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};`;

let encoder: Worker | null | undefined;
let nextJob = 1;
const jobs = new Map<number, (b: Blob | null) => void>();

function encoderWorker(): Worker | null {
  if (encoder !== undefined) return encoder;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") {
      encoder = null;
      return null;
    }
    const url = URL.createObjectURL(new Blob([ENCODER_SRC], { type: "text/javascript" }));
    encoder = new Worker(url);
    encoder.onmessage = (e: MessageEvent<{ id: number; blob?: Blob }>) => {
      const done = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      done?.(e.data.blob ?? null);
    };
    encoder.onerror = () => {
      // a worker that cannot run here: everything waiting gets the old path
      for (const done of jobs.values()) done(null);
      jobs.clear();
      encoder = null;
    };
  } catch {
    encoder = null;
  }
  return encoder;
}

async function encodeOnWorker(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob | null> {
  const w = encoderWorker();
  if (!w) return null;
  const bmp = await createImageBitmap(canvas);
  const id = nextJob++;
  return new Promise<Blob | null>((resolve) => {
    jobs.set(id, (b) => resolve(b && b.type === type ? b : null));
    w.postMessage({ id, bmp, type, quality }, [bmp]);
  });
}

export async function makeThumbnail(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxEdge = 480
): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, "image/jpeg", 0.8);
}

export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/** Circle-crop an image blob to a square PNG (profile photo, §5.5). */
export async function circleCrop(blob: Blob, size = 256): Promise<Blob> {
  const img = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  const edge = Math.min(img.width, img.height);
  const sx = (img.width - edge) / 2;
  const sy = (img.height - edge) / 2;
  ctx.drawImage(img, sx, sy, edge, edge, 0, 0, size, size);
  img.close();
  return canvasToBlob(canvas, "image/png");
}
