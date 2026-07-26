/**
 * Measure what each rear lens actually sees.
 *
 * Phone brands disagree about everything here: the ultra-wide is 0.5x on
 * most Xiaomi/Redmi/POCO/OnePlus/realme and 0.6x on Samsung; the tele is
 * 2x, 3x, 5x or 10x depending on the model. Android tells web apps none
 * of it — labels are "camera2 N, facing back" and no API reports field of
 * view — so any table of conventions is guaranteed to be wrong on some
 * popular phone, which is exactly how ultra-wide and main ended up
 * swapped in the field.
 *
 * So: don't guess, MEASURE. Grab one frame from the main lens and one
 * from the candidate, then find the centre-crop scale at which the two
 * images line up. That ratio IS the zoom factor, whatever the brand did.
 * Runs once per device in the background and is cached; if the scene is
 * too flat to match confidently the caller keeps its fallback.
 */

const SAMPLE_W = 96;
const SAMPLE_H = 72;
/** Android releases a camera asynchronously after stop(); opening the next
 *  one immediately fails, which made every measurement come back empty in
 *  the APK even on a perfectly detailed scene. */
const RELEASE_MS = 200;

const settle = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** getUserMedia with retries, for the one-camera-at-a-time constraint. */
async function openCamera(deviceId: string): Promise<MediaStream | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: deviceId }, width: { ideal: 640 } },
      });
    } catch {
      await settle(RELEASE_MS * (attempt + 2));
    }
  }
  return null;
}

/** Common factors phones actually print on their own zoom chips. */
const CONVENTIONAL = [0.5, 0.6, 2, 3, 3.5, 5, 10];

/** Snap a measured ratio to the phone-conventional value it is closest
 *  to, so the chip reads ".6x" like the stock camera rather than ".63x". */
export function snapFactor(measured: number): number {
  let best = measured;
  let bestErr = Infinity;
  for (const c of CONVENTIONAL) {
    const err = Math.abs(measured - c) / c;
    if (err < 0.18 && err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  return best === measured ? Math.round(measured * 10) / 10 : best;
}

async function grabGray(deviceId: string): Promise<Float32Array | null> {
  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  try {
    stream = await openCamera(deviceId);
    if (!stream) return null;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    // let auto-exposure settle so the two frames are comparable
    await new Promise((r) => window.setTimeout(r, 450));
    if (!video.videoWidth) return null;
    const c = document.createElement("canvas");
    c.width = SAMPLE_W;
    c.height = SAMPLE_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const out = new Float32Array(SAMPLE_W * SAMPLE_H);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      out[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    }
    return out;
  } catch {
    return null;
  } finally {
    for (const t of stream?.getTracks() ?? []) t.stop();
    video.srcObject = null;
    await settle(RELEASE_MS);
  }
}

/** Draw `deviceId`'s frame centre-cropped by `scale`, as grayscale. */
async function grabGrayCropped(
  deviceId: string,
  scales: number[]
): Promise<Map<number, Float32Array> | null> {
  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  try {
    stream = await openCamera(deviceId);
    if (!stream) return null;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play().catch(() => {});
    await new Promise((r) => window.setTimeout(r, 450));
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw) return null;
    const c = document.createElement("canvas");
    c.width = SAMPLE_W;
    c.height = SAMPLE_H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const out = new Map<number, Float32Array>();
    for (const s of scales) {
      const cw = vw * s;
      const ch = vh * s;
      ctx.drawImage(
        video,
        (vw - cw) / 2,
        (vh - ch) / 2,
        cw,
        ch,
        0,
        0,
        SAMPLE_W,
        SAMPLE_H
      );
      const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      const g = new Float32Array(SAMPLE_W * SAMPLE_H);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      }
      out.set(s, g);
    }
    return out;
  } catch {
    return null;
  } finally {
    for (const t of stream?.getTracks() ?? []) t.stop();
    video.srcObject = null;
    await settle(RELEASE_MS);
  }
}

/** Normalised cross-correlation: 1 = identical framing, 0 = unrelated. */
function ncc(a: Float32Array, b: Float32Array): number {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 1e-6 ? num / den : 0;
}

/**
 * Zoom factor of `otherId` relative to `mainId`, measured optically.
 * <1 means it sees wider than the main lens (ultra-wide), >1 narrower
 * (telephoto). null when the scene was too flat to decide.
 */
export async function measureLensFactor(
  mainId: string,
  otherId: string
): Promise<number | null> {
  const scales = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9];

  // Case A: the other lens is WIDER — the main view appears as a centre
  // crop of it, so find the crop of `other` that matches `main`.
  const mainFull = await grabGray(mainId);
  if (!mainFull) return null;
  const otherCrops = await grabGrayCropped(otherId, scales);
  if (!otherCrops) return null;
  let bestWide = { score: -2, scale: 1 };
  for (const [s, img] of otherCrops) {
    const score = ncc(mainFull, img);
    if (score > bestWide.score) bestWide = { score, scale: s };
  }

  // Case B: the other lens is NARROWER — it appears as a centre crop of
  // the main view.
  const otherFull = await grabGray(otherId);
  if (!otherFull) return null;
  const mainCrops = await grabGrayCropped(mainId, scales);
  if (!mainCrops) return null;
  let bestTele = { score: -2, scale: 1 };
  for (const [s, img] of mainCrops) {
    const score = ncc(otherFull, img);
    if (score > bestTele.score) bestTele = { score, scale: s };
  }

  // A confident match needs real structure in the scene; a blank wall
  // correlates with everything, so demand a decent score AND a clear
  // winner between the two hypotheses.
  const MIN = 0.55;
  if (Math.max(bestWide.score, bestTele.score) < MIN) return null;
  if (bestWide.score >= bestTele.score) {
    // main == other cropped to `scale` → other is 1/scale times wider
    return snapFactor(bestWide.scale);
  }
  return snapFactor(1 / bestTele.scale);
}
