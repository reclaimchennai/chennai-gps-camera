/**
 * Camera controller for the PWA build (getUserMedia).
 *
 * Pre-warmed at app launch (§2): start() is called from the root
 * component's first effect, so the viewfinder is live without any
 * intermediate screen. Capture prefers ImageCapture.takePhoto() for
 * full sensor resolution, falling back to grabbing the video frame.
 */

import { isNativeApp } from "./native";
import { preferredAudioConstraints } from "./audio/source";
import { qualityPlan } from "./quality";

export type FacingMode = "environment" | "user";

export interface CameraCapabilitiesLite {
  zoom?: { min: number; max: number; step: number };
  torch: boolean;
  focus: boolean;
}

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>;
}

declare global {
  interface Window {
    ImageCapture?: new (track: MediaStreamTrack) => ImageCaptureLike;
  }
}

/** Zoom capability, unified across hardware (camera-native) and digital
 *  (crop) modes so the UI can present one consistent zoom control. */
export interface ZoomInfo {
  min: number;
  max: number;
  /** true = the camera track zooms natively; false = digital crop. */
  hardware: boolean;
}

const MAX_DIGITAL_ZOOM = 4;
/** Effective zoom factor an ultra-wide lens represents (~0.6× on most
 *  Android phones — matches the ".6" chip Samsung/Pixel cameras show). */
const ULTRA_WIDE_FACTOR = 0.6;
/** Typical telephoto factor when the label doesn't state one (S-series
 *  and most flagships put their tele at 3×). */
const TELEPHOTO_FACTOR = 3;
/** user's per-lens factor corrections, keyed by deviceId */
const LENS_KEY = "gpscam-lens-factors";

/** A physical rear camera the app can switch to. */
export interface Lens {
  deviceId: string;
  label: string;
  /** effective zoom factor relative to the main lens (0.6, 1, 3, …) */
  factor: number;
  isMain: boolean;
}

export function loadLensOverrides(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveLensOverride(deviceId: string, factor: number): void {
  try {
    const all = loadLensOverrides();
    all[deviceId] = factor;
    localStorage.setItem(LENS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — the guess stands for this session
  }
}

/** Sensor pixel count for a camera, or null when it can't be opened. */
async function probeSensorPixels(deviceId: string): Promise<number | null> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: deviceId }, width: { ideal: 320 } },
    });
    const caps = (s.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as Record<
      string,
      unknown
    >;
    for (const t of s.getTracks()) t.stop();
    const w = (caps.width as { max?: number } | undefined)?.max ?? 0;
    const h = (caps.height as { max?: number } | undefined)?.max ?? 0;
    return w && h ? w * h : null;
  } catch {
    return null;
  }
}

export class CameraController {
  stream: MediaStream | null = null;
  facing: FacingMode = "environment";
  private video: HTMLVideoElement | null = null;
  private zoomValue = 1;
  private digitalZoom = 1; // used when the track has no native zoom
  private torchOn = false;

