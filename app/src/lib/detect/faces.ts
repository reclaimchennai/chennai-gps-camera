/**
 * On-device face detection via MediaPipe Tasks (§5.6).
 *
 * Two detectors, merged:
 *  - BlazeFace (short-range): fast, accurate for frontal faces.
 *  - PoseLandmarker head fallback: BlazeFace misses side-profile faces,
 *    so we also detect body poses and derive a head box from the facial
 *    landmarks (nose/eyes/ears) — this catches people facing sideways.
 *
 * Model + wasm are served from this app's own origin (public/models,
 * public/mediapipe) so detection works offline once cached and no
 * third-party CDN is involved. Detection is best-effort by design —
 * the UI must always let the user add/remove regions manually.
 *
 * Licence plates: no turnkey on-device model exists (§5.6). Manual blur
 * covers plates in v1; an open-source plate detector is a planned
 * follow-up. Copy in the editor reflects this honestly.
 */
import type {
  FaceDetector as FaceDetectorT,
  PoseLandmarker as PoseLandmarkerT,
} from "@mediapipe/tasks-vision";

export interface DetectedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

type Source = HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

let visionPromise: ReturnType<typeof loadVision> | null = null;

async function loadVision() {
  const { FaceDetector, PoseLandmarker, FilesetResolver } = await import(
    "@mediapipe/tasks-vision"
  );
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  return { FaceDetector, PoseLandmarker, fileset };
}

let faceDetectorPromise: Promise<FaceDetectorT | null> | null = null;
let poseLandmarkerPromise: Promise<PoseLandmarkerT | null> | null = null;

function getFaceDetector(): Promise<FaceDetectorT | null> {
  faceDetectorPromise ??= (async () => {
    try {
      visionPromise ??= loadVision();
      const { FaceDetector, fileset } = await visionPromise;
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: "/models/blaze_face_short_range.tflite",
        },
        runningMode: "IMAGE",
        // 0.3: the short-range model scores distant faces low — the IoU
        // dedupe + pose cross-check keep false positives in hand
        minDetectionConfidence: 0.3,
      });
    } catch {
      return null;
    }
  })();
  return faceDetectorPromise;
}

function getPoseLandmarker(): Promise<PoseLandmarkerT | null> {
  poseLandmarkerPromise ??= (async () => {
    try {
      visionPromise ??= loadVision();
      const { PoseLandmarker, fileset } = await visionPromise;
      return await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/pose_landmarker_lite.task" },
        runningMode: "IMAGE",
        numPoses: 5,
        minPoseDetectionConfidence: 0.4,
      });
    } catch {
      return null;
    }
  })();
  return poseLandmarkerPromise;
}

function sourceSize(src: Source): { w: number; h: number } {
  if (src instanceof HTMLVideoElement)
    return { w: src.videoWidth, h: src.videoHeight };
  if (src instanceof HTMLImageElement)
    return { w: src.naturalWidth, h: src.naturalHeight };
  return { w: src.width, h: src.height };
}

