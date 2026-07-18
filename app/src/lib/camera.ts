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
    const video: MediaTrackConstraints = {
      facingMode: facing,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
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
    if (this.video) this.video.style.transform = "";
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
   *  Android WebViews simply don't surface the `zoom` track constraint. */
  zoomInfo(): ZoomInfo {
    const hw = this.capabilities().zoom;
    if (hw) return { min: hw.min, max: hw.max, hardware: true };
    return { min: 1, max: MAX_DIGITAL_ZOOM, hardware: false };
  }

  async setZoom(value: number): Promise<number> {
    const info = this.zoomInfo();
    const clamped = Math.min(info.max, Math.max(info.min, value));
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

  /**
   * Grab a full-resolution frame. Returns an ImageBitmap (fast path for
   * canvas compositing) — never downscaled below the stream resolution.
   */
  async captureFrame(): Promise<ImageBitmap> {
    const track = this.track;
    if (!track) throw new Error("camera not running");
    const video = this.video;

    // Native app: grab the live preview frame directly. It is already
    // capped at 1080p, so ImageCapture.takePhoto() only adds a slow full
    // capture cycle (re-focus/metering, JPEG decode) for no real quality
    // gain — grabbing the video makes back-to-back shooting instant, the
    // way native camera apps feel. The web build keeps takePhoto for its
    // full-sensor resolution.
    if (isNativeApp() && video && video.readyState >= 2) {
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