  /**
   * ONE stream serves both photo and video mode, so switching modes is
   * instant (no camera restart), the torch state survives, and the
   * sound meter never has to re-attach. Audio rides along from the
   * start — voice processing disabled so recordings and the dB meter
   * both see the real signal. Stills are unaffected by the 1080p
   * stream: ImageCapture.takePhoto() reads the full sensor.
   */
  async start(facing: FacingMode = this.facing): Promise<MediaStream> {
    this.stop();
    this.facing = facing;
    const baseAudio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    // Prefer a connected external mic; failing that, pin the built-in one so
    // mic-less headphones can't silence the recording (see audio/source.ts).
    const audio = await preferredAudioConstraints(baseAudio);
    // Preview size comes from the device-tier plan, NOT "as big as
    // possible": a 4K preview made digital zoom stutter badly (the video
    // element is CSS-scaled by the zoom factor, so a 4× zoom on 4K is an
    // enormous composite every frame). Zoomed photo quality no longer
    // depends on preview size — those captures take the full-sensor
    // ImageCapture path — so this is purely a smoothness dial.
    const plan = qualityPlan();
    const video: MediaTrackConstraints = {
      facingMode: facing,
      width: { ideal: plan.previewLongEdge },
      height: { ideal: Math.round((plan.previewLongEdge * 9) / 16) },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    } catch {
      try {
        // the exact-device pick may have gone stale (accessory unplugged) —
        // retry letting the OS choose the input before giving up on audio
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: baseAudio,
          video,
        });
      } catch {
        try {
          // mic denied — camera still works, recordings will be silent
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video,
          });
        } catch {
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: facing },
          });
        }
      }
    }
    this.zoomValue = 1;
    this.digitalZoom = 1;
    this.torchOn = false;
    this.activeLensId = null;
    this.mainDeviceId =
      this.stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
    if (this.video) this.video.style.transform = "";
    // discover the phone's other rear lenses in the background so pinch
    // zoom can hand over to real optics
    void this.detectLenses();
    return this.stream;
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
    if (this.stream) {
      video.srcObject = this.stream;
      // play() can reject once during WebView startup (load-interrupt /
      // visibility races). A single swallowed rejection used to leave the
      // viewfinder paused behind Chromium's overlay play button until the
      // user tapped it — retry instead.
      const tryPlay = () => {
        video.play().catch(() => {
          window.setTimeout(() => {
            if (video.srcObject && video.paused) tryPlay();
          }, 400);
        });
      };
      video.onloadedmetadata = tryPlay;
      tryPlay();
    }
  }

  stop(): void {
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
  }

  get track(): MediaStreamTrack | null {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  capabilities(): CameraCapabilitiesLite {
    const caps = (this.track?.getCapabilities?.() ?? {}) as Record<
      string,
      unknown
    >;
    const zoom = caps.zoom as
      | { min: number; max: number; step: number }
      | undefined;
    // min < 1 means the logical camera exposes an ultra-wide range —
    // pinch-out below 1× is supported on those devices. (Switching to a
    // separate ultra-wide deviceId is NOT attempted: the web platform
    // gives no reliable way to identify lenses.)
    return {
      zoom:
        zoom &&
        typeof zoom.max === "number" &&
        (zoom.max > 1 || zoom.min < 1)
          ? zoom
          : undefined,
      torch: Boolean(caps.torch),
      focus: Array.isArray(caps.focusMode),
    };
  }

  /** Unified zoom range. Prefers the camera's native zoom (best quality,
   *  can reach ultra-wide < 1× on phones that expose it); otherwise falls
   *  back to a digital crop zoom, which works on every device — many
   *  Android WebViews simply don't surface the `zoom` track constraint.
   *  When a separate ultra-wide LENS exists, the range extends below 1×
   *  (pinching out past 1× switches to that camera). */
  zoomInfo(): ZoomInfo {
    const hw = this.capabilities().zoom;
    // widest and longest real lenses set the ends of the range; digital
    // crop extends past the longest one
    const factors = this.lenses.map((l) => l.factor);
    const floor = factors.length ? Math.min(1, ...factors) : 1;
    const longest = factors.length ? Math.max(1, ...factors) : 1;
    if (hw) {
      return {
        min: Math.min(hw.min, floor),
        max: Math.max(hw.max, longest * MAX_DIGITAL_ZOOM),
        hardware: true,
      };
    }
    return { min: floor, max: longest * MAX_DIGITAL_ZOOM, hardware: false };
  }

  /**
   * Physical rear lenses (ultra-wide / main / telephoto), so pinch zoom
   * can hand over to real optics instead of cropping pixels.
   *
   * Android exposes each physical camera as its own deviceId, but the
   * labels are only ever "camera2 N, facing back" — they never name the
   * lens, and no web API reports field of view. So: parse what the label
   * DOES give (index + facing), probe each camera's sensor, then apply
   * the near-universal Android convention that back cameras are ordered
   * main, ultra-wide, telephoto. Guesses can be wrong on unusual phones,
   * so Settings lets the user correct any lens's factor, and those
   * overrides win here.
   */
  lenses: Lens[] = [];
  private mainDeviceId: string | null = null;

  private async detectLenses(): Promise<void> {
    this.lenses = [];
    try {
      if (this.facing !== "environment") return;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const backs = devices.filter(
        (d) =>
          d.kind === "videoinput" &&
          !/front|facing front|\buser\b/i.test(d.label ?? "")
      );
      if (backs.length < 2) return; // single logical camera: nothing to switch

      // "camera2 3, facing back" → index 3, for the ordering convention
      const idxOf = (label: string): number => {
        const m = /camera2\s+(\d+)/i.exec(label ?? "");
        return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
      };
      const ordered = [...backs].sort((a, b) => idxOf(a.label) - idxOf(b.label));

      // A label that actually names the lens beats any convention.
      const fromLabel = (label: string): number | null => {
        const l = (label ?? "").toLowerCase();
        const x = /(\d(?:\.\d)?)\s*x/.exec(l);
        if (/ultra|wide.?angle/.test(l)) return ULTRA_WIDE_FACTOR;
        if (/tele/.test(l)) return x ? Number(x[1]) : 3;
        if (x) return Number(x[1]);
        return null;
      };

      const saved = loadLensOverrides();
      const list: Lens[] = [];
      for (let i = 0; i < ordered.length && i < 4; i++) {
        const d = ordered[i];
        const isMain =
          d.deviceId === this.mainDeviceId || (i === 0 && !this.mainDeviceId);
        // convention for extra back cameras: ultra-wide first, then tele
        const conventional = isMain
          ? 1
          : list.some((l) => l.factor < 1)
            ? TELEPHOTO_FACTOR
            : ULTRA_WIDE_FACTOR;
        const factor =
          saved[d.deviceId] ?? fromLabel(d.label) ?? conventional;
        list.push({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
          factor,
          isMain,
        });
      }
      // a phone can report cameras that are not real shooting lenses
      // (depth, macro): drop anything whose sensor is tiny
      const keep: Lens[] = [];
      for (const lens of list) {
        if (lens.isMain) {
          keep.push(lens);
          continue;
        }
        const px = await probeSensorPixels(lens.deviceId);
        if (px === null || px >= 2_000_000) keep.push(lens);
      }
      keep.sort((a, b) => a.factor - b.factor);
      this.lenses = keep.length > 1 ? keep : [];
    } catch {
      this.lenses = [];
    }
  }

  /** Zoom stops the UI can offer (one per real lens, plus 2× digital). */
  zoomStops(): number[] {
    const info = this.zoomInfo();
    const stops = new Set<number>();
    for (const l of this.lenses) stops.add(l.factor);
    stops.add(1);
    if (info.max >= 2) stops.add(2);
    return [...stops].filter((z) => z >= info.min && z <= info.max).sort((a, b) => a - b);
  }

  /** The lens that natively covers a target zoom factor. */
  private lensFor(factor: number): Lens | null {
    if (!this.lenses.length) return null;
    // the widest lens whose factor is <= target (so the rest is a crop in)
    let best: Lens | null = null;
    for (const l of this.lenses) {
      if (l.factor <= factor + 1e-6 && (!best || l.factor > best.factor)) best = l;
    }
    return best ?? this.lenses[0];
  }

  /** Switch the running stream to a specific physical camera (lens). */
  /**
   * Switch the running stream to a specific physical camera (lens).
   *
   * CRITICAL on Android: only ONE camera may be open at a time. Opening
   * the new lens while the old track is still live fails (NotReadable /
   * Overconstrained), which is why lens switching silently did nothing —
   * the caller then fell back to a digital "zoom" that scaled the preview
   * DOWN, shrinking the viewfinder into a small rectangle instead of
   * showing a wider view. So: release the current video track FIRST, then
   * open the new one, and if that fails, reopen what we had so the user is
   * never left with a dead viewfinder.
   */
  private async useDevice(deviceId: string | null): Promise<boolean> {
    const audio = this.stream?.getAudioTracks()[0] ?? null;
    const previous = this.activeLensId;
    const wanted = (id: string | null): MediaTrackConstraints =>
      id
        ? {
            deviceId: { exact: id },
            width: { ideal: qualityPlan().previewLongEdge },
          }
        : {
            facingMode: this.facing,
            width: { ideal: qualityPlan().previewLongEdge },
          };

    // free the camera before asking for another one
    for (const t of this.stream?.getVideoTracks() ?? []) t.stop();

    const open = async (id: string | null): Promise<MediaStreamTrack | null> => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: wanted(id),
        });
        return s.getVideoTracks()[0] ?? null;
      } catch {
        return null;
      }
    };

    let track = await open(deviceId);
    let landedOn = deviceId;
    if (!track) {
      // couldn't get the requested lens — restore the previous one
      track = await open(previous);
      landedOn = previous;
      if (!track) {
        track = await open(null);
        landedOn = null;
      }
      if (!track) return false;
      this.attachStream(track, audio, landedOn);
      return false; // restored, but the requested switch did not happen
    }
    this.attachStream(track, audio, landedOn);
    return true;
  }

  private attachStream(
    videoTrack: MediaStreamTrack,
    audio: MediaStreamTrack | null,
    lensId: string | null
  ): void {
    const combined = new MediaStream(
      audio ? [videoTrack, audio] : [videoTrack]
    );
    this.stream = combined;
    if (this.video) {
      this.video.srcObject = combined;
      void this.video.play().catch(() => {});
    }
    this.activeLensId = lensId;
  }

  /** deviceId of the lens currently streaming (null = default/main). */
  private activeLensId: string | null = null;
  private lensSwapping = false;
  /** true once a physical lens refused to open on this device */
  lensUnavailable = false;

  /** Zoom factor of the lens currently in use. */
  get activeLensFactor(): number {
    const l = this.lenses.find((x) => x.deviceId === this.activeLensId);
    return l?.factor ?? 1;
  }

  async setZoom(value: number): Promise<number> {
    const info = this.zoomInfo();
    const clamped = Math.min(info.max, Math.max(info.min, value));

    // OPTICAL first: hand over to the physical lens that natively covers
    // this factor (ultra-wide below 1×, telephoto at its factor and up),
    // then crop only the remainder. That is what keeps a 3× shot sharp
    // instead of upscaling a crop of the main sensor. A swap-in-flight
    // flag stops a fast pinch firing overlapping getUserMedia calls.
    if (this.lenses.length > 1 && !this.lensSwapping) {
      const want = this.lensFor(clamped);
      if (want && want.deviceId !== (this.activeLensId ?? this.mainDeviceId)) {
        this.lensSwapping = true;
        const ok = await this.useDevice(want.isMain ? null : want.deviceId);
        this.lensSwapping = false;
        if (ok) {
          this.digitalZoom = Math.max(1, clamped / want.factor);
          this.applyDigitalTransform();
          this.zoomValue = clamped;
          return this.zoomValue;
        }
        // The lens refused to open (some phones simply do not expose their
        // extra cameras to the WebView). Drop it so we stop offering a
        // stop we cannot deliver, and stay at the widest we really have.
        this.lenses = this.lenses.filter((l) => l.deviceId !== want.deviceId);
        this.lensUnavailable = true;
        const floor = this.zoomInfo().min;
        this.digitalZoom = Math.max(1, clamped);
        this.applyDigitalTransform();
        this.zoomValue = Math.max(floor, Math.max(1, clamped));
        return this.zoomValue;
      }
      // already on the right lens: the residual is a digital crop on top
      const base = this.activeLensFactor;
      if (base !== 1) {
        this.digitalZoom = Math.max(1, clamped / base);
        this.applyDigitalTransform();
        this.zoomValue = clamped;
        return this.zoomValue;
      }
    }

    if (info.hardware && this.track) {
      try {
        await this.track.applyConstraints({
          advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
        });
        this.zoomValue = clamped;
      } catch {
        // unsupported after all — ignore
      }
      return this.zoomValue;
    }
    // Digital: crop-scale the preview; capture/record apply the same crop.
    // NEVER below 1 — cropping cannot add field of view, and scaling the
    // video element down just shrank the viewfinder into a small
    // rectangle (exactly what a failed ultra-wide switch used to do).
    this.digitalZoom = Math.max(1, clamped);
    this.zoomValue = this.digitalZoom;
    this.applyDigitalTransform();
    return this.zoomValue;
  }

  /** Scale factor to crop by when capturing/recording (1 = no crop). */
  get captureZoom(): number {
    return this.zoomInfo().hardware ? 1 : this.digitalZoom;
  }

  private applyDigitalTransform(): void {
    if (!this.video) return;
    const z = this.digitalZoom;
    const mirror = this.facing === "user";
    // combine with the front-camera mirror so both survive
    this.video.style.transformOrigin = "center";
    this.video.style.transform = mirror
      ? `scaleX(${-z}) scaleY(${z})`
      : `scale(${z})`;
  }

  get zoom(): number {
    return this.zoomValue;
  }

  async setTorch(on: boolean): Promise<boolean> {
    if (!this.track || !this.capabilities().torch) return false;
    try {
      await this.track.applyConstraints({
        advanced: [{ torch: on } as MediaTrackConstraintSet],
      });
      this.torchOn = on;
      return true;
    } catch {
      return false;
    }
  }

  get torch(): boolean {
    return this.torchOn;
  }

  /** Best-effort tap-to-focus; most browsers silently ignore this. */
  async focusAt(): Promise<void> {
    if (!this.track) return;
    try {
      await this.track.applyConstraints({
        advanced: [
          { focusMode: "single-shot" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // not supported — the tap still shows the focus ring for feedback
    }
  }

  /** Exposure-compensation range/value, when the camera exposes it
   *  (most Android Chromium camera pipelines do). null = hide the slider. */
  exposureInfo(): { min: number; max: number; step: number; value: number } | null {
    const caps = (this.track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const ec = caps.exposureCompensation as
      | { min: number; max: number; step: number }
      | undefined;
    if (!ec || typeof ec.min !== "number" || ec.min === ec.max) return null;
    const settings = (this.track?.getSettings?.() ?? {}) as Record<string, unknown>;
    return {
      min: ec.min,
      max: ec.max,
      step: ec.step || 0.1,
      value:
        typeof settings.exposureCompensation === "number"
          ? (settings.exposureCompensation as number)
          : 0,
    };
  }

  /** Samsung-style brightness slider under the focus ring. */
  async setExposure(value: number): Promise<boolean> {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({
        advanced: [
          { exposureCompensation: value } as unknown as MediaTrackConstraintSet,
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** AF lock: freeze the lens at its current position (focusMode manual +
   *  the current focusDistance). Returns false when the device/browser
   *  doesn't support it, so the UI can skip the lock chip honestly. */
  async lockFocus(): Promise<boolean> {
    if (!this.track) return false;
    try {
      const caps = (this.track.getCapabilities?.() ?? {}) as Record<string, unknown>;
      const modes = caps.focusMode as string[] | undefined;
      if (!modes?.includes("manual")) return false;
      const settings = (this.track.getSettings?.() ?? {}) as Record<string, unknown>;
      const fd = settings.focusDistance as number | undefined;
      await this.track.applyConstraints({
        advanced: [
          (fd != null
            ? { focusMode: "manual", focusDistance: fd }
            : { focusMode: "manual" }) as unknown as MediaTrackConstraintSet,
        ],
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Back to continuous autofocus (unlock). */
  async unlockFocus(): Promise<void> {
    if (!this.track) return;
    try {
      await this.track.applyConstraints({
        advanced: [
          { focusMode: "continuous" } as unknown as MediaTrackConstraintSet,
        ],
      });
    } catch {
      // ignore — a camera restart resets focus anyway
    }
  }

  /**
   * Grab a full-resolution frame. Returns an ImageBitmap (fast path for
   * canvas compositing) — never downscaled below the stream resolution.
   */
  async captureFrame(): Promise<ImageBitmap> {
    const track = this.track;
    if (!track) throw new Error("camera not running");
    const video = this.video;

    // Native app at 1× with no digital crop: grab the live preview frame
    // directly — instant, and there is no detail to gain. But when a
    // DIGITAL crop is active, that shortcut is exactly what destroyed
    // zoomed image quality: cropping a 1080p preview at 2× leaves ~540p
    // of real detail, upscaled to full size (blurry, unreadable text).
    // Zoomed digital captures therefore take the full-sensor photo path
    // below, so the crop comes out of a many-megapixel frame instead.
    if (
      isNativeApp() &&
      video &&
      video.readyState >= 2 &&
      this.captureZoom === 1
    ) {
      return await createImageBitmap(video);
    }

    if (window.ImageCapture) {
      try {
        const ic = new window.ImageCapture(track);
        const blob = await ic.takePhoto();
        return await createImageBitmap(blob);
      } catch {
        // fall through to video-frame grab
      }
    }
    if (!video || video.readyState < 2) throw new Error("no frame available");
    return await createImageBitmap(video);
  }
}

export const camera = new CameraController();
