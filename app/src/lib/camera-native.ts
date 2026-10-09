/**
 * The native (CameraX) engine behind CameraController.
 *
 * CameraController keeps one public face for the whole app; when it runs
 * on this engine, its zoom, focus, torch, exposure and capture calls are
 * answered here instead of by the WebView's media track. See
 * NativeCameraPlugin.java for why the native camera exists at all.
 */
import {
  deviceRectOf,
  nativeCamera,
  type DeviceRect,
  type NativeCameraInfo,
} from "./nativeCamera";

type Handle = { remove(): Promise<void> | void };

/**
 * How long a start may take before the web camera takes over. Generous:
 * CameraX retries its own start-up for several seconds on phones whose
 * camera list is unusual, and gets there.
 */
const START_TIMEOUT_MS = 10000;
/** How long a stop waits for stills already asked for. */
const CAPTURE_DRAIN_MS = 3000;
/** A tapped zoom chip glides there over this long, like the stock app. */
const ZOOM_GLIDE_MS = 240;
/** The zoom UI never goes past this, whatever the camera allows. */
export const NATIVE_ZOOM_CAP = 10;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      }
    );
  });
}

/** What a focus request came to. */
export type FocusOutcome = "focused" | "not-focused" | "failed";

export class NativeEngine {
  info: NativeCameraInfo | null = null;
  streaming = false;
  zoom = 1;
  torchOn = false;
  /** last measured capture time, for Diagnostics */
  lastCaptureMs: number | null = null;
  private handles: Handle[] = [];
  private lastPoint: { x: number; y: number } | null = null;
  private lastRect = "";
  private glide = 0;
  /** stills asked for and not yet written */
  private inflight = new Set<Promise<unknown>>();

  async start(
    box: Element,
    facing: "environment" | "user",
    maxStill: number
  ): Promise<boolean> {
    const p = nativeCamera();
    if (!p) return false;
    try {
      // listeners before start, so the first "streaming" is not missed
      this.handles.push(
        await p.addListener("stream", (d) => {
          this.streaming = d.streaming === true;
        })
      );
      // the preview moved to another lens (or one refused to open): the
      // ranges and controls are now that camera's
      this.handles.push(
        await p.addListener("lens", (d) => {
          if (!this.info) return;
          Object.assign(this.info, d);
          window.dispatchEvent(
            new CustomEvent("gpscam:native-lens", { detail: { failed: d.failed === true } })
          );
        })
      );
      this.handles.push(
        await p.addListener("zoom", (d) => {
          if (typeof d.zoom === "number") this.zoom = d.zoom;
          if (this.info && typeof d.min === "number" && typeof d.max === "number") {
            this.info.zoomMin = d.min;
            this.info.zoomMax = d.max;
          }
        })
      );
      const rect = deviceRectOf(box);
      this.lastRect = JSON.stringify(rect);
      this.info = await withTimeout(p.start({ facing, rect, maxStill }), START_TIMEOUT_MS);
      this.zoom = this.info.zoom ?? 1;
      this.torchOn = false;
      this.lastPoint = null;
      return true;
    } catch {
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    cancelAnimationFrame(this.glide);
    // A photo taken just before switching to video, or just before the
    // screen changes, must still be written: closing the camera under a
    // capture in flight fails it, and that shot is gone.
    if (this.inflight.size) {
      await Promise.race([
        Promise.allSettled(this.inflight),
        new Promise((r) => window.setTimeout(r, CAPTURE_DRAIN_MS)),
      ]);
    }
    for (const h of this.handles.splice(0)) {
      try {
        await h.remove();
      } catch {
        // already gone
      }
    }
    this.info = null;
    this.streaming = false;
    this.torchOn = false;
    try {
      await nativeCamera()?.stop();
    } catch {
      // nothing running
    }
  }

  /** Keep the preview under the viewfinder box. Cheap to call often: only
   *  an actual move crosses the bridge. */
  syncRect(box: Element): void {
    const rect: DeviceRect = deviceRectOf(box);
    if (rect.width < 2 || rect.height < 2) return; // screen hidden
    const key = JSON.stringify(rect);
    if (key === this.lastRect) return;
    this.lastRect = key;
    void nativeCamera()?.setRect({ rect }).catch(() => {});
  }

  setVisible(visible: boolean): void {
    void nativeCamera()?.setVisible({ visible }).catch(() => {});
  }

  get zoomMin(): number {
    return this.info?.zoomMin ?? 1;
  }

  get zoomMax(): number {
    return Math.min(this.info?.zoomMax ?? 1, NATIVE_ZOOM_CAP);
  }

  private clampZoom(value: number): number {
    return Math.min(this.zoomMax, Math.max(this.zoomMin, value));
  }

  private applyZoom(z: number): void {
    this.zoom = z;
    void nativeCamera()?.setZoom({ ratio: z }).catch(() => {});
  }

  /**
   * Zoom now (a pinch), or glide there (a tapped chip).
   *
   * The glide steps the ratio every frame on a geometric curve, so 1x to
   * 3x looks like a lens moving, not a cut — and on phones whose camera
   * hands over between physical lenses as the ratio passes their
   * boundaries, it crosses them the way the stock app does.
   */
  setZoom(value: number, glide = false): number {
    cancelAnimationFrame(this.glide);
    const to = this.clampZoom(value);
    const from = this.zoom > 0 ? this.zoom : 1;
    if (!glide || Math.abs(to - from) < 0.01) {
      this.applyZoom(to);
      return to;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ZOOM_GLIDE_MS);
      const e = 1 - (1 - k) ** 3; // ease out
      this.applyZoom(k >= 1 ? to : from * (to / from) ** e);
      if (k < 1) this.glide = requestAnimationFrame(step);
    };
    this.glide = requestAnimationFrame(step);
    return to;
  }

