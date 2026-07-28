/**
 * The native camera (CameraX), reached from the web layer.
 *
 * EXPERIMENTAL and off by default. Its purpose right now is to answer one
 * question that no amount of JavaScript can: does this phone's ultra-wide
 * exist behind a zoom ratio the WebView refuses to expose? On a Pixel 9a
 * and a Motorola G84 the WebView offers ONE camera and no zoom range at
 * all, while the hardware plainly has more.
 *
 * While this is on, the native preview owns the camera — Android allows
 * only one holder — so the web viewfinder is stopped and capture is
 * disabled. That is deliberate for this stage: it makes the preview and
 * the reported capabilities testable without touching the photo, video,
 * watermark or gallery paths.
 */

import { isNativeApp } from "./native";

const FLAG = "gpscam-native-camera";

export interface NativeCameraCaps {
  minZoom?: number;
  maxZoom?: number;
  zoom?: number;
  hasFlash?: boolean;
  exposureMin?: number;
  exposureMax?: number;
  exposureStep?: number;
  focusMetering?: boolean;
}

interface NativeCameraPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  start(): Promise<NativeCameraCaps>;
  stop(): Promise<void>;
  getCapabilities(): Promise<NativeCameraCaps>;
  setPreviewRect(r: { x: number; y: number; width: number; height: number }): Promise<void>;
  setZoom(o: { zoom: number }): Promise<void>;
  focusAt(o: { x: number; y: number }): Promise<void>;
  setTorch(o: { on: boolean }): Promise<void>;
  capture(): Promise<{ base64: string }>;
}

function plugin(): NativeCameraPlugin | undefined {
  const cap = (window as unknown as {
    Capacitor?: { Plugins?: Record<string, unknown> };
  }).Capacitor;
  return cap?.Plugins?.NativeCamera as NativeCameraPlugin | undefined;
}

/** Is the experimental native preview switched on? */
export function nativeCameraEnabled(): boolean {
  if (!isNativeApp()) return false;
  try {
    return localStorage.getItem(FLAG) === "1" && !!plugin();
  } catch {
    return false;
  }
}

export function setNativeCameraEnabled(on: boolean): void {
  try {
    localStorage.setItem(FLAG, on ? "1" : "0");
  } catch {
    // storage unavailable — the flag simply does not persist
  }
}

export function nativeCameraSupported(): boolean {
  return isNativeApp() && !!plugin();
}

export async function nativeStart(): Promise<NativeCameraCaps | null> {
  const p = plugin();
  if (!p) return null;
  try {
    return await p.start();
  } catch {
    return null;
  }
}

export async function nativeStop(): Promise<void> {
  try {
    await plugin()?.stop();
  } catch {
    // already stopped
  }
}

/** Keep the native surface aligned with the web viewfinder's rectangle. */
export async function nativeSetRect(el: HTMLElement | null): Promise<void> {
  const p = plugin();
  if (!p || !el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  try {
    await p.setPreviewRect({
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
  } catch {
    // preview not running
  }
}

export async function nativeSetZoom(zoom: number): Promise<void> {
  try {
    await plugin()?.setZoom({ zoom });
  } catch {
    // not running
  }
}

export async function nativeFocusAt(x: number, y: number): Promise<void> {
  try {
    await plugin()?.focusAt({ x, y });
  } catch {
    // not running
  }
}

export async function nativeCapabilities(): Promise<NativeCameraCaps | null> {
  try {
    return (await plugin()?.getCapabilities()) ?? null;
  } catch {
    return null;
  }
}
