/**
 * Keep the blur on the face between detections.
 *
 * Detection is far slower than the screen. Inference runs a few times a
 * second; the viewfinder draws at sixty. Painting the last detected boxes
 * unchanged until the next result means the blur is always showing where
 * a face WAS — up to a third of a second behind it — which is exactly the
 * trailing box people notice, and on a privacy feature it is not a
 * cosmetic problem: the lag is uncovered face.
 *
 * So boxes are carried forward. Each detection is matched to the previous
 * one by overlap, that gives a velocity, and the box is projected to the
 * moment it is actually being drawn. The face keeps moving between
 * frames; so does the box.
 *
 * Everything here is deliberately simple — no Kalman filter, no
 * appearance model. This runs on the main thread of a mid-range phone
 * alongside a 30 fps compositor, and the whole point is to stop stealing
 * time from it.
 */
import type { DetectedBox } from "./faces";

interface Tracked extends DetectedBox {
  /** pixels per millisecond, in source-video space */
  vx: number;
  vy: number;
  seenAt: number;
  /** how many times this face has been seen; 1 means no velocity yet */
  hits: number;
}

/** Beyond this a projection is guesswork, so it stops projecting. A face
 *  that has not been seen for half a second is not tracked, it is gone. */
const MAX_PROJECT_MS = 400;
/** How much of the measured velocity to keep each update. Low, because a
 *  single bad match should nudge the track rather than fling it. */
const VELOCITY_BLEND = 0.7;
/**
 * How far a face may have travelled and still be the same face,
 * as a multiple of its own size.
 *
 * Matching by overlap was the obvious choice and it is wrong here. At a
 * 300 ms cadence a person walking past covers most of their own width
 * between detections, so consecutive boxes barely intersect — a face
 * crossing the frame at 300 px/s overlaps its predecessor by about 5%,
 * far under any sane IoU threshold. Overlap matching therefore fails
 * precisely when there is movement to track, which is the only time any
 * of this matters, and every detection starts a fresh track with zero
 * velocity and no projection.
 *
 * Distance between centres does not have that hole. It is measured
 * against where the track was PREDICTED to be, so a fast face that keeps
 * going is matched more easily than one that jumps.
 */
const MATCH_DISTANCE = 1.6;
/** Detections older than this are dropped even if nothing replaces them,
 *  so a face that leaves the frame does not leave a blur behind. */
const FORGET_MS = 700;

const centre = (b: DetectedBox): [number, number] => [
  b.x + b.width / 2,
  b.y + b.height / 2,
];

export class BoxTracker {
  private tracks: Tracked[] = [];

  /** Feed a fresh detection. `at` is when the FRAME was grabbed, not when
   *  inference finished, or the velocity absorbs the inference time. */
  update(boxes: DetectedBox[], at: number): void {
    // Every (box, track) pair by distance, nearest first, each side used
    // once. Greedy rather than Hungarian: with the handful of faces in a
    // viewfinder the optimal assignment and the greedy one agree, and
    // this has to run beside a 30 fps compositor.
    const pairs: { bi: number; ti: number; d: number }[] = [];
    boxes.forEach((b, bi) => {
      const [bx, by] = centre(b);
      this.tracks.forEach((t, ti) => {
        const dt = Math.min(Math.max(at - t.seenAt, 0), MAX_PROJECT_MS);
        // compare against where the track was HEADED, not where it was
        const [tx, ty] = centre(t);
        const d = Math.hypot(bx - (tx + t.vx * dt), by - (ty + t.vy * dt));
        const gate = Math.max(b.width, b.height) * MATCH_DISTANCE;
        if (d <= gate) pairs.push({ bi, ti, d });
      });
    });
    pairs.sort((a, b) => a.d - b.d);

    const takenBox = new Set<number>();
    const takenTrack = new Set<number>();
    const matched = new Map<number, Tracked>();
    for (const p of pairs) {
      if (takenBox.has(p.bi) || takenTrack.has(p.ti)) continue;
      takenBox.add(p.bi);
      takenTrack.add(p.ti);
      matched.set(p.bi, this.tracks[p.ti]);
    }

    this.tracks = boxes.map((b, bi) => {
      const prev = matched.get(bi);
      const dt = prev ? at - prev.seenAt : 0;
      if (!prev || dt <= 1) return { ...b, vx: 0, vy: 0, seenAt: at, hits: 1 };
      const vx = (b.x - prev.x) / dt;
      const vy = (b.y - prev.y) / dt;
      return {
        ...b,
        vx: prev.vx * (1 - VELOCITY_BLEND) + vx * VELOCITY_BLEND,
        vy: prev.vy * (1 - VELOCITY_BLEND) + vy * VELOCITY_BLEND,
        seenAt: at,
        hits: prev.hits + 1,
      };
    });
  }

  /** Where the boxes are NOW, projected from the last detection. */
  at(now: number): DetectedBox[] {
    const out: DetectedBox[] = [];
    for (const t of this.tracks) {
      const age = now - t.seenAt;
      if (age > FORGET_MS) continue;
      const dt = Math.min(age, MAX_PROJECT_MS);
      const x = t.x + t.vx * dt;
      const y = t.y + t.vy * dt;
      /**
       * Grow the box by the uncertainty in the projection.
       *
       * Projection handles a face that keeps going; it cannot handle one
       * that turns, stops or is newly acquired with no velocity yet. The
       * margin covers that, and it is sized from the track's own speed —
       * a still face keeps a tight box, a fast one gets a generous one.
       *
       * Erring wide is the right way to err. Too much blur costs a little
       * of the picture; too little publishes somebody's face, and in a
       * recording it does so in every frame.
       */
      const size = Math.max(t.width, t.height);
      const speed = Math.hypot(t.vx, t.vy);
      // A face seen once has no velocity to project from, so its box is
      // the least certain one on screen and gets the widest margin — the
      // opposite of what a speed-only formula would give it.
      // Sized to cover a walking pace for one detection interval, which
      // is the whole window in which we know nothing about this face.
      // It is a wide box for a sixth of a second, against leaving a strip
      // of a stranger's face in every frame of a recording.
      const unknown = t.hits < 2 ? size * 0.45 : 0;
      const slack = Math.min(
        speed * dt * 0.6 + size * 0.06 + unknown,
        size * 0.6
      );
      out.push({
        x: x - slack,
        y: y - slack,
        width: t.width + slack * 2,
        height: t.height + slack * 2,
        score: t.score,
      });
    }
    return out;
  }

  clear(): void {
    this.tracks = [];
  }
}
