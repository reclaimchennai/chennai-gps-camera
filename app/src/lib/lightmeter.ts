/**
 * Is there enough light here?
 *
 * Auto flash needs an answer to that, and the obvious approach — average
 * the preview's pixels — is close to useless on its own, because the
 * preview is AUTO-EXPOSED. A pitch-dark room and an overcast afternoon
 * both arrive as a mid-grey image; that is the camera's whole job. Judging
 * darkness by pixel brightness measures the exposure algorithm, not the
 * scene.
 *
 * So the sensor's own effort is the primary signal. `iso` and
 * `exposureTime` say how hard the camera is working to produce that
 * mid-grey: a phone outdoors sits near ISO 50 and a very short exposure,
 * and the same phone in a dark lane runs ISO into the thousands with an
 * exposure long enough to blur anything moving. That is exactly the
 * condition where a light helps.
 *
 * Pixel luminance is kept as a fallback, for devices that expose neither,
 * and it is read with a deliberately LOW threshold — only a scene so dark
 * that auto-exposure could not lift it counts, which is the one case
 * where the pixels are still informative.
 */
import { relativeLuminance } from "./watermark/contrast";

export type LightReading = {
  /** true when a light would materially improve the shot */
  dark: boolean;
  /** what the decision was made from, for Diagnostics */
  source: "iso" | "exposure" | "pixels" | "unknown";
  detail: string;
};

/**
 * Thresholds.
 *
 * ISO 800 is about where phone sensors start trading detail for noise;
 * below that a scene is lit well enough that an LED a metre wide adds
 * little. 1/30 s is the point where handheld motion blur becomes likely.
 * Both are deliberately conservative: switching a light on when it was
 * not needed is a mild annoyance, and leaving it off when it was needed
 * loses the photograph.
 */
const ISO_DARK = 800;
const ISO_BRIGHT = 400; // hysteresis: must fall well below to switch off
const EXPOSURE_DARK_S = 1 / 30;
const EXPOSURE_BRIGHT_S = 1 / 90;
/** Mean relative luminance, 0..1. Very low on purpose — see above. */
const PIXELS_DARK = 0.06;
const PIXELS_BRIGHT = 0.16;

/**
 * `exposureTime` is specified in 100-µs units, but implementations have
 * shipped it in seconds and in milliseconds too. Normalise by magnitude
 * rather than trusting the unit: no real still exposure is 200 seconds,
 * and none is 2 nanoseconds.
 */
function exposureSeconds(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const asSpec = raw / 10_000; // 100-µs units
  if (asSpec > 1e-5 && asSpec < 30) return asSpec;
  if (raw > 1e-5 && raw < 30) return raw; // already seconds
  const asMs = raw / 1000;
  if (asMs > 1e-5 && asMs < 30) return asMs;
  return null;
}

let probe: HTMLCanvasElement | null = null;
let probeCtx: CanvasRenderingContext2D | null = null;

/** Mean luminance of the frame, from a 16×9 downscale. */
function framePixels(video: HTMLVideoElement): number | null {
  if (!video.videoWidth || video.readyState < 2) return null;
  try {
    if (!probe || !probeCtx) {
      probe = document.createElement("canvas");
      probe.width = 16;
      probe.height = 9;
      probeCtx = probe.getContext("2d", { willReadFrequently: true });
      if (!probeCtx) return null;
    }
    probeCtx.drawImage(video, 0, 0, 16, 9);
    const { data } = probeCtx.getImageData(0, 0, 16, 9);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += relativeLuminance({ r: data[i], g: data[i + 1], b: data[i + 2] });
      n++;
    }
    return n ? sum / n : null;
  } catch {
    return null;
  }
}

/**
 * Read the scene.
 *
 * `lit` says whether our own light is currently on. It matters: once the
 * LED is burning, every reading describes a scene WE are lighting, so the
 * thresholds move to the bright end of the hysteresis band. Without that
 * the light switches itself off the moment it starts working, and back on
 * the moment it stops — a strobe, not a lamp.
 */
let last: LightReading | null = null;

/**
 * What the meter decided last, for Settings -> Advanced -> Diagnostics.
 *
 * "Auto" is otherwise unfalsifiable from the outside: a user whose light
 * never comes on cannot tell whether the meter judged the scene bright
 * enough or whether their phone reports no exposure data at all, and
 * those need completely different answers.
 */
export function lastLight(): LightReading | null {
  return last;
}

export function readLight(
  track: MediaStreamTrack | null,
  video: HTMLVideoElement | null,
  lit: boolean
): LightReading {
  const s = (track?.getSettings?.() ?? {}) as Record<string, unknown>;
  const record = (r: LightReading): LightReading => {
    last = r;
    return r;
  };

  const iso = typeof s.iso === "number" ? s.iso : null;
  if (iso != null && iso > 0) {
    const limit = lit ? ISO_BRIGHT : ISO_DARK;
    return record({
      dark: iso >= limit,
      source: "iso",
      detail: `ISO ${Math.round(iso)} (needs ${limit})`,
    });
  }

  const exposure =
    typeof s.exposureTime === "number" ? exposureSeconds(s.exposureTime) : null;
  if (exposure != null) {
    const limit = lit ? EXPOSURE_BRIGHT_S : EXPOSURE_DARK_S;
    return record({
      dark: exposure >= limit,
      source: "exposure",
      detail: `1/${Math.round(1 / exposure)} s (needs 1/${Math.round(1 / limit)})`,
    });
  }

  const lum = video ? framePixels(video) : null;
  if (lum != null) {
    const limit = lit ? PIXELS_BRIGHT : PIXELS_DARK;
    return record({
      dark: lum <= limit,
      source: "pixels",
      detail: `luma ${lum.toFixed(3)} (needs ${limit})`,
    });
  }

  // Nothing measurable. Do not guess: an unexplained light is worse than
  // no light, and "auto" that fires blindly is just "on" with extra steps.
  return record({ dark: false, source: "unknown", detail: "no light data on this device" });
}
