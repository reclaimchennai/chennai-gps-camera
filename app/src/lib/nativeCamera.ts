/**
 * The native camera (CameraX, android/.../NativeCameraPlugin.java), from
 * the web side.
 *
 * Like native.ts, this never imports Capacitor: in the browser the plugin
 * simply is not there and `nativeCameraAvailable()` is false, so the web
 * build carries no native code paths that could run.
 */

export interface NativeCameraInfo {
  zoom: number;
  zoomMin: number;
  zoomMax: number;
  hasFlash: boolean;
  /** zero-shutter-lag stills: the frame of the press, from a ring buffer */
  zsl: boolean;
  evSupported: boolean;
  evMin: number;
  evMax: number;
  evStep: number;
  evIndex: number;
  facing: "environment" | "user";
  /** zoom factor of each physical lens behind the camera (0.6, 3, …) */
  lenses?: number[];
  /** the ultrawide is a separate camera, reached by switching below 1x */
  lensSwitch?: boolean;
  /** the camera the preview is on: "main", or the switched-to lens's id */
  lens?: string;
  /** every camera the phone offers: "id facing factor MP (n lenses)" */
  cameras?: string[];
  stillW?: number;
  stillH?: number;
  previewW?: number;
  previewH?: number;
}

export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ListenerHandle {
  remove(): Promise<void> | void;
}

interface NativeCameraPlugin {
  start(opts: { facing: string; rect: DeviceRect; maxStill: number }): Promise<NativeCameraInfo>;
  stop(): Promise<void>;
  setRect(opts: { rect: DeviceRect }): Promise<void>;
  setVisible(opts: { visible: boolean }): Promise<void>;
  setZoom(opts: { ratio: number }): Promise<{ zoom: number }>;
  focus(opts: { x: number; y: number; lock?: boolean }): Promise<{ success: boolean }>;
  cancelFocus(): Promise<void>;
  setTorch(opts: { on: boolean }): Promise<{ ok: boolean }>;
  setExposure(opts: { index: number }): Promise<{ ok: boolean; index?: number }>;
  light(): Promise<{ iso?: number; exposureNs?: number }>;
  capture(opts: { rotation: number }): Promise<{ path: string; ms: number; zsl: boolean }>;
  release(opts: { path: string }): Promise<void>;
  addListener(
    event: "zoom" | "stream" | "lens",
    cb: (data: Record<string, unknown>) => void
  ): Promise<ListenerHandle> | ListenerHandle;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  convertFileSrc?: (path: string) => string;
  Plugins?: { NativeCamera?: NativeCameraPlugin };
}

function cap(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function nativeCamera(): NativeCameraPlugin | undefined {
  const c = cap();
  return c?.isNativePlatform?.() ? c.Plugins?.NativeCamera : undefined;
}

/** True only inside an APK that ships the CameraX plugin. */
export function nativeCameraAvailable(): boolean {
  return Boolean(nativeCamera());
}

/**
 * Read a still the plugin wrote, as an upright bitmap, and delete the file.
 *
 * The plugin writes a JPEG with an EXIF orientation for how the phone was
 * held; `imageOrientation: "from-image"` applies it, so the bitmap is the
 * right way up without the web layer rotating anything.
 */
export async function readNativeStill(path: string): Promise<ImageBitmap> {
  const c = cap();
  const url = c?.convertFileSrc ? c.convertFileSrc(path) : `file://${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const blob = await res.blob();
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } finally {
    void nativeCamera()?.release({ path });
  }
}

/** A web-layer element's box, in the device pixels the plugin lays out in. */
export function deviceRectOf(el: Element): DeviceRect {
  const r = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * dpr),
    y: Math.round(r.top * dpr),
    width: Math.round(r.width * dpr),
    height: Math.round(r.height * dpr),
  };
}
