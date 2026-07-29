/**
 * Device-tier capture quality.
 *
 * India-first constraint (§ "jiffy and snappy"): most users are on
 * mid/low-RAM phones, where a 4K preview stream and 4K video compositing
 * stutter badly — especially once digital zoom CSS-scales that stream and
 * the watermark overlay repaints on top. Photos don't need a huge preview
 * anyway (zoomed captures take the full-sensor ImageCapture path), so the
 * preview is sized for smoothness and the recording is capped per tier.
 *
 * Tier comes from what the platform actually tells us —
 * navigator.deviceMemory (GB, Chromium) and hardwareConcurrency — never a
 * model list, which would rot instantly. Users can override in Settings →
 * Advanced when they know their phone can take more.
 */
import { useSettingsStore } from "../store";

export type QualityPref = "auto" | "720p" | "1080p" | "max";

export interface QualityPlan {
  /** preview stream request (also what recording composites from) */
  previewLongEdge: number;
  /** hard cap on the recorded video's long edge */
  recordLongEdge: number;
  /** video bitrate for the composited recording */
  videoBitsPerSecond: number;
  tier: "low" | "mid" | "high";
}

function detectTier(): "low" | "mid" | "high" {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gb = typeof nav.deviceMemory === "number" ? nav.deviceMemory : 0;
  const cores = navigator.hardwareConcurrency || 0;
  // deviceMemory is bucketed by the browser (0.25/0.5/1/2/4/8) and is the
  // best signal available; cores back it up when memory is hidden.
  if (gb >= 8 || (gb === 0 && cores >= 8)) return "high";
  if (gb >= 4 || (gb === 0 && cores >= 6)) return "mid";
  return "low";
}

let cachedTier: "low" | "mid" | "high" | null = null;

export function qualityPlan(): QualityPlan {
  cachedTier ??= detectTier();
  const pref: QualityPref =
    (useSettingsStore.getState().settings.captureQuality as QualityPref) ??
    "auto";

  if (pref === "720p") {
    return {
      previewLongEdge: 1280,
      recordLongEdge: 1280,
      videoBitsPerSecond: 4_000_000,
      tier: cachedTier,
    };
  }
  if (pref === "1080p") {
    return {
      previewLongEdge: 1920,
      recordLongEdge: 1920,
      videoBitsPerSecond: 8_000_000,
      tier: cachedTier,
    };
  }
  if (pref === "max") {
    return {
      previewLongEdge: 3840,
      recordLongEdge: 2560,
      videoBitsPerSecond: 14_000_000,
      tier: cachedTier,
    };
  }
  // auto
  switch (cachedTier) {
    case "high":
      return {
        // Preview MATCHES the recording size. It used to ask for 2560
        // while recording 1920, so every frame of a recording was rescaled
        // 1.78x down while being composited — 3.7 MP in, 2.1 MP out, thirty
        // times a second, on top of the watermark render. That uneven work
        // per frame is judder, and judder reads as camera shake: handheld
        // clips came back visibly less steady than the same walk recorded
        // at 720p. Nothing is lost by dropping it — the viewfinder is a
        // phone screen, and stills come from the full sensor either way.
        previewLongEdge: 1920,
        recordLongEdge: 1920,
        videoBitsPerSecond: 10_000_000,
        tier: cachedTier,
      };
    case "mid":
      return {
        previewLongEdge: 1920,
        recordLongEdge: 1920,
        videoBitsPerSecond: 8_000_000,
        tier: cachedTier,
      };
    default:
      return {
        previewLongEdge: 1280,
        recordLongEdge: 1280,
        videoBitsPerSecond: 4_000_000,
        tier: cachedTier,
      };
  }
}

/** Human-readable summary for the Settings row hint. */
export function qualitySummary(): string {
  const p = qualityPlan();
  const tierWord =
    p.tier === "high" ? "high-end" : p.tier === "mid" ? "mid-range" : "entry";
  return `Detected ${tierWord} device. Preview ${p.previewLongEdge}p-class, video capped at ${p.recordLongEdge === 1280 ? "720p" : p.recordLongEdge === 1920 ? "1080p" : "1440p"}.`;
}
