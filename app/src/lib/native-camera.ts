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

const ATTEMPT = "gpscam-native-attempt";

/**
 * Is the experimental native preview switched on?
 *
 * SELF-DISABLING. An experimental switch that can crash the app must not
 * be able to trap the user: the flag lives in storage, so a crash on
 * startup would crash again on every relaunch, with Settings unreachable.
 * Each attempt writes a marker that is cleared once the app has survived a
 * few seconds. Finding an uncleared marker at boot means the last attempt
 * did not survive — so the flag is switched off automatically and the
 * normal camera comes back.
 */
export function nativeCameraEnabled(): boolean {
  if (!isNativeApp()) return false;
  try {
    if (localStorage.getItem(FLAG) !== "1") return false;
    const pending = localStorage.getItem(ATTEMPT);
    if (pending) {
      // the previous run did not get far enough to clear this
      localStorage.setItem(FLAG, "0");
      localStorage.removeItem(ATTEMPT);
      window.setTimeout(() => {
        window.dispatchEvent(new Event("gpscam:native-camera-recovered"));
      }, 0);
      return false;
    }
    return !!plugin();
  } catch {
    return false;
  }
}

/** Mark an attempt as in progress; cleared once the app is clearly alive. */
export function markNativeAttempt(): void {
  try {
    localStorage.setItem(ATTEMPT, String(Date.now()));
    window.setTimeout(() => {
      try {
        localStorage.removeItem(ATTEMPT);
      } catch {
        // storage gone; nothing to clear
      }
    }, 6000);
  } catch {
    // storage unavailable — the guard simply does not apply
  }
}

/** True if the last run crashed and the flag was turned off for safety. */
export function nativeCameraRecovered(): boolean {
  try {
    return localStorage.getItem(FLAG) === "0" && !!plugin();
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