function iou(a: DetectedBox, b: DetectedBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** Head box derived from a pose's facial landmarks (0=nose … 10=mouth). */
function headBoxFromPose(
  landmarks: { x: number; y: number; visibility?: number }[],
  w: number,
  h: number
): DetectedBox | null {
  const head = landmarks.slice(0, 11).filter(
    (l) => (l.visibility ?? 1) > 0.35
  );
  if (head.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of head) {
    minX = Math.min(minX, l.x * w);
    maxX = Math.max(maxX, l.x * w);
    minY = Math.min(minY, l.y * h);
    maxY = Math.max(maxY, l.y * h);
  }
  // Landmarks cover only the face centre — expand to the whole head
  // (hair, chin, back of the skull for profiles).
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const span = Math.max(maxX - minX, maxY - minY);
  // Degenerate poses (limbs misread as faces, landmarks scattered across
  // the frame) produce absurd spans — a real head's facial landmarks
  // never cover half the frame. Reject rather than blur the whole scene.
  const maxDim = Math.min(w, h);
  if (span > maxDim * 0.5) return null;
  const size = Math.min(Math.max(span * 2.6, w * 0.04), maxDim * 0.55);
  return {
    x: cx - size / 2,
    y: cy - size / 2 - size * 0.12, // heads extend upward (hair)
    width: size,
    height: size * 1.15,
    score: 0.5,
  };
}

function runDetector(
  detector: FaceDetectorT,
  source: Source,
  offsetX = 0,
  offsetY = 0
): DetectedBox[] {
  const out: DetectedBox[] = [];
  try {
    const res = detector.detect(source);
    for (const d of res.detections) {
      const b = d.boundingBox;
      if (b)
        out.push({
          x: b.originX + offsetX,
          y: b.originY + offsetY,
          width: b.width,
          height: b.height,
          score: 1,
        });
    }
  } catch {
    // this pass failed — others may still contribute
  }
  return out;
}

export interface DetectOptions {
  /** Multi-scale tiled passes catch small/distant faces the single-pass
   *  short-range model misses. Costs ~5 detector runs — used for capture
   *  and editor auto-blur; the live viewfinder uses a single pass. */
  thorough?: boolean;
}

/**
 * Detect faces AND side-profile heads; boxes in source pixel coordinates,
 * clamped to the frame. Returns null when no detector could load at all.
 */
export async function detectFaces(
  source: Source,
  opts: DetectOptions = {}
): Promise<DetectedBox[] | null> {
  const thorough = opts.thorough ?? true;
  const { w, h } = sourceSize(source);
  const boxes: DetectedBox[] = [];
  let anyDetectorRan = false;

  const detector = await getFaceDetector();
  if (detector) {
    anyDetectorRan = true;
    boxes.push(...runDetector(detector, source));

    // multi-scale tiling: the short-range model only sees faces that are
    // reasonably large in ITS input, so distant subjects need zoomed-in
    // passes. Two pyramid levels of overlapping tiles:
    //   - 2×2 at 60% of each dimension  (~1.7× zoom)
    //   - 3×3 at 40% of each dimension  (~2.5× zoom — catches the small,
    //     several-metres-away faces the field reports flagged)
    // Capture/editor only; the live viewfinder stays single-pass.
    if (thorough && Math.max(w, h) >= 512) {
      const tile = document.createElement("canvas");
      const tctx = tile.getContext("2d");
      if (tctx) {
        const levels: number[] = [0.6, 0.4];
        for (const frac of levels) {
          const tw = Math.round(w * frac);
          const th = Math.round(h * frac);
          if (tw < 64 || th < 64) continue;
          tile.width = tw;
          tile.height = th;
          // evenly spaced origins covering the frame with overlap
          const steps = Math.ceil(1 / frac);
          const origins: [number, number][] = [];
          for (let iy = 0; iy < steps; iy++) {
            for (let ix = 0; ix < steps; ix++) {
              const ox = steps === 1 ? 0 : Math.round((ix * (w - tw)) / (steps - 1));
              const oy = steps === 1 ? 0 : Math.round((iy * (h - th)) / (steps - 1));
              origins.push([ox, oy]);
            }
          }
          for (const [ox, oy] of origins) {
            tctx.clearRect(0, 0, tw, th);
            tctx.drawImage(source, ox, oy, tw, th, 0, 0, tw, th);
            for (const b of runDetector(detector, tile, ox, oy)) {
              if (!boxes.some((k) => iou(k, b) > 0.35)) boxes.push(b);
            }
          }
        }
      }
    }
  }

  const pose = await getPoseLandmarker();
  if (pose) {
    anyDetectorRan = true;
    try {
      const res = pose.detect(source);
      for (const lm of res.landmarks) {
        const head = headBoxFromPose(lm, w, h);
        if (!head) continue;
        // skip heads the face detector already covered
        if (boxes.some((b) => iou(b, head) > 0.2)) continue;
        boxes.push(head);
      }
    } catch {
      // ignore — face boxes (if any) still stand
    }
  }

  if (!anyDetectorRan) return null;
  return boxes.map((b) => {
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    return {
      ...b,
      x,
      y,
      width: Math.min(w - x, b.width),
      height: Math.min(h - y, b.height),
    };
  });
}

/** Same detectors reused across video frames (IMAGE mode per-frame);
 *  single-pass — tiling is too heavy at export frame rates. */
export async function detectFacesInFrame(
  canvas: HTMLCanvasElement
): Promise<DetectedBox[]> {
  return (await detectFaces(canvas, { thorough: false })) ?? [];
}
