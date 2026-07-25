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
    // Ask for the highest preview the device will give (ideal 4K, falling
    // back on its own to whatever it supports). A bigger preview is what
    // digital-crop zoom and video recording both draw from, so this is
    // the single biggest lever on zoomed image quality.
    const video: MediaTrackConstraints = {
      facingMode: facing,
      width: { ideal: 3840 },
      height: { ideal: 2160 },
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
    this.activeLens = "main";
    this.mainDeviceId =
      this.stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? null;
    if (this.video) this.video.style.transform = "";
    // discover an ultra-wide sibling lens in the background so pinching
    // out below 1× can hand over to it
    void this.findUltraWide();
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
    const floor = this.ultraWideId ? ULTRA_WIDE_FACTOR : 1;
    if (hw) return { min: Math.min(hw.min, floor), max: hw.max, hardware: true };
    return { min: floor, max: MAX_DIGITAL_ZOOM, hardware: false };
  }

  /**
   * Find a separate ultra-wide rear lens, so pinching out below 1× can
   * switch to it (Android exposes each physical camera as its own
   * deviceId; labels are the only hint, and only after permission).
   * Cheap and cached; silent when the platform hides labels.
   */
  private ultraWideId: string | null = null;
  private mainDeviceId: string | null = null;
  private async findUltraWide(): Promise<void> {
    this.ultraWideId = null;
    try {
      if (this.facing !== "environment") return; // front cams: no UW pair
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput" && d.label);
      const uw = cams.find((d) =>
        /ultra[- ]?wide|wide[- ]?angle|0\.[5-6]|超广角/i.test(d.label)
      );
      if (uw && uw.deviceId !== this.mainDeviceId) this.ultraWideId = uw.deviceId;
    } catch {
      // enumeration blocked — stay at a 1× floor
    }
  }

  /** Switch the running stream to a specific physical camera (lens). */
  private async useDevice(deviceId: string | null): Promise<boolean> {
    try {
      const audio = this.stream?.getAudioTracks()[0];
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? {
              deviceId: { exact: deviceId },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
            }
          : {
              facingMode: this.facing,
              width: { ideal: 3840 },
              height: { ideal: 2160 },
            },
      });
      // swap only the video track, keeping the mic (and the dB meter) alive
      const oldVideo = this.stream?.getVideoTracks() ?? [];
      const newVideo = next.getVideoTracks()[0];
      if (!newVideo) return false;
      const combined = new MediaStream(
        audio ? [newVideo, audio] : [newVideo]
      );
      for (const t of oldVideo) t.stop();
      this.stream = combined;
      if (this.video) {
        this.video.srcObject = combined;
        void this.video.play().catch(() => {});
      }
      this.activeLens = deviceId ? "ultrawide" : "main";
      return true;
    } catch {
      return false;
    }
  }

  private activeLens: "main" | "ultrawide" = "main";
  private lensSwapping = false;

  async setZoom(value: number): Promise<number> {
    const info = this.zoomInfo();
    const clamped = Math.min(info.max, Math.max(info.min, value));

    // Ultra-wide lens hand-off: below ~0.8× switch to the wide camera,
    // back above it return to the main one. Guarded by a swap-in-flight
    // flag so a fast pinch can't fire overlapping getUserMedia calls.
    if (this.ultraWideId && !this.lensSwapping) {
      const wantUltra = clamped < 0.8;
      if (wantUltra && this.activeLens !== "ultrawide") {
        this.lensSwapping = true;
        const ok = await this.useDevice(this.ultraWideId);
        this.lensSwapping = false;
        if (ok) {
          this.digitalZoom = 1;
          this.applyDigitalTransform();
          this.zoomValue = ULTRA_WIDE_FACTOR;
          return this.zoomValue;
        }
      } else if (!wantUltra && this.activeLens === "ultrawide") {
        this.lensSwapping = true;
        const ok = await this.useDevice(null);
        this.lensSwapping = false;
        if (ok) {
          this.digitalZoom = 1;
          this.applyDigitalTransform();
          this.zoomValue = 1;
          return this.zoomValue;
        }
      }
      // while on the ultra-wide lens, 0.6×–1× needs no further change
      if (this.activeLens === "ultrawide" && clamped < 1) {
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
    // digital: crop-scale the preview; capture/record apply the same crop
    this.digitalZoom = clamped;
    this.zoomValue = clamped;
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