  /**
   * Focus and meter at a point (0..1 across the preview as shown — the
   * native view accounts for mirroring and cropping itself). `lock` holds
   * focus and exposure there until cancelled; without a point it locks
   * wherever the last tap aimed, or the centre.
   */
  async focus(point?: { x: number; y: number }, lock = false): Promise<FocusOutcome> {
    const p = nativeCamera();
    if (!p) return "failed";
    const at = point ?? this.lastPoint ?? { x: 0.5, y: 0.5 };
    if (point) this.lastPoint = point;
    try {
      const r = await p.focus({ x: at.x, y: at.y, lock });
      return r.success ? "focused" : "not-focused";
    } catch {
      return "failed";
    }
  }

  async cancelFocus(): Promise<void> {
    try {
      await nativeCamera()?.cancelFocus();
    } catch {
      // nothing to cancel
    }
  }

  async setTorch(on: boolean): Promise<boolean> {
    try {
      const ok = (await nativeCamera()?.setTorch({ on }))?.ok === true;
      if (ok) this.torchOn = on;
      return ok;
    } catch {
      return false;
    }
  }

  /** Exposure compensation in EV, over the device's index range. */
  exposureInfo(): { min: number; max: number; step: number; value: number } | null {
    const i = this.info;
    if (!i || !i.evSupported || i.evMin === i.evMax || !i.evStep) return null;
    return {
      min: i.evMin * i.evStep,
      max: i.evMax * i.evStep,
      step: i.evStep,
      value: i.evIndex * i.evStep,
    };
  }

  async setExposure(ev: number): Promise<boolean> {
    const i = this.info;
    if (!i?.evStep) return false;
    try {
      const r = await nativeCamera()?.setExposure({ index: Math.round(ev / i.evStep) });
      if (r?.ok && typeof r.index === "number") i.evIndex = r.index;
      return r?.ok === true;
    } catch {
      return false;
    }
  }

  /** ISO and shutter time from the running session — for auto flash. */
  async light(): Promise<{ iso?: number; exposureNs?: number }> {
    try {
      return (await nativeCamera()?.light()) ?? {};
    } catch {
      return {};
    }
  }

  /** The viewfinder at this instant as a small JPEG data URL, or "" — for
   *  the fly-to-gallery animation, which must keep pace with the shutter. */
  async snapshot(width: number): Promise<string> {
    try {
      return (await nativeCamera()?.snapshot({ width }))?.dataUrl ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Ask for a full-sensor still, the right way up for how the phone is
   * held. Returns the file the camera wrote; reading it is left to the
   * photo queue, so a burst never holds more than one decoded photo in
   * memory however fast the shutter is pressed.
   */
  async capture(rotation: number): Promise<string> {
    const p = nativeCamera();
    if (!p) throw new Error("native camera unavailable");
    const req = p.capture({ rotation });
    this.inflight.add(req);
    try {
      const r = await req;
      this.lastCaptureMs = r.ms;
      return r.path;
    } finally {
      this.inflight.delete(req);
    }
  }
}
