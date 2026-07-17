/**
 * Camera controller for the PWA build (getUserMedia).
 *
 * Pre-warmed at app launch (§2): start() is called from the root
 * component's first effect, so the viewfinder is live without any
 * intermediate screen. Capture prefers ImageCapture.takePhoto() for
 * full sensor resolution, falling back to grabbing the video frame.
 */

import { isNativeApp } from "./native";

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

export class CameraController {
  stream: MediaStream | null = null;
  facing: FacingMode = "environment";
  private video: HTMLVideoElement | null = null;
  private zoomValue = 1;
  private torchOn = false;

  async start(facing: FacingMode = this.facing): Promise<MediaStream> {
    this.stop();
    this.facing = facing;
    // Native WebView: compositing a 4K live preview is what made the APK
    // feel sluggish — cap the *stream* at 1080p there. Stills are
    // unaffected: ImageCapture.takePhoto() reads the full sensor.
    const native = isNativeApp();
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: {
        facingMode: facing,
        width: { ideal: native ? 1920 : 4096 },
        height: { ideal: native ? 1080 : 2160 },
      },
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      // some devices reject the high ideal resolution outright
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing },
      });
    }
    this.zoomValue = 1;
    this.torchOn = false;
    return this.stream;
  }

  /** Re-acquire the stream with audio for video recording. Voice
   *  processing is disabled so the sound meter can tap this same track
   *  for an honest dB reading — opening a *second* mic stream just for
   *  the meter conflicts on Android and silences this recording track. */
  async startWithAudio(): Promise<MediaStream> {
    this.stop();
    const audio: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: {
          facingMode: this.facing,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
    } catch {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facing },
      });
    }
    return this.stream;
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
    if (this.stream) {
      // hidden again until 'playing' fires, so no paused-media overlay
      // flashes during the re-attach (mode switch / camera flip)
      video.classList.remove("playing");
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

  async setZoom(value: number): Promise<number> {
    const caps = this.capabilities();
    if (!caps.zoom || !this.track) return this.zoomValue;
    const clamped = Math.min(caps.zoom.max, Math.max(caps.zoom.min, value));
    try {
      await this.track.applyConstraints({
        advanced: [{ zoom: clamped } as MediaTrackConstraintSet],
      });
      this.zoomValue = clamped;
    } catch {
      // unsupported — ignore
    }
    return this.zoomValue;
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

    // Prefer ImageCapture.takePhoto (full sensor res on Android Chrome).
    if (window.ImageCapture) {
      try {
        const ic = new window.ImageCapture(track);
        const blob = await ic.takePhoto();
        return await createImageBitmap(blob);
      } catch {
        // fall through to video-frame grab
      }
    }
    const video = this.video;
    if (!video || video.readyState < 2) throw new Error("no frame available");
    return await createImageBitmap(video);
  }
}

export const camera = new CameraController();
