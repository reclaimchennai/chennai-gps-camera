/**
 * Bridge to the Android APK build (Capacitor WebView).
 *
 * The web bundle deliberately does NOT import Capacitor — in the browser
 * `window.Capacitor` simply doesn't exist and every helper here is a
 * cheap no-op. Inside the APK, Capacitor injects the bridge and the
 * custom NativeBridge plugin (android/…/NativeBridgePlugin.java) exposes:
 *  - reverseGeocode: android.location.Geocoder in the requested locale —
 *    human-readable English addresses straight from the OS, no network
 *    service of ours involved.
 *  - saveToGallery: MediaStore insert, because <a download> with a
 *    blob: URL does nothing inside an Android WebView.
 */

interface NativeBridgePlugin {
  audioFocus(opts: { hold: boolean }): Promise<{ ok: boolean; holding?: boolean }>;
  reverseGeocode(opts: { lat: number; lng: number; lang?: string }): Promise<{
    ok: boolean;
    addressLine?: string;
    subLocality?: string;
    locality?: string;
    adminArea?: string;
  }>;
  saveToGalleryBegin(opts: {
    filename: string;
    mime: string;
  }): Promise<{ ok: boolean; id?: string }>;
  saveToGalleryChunk(opts: {
    id: string;
    base64: string;
  }): Promise<{ ok: boolean }>;
  saveToGalleryEnd(opts: { id: string }): Promise<{ ok: boolean }>;
  saveToGalleryAbort(opts: { id: string }): Promise<{ ok: boolean }>;
  shareBegin(opts: {
    filename: string;
    mime: string;
  }): Promise<{ ok: boolean; id?: string }>;
  shareChunk(opts: { id: string; base64: string }): Promise<{ ok: boolean }>;
  shareEnd(opts: { id: string; text: string }): Promise<{ ok: boolean }>;
  getAppInfo(): Promise<{
    ok: boolean;
    versionName?: string;
    versionCode?: number;
  }>;
  ensureMediaPermissions(): Promise<{
    camera: boolean;
    microphone: boolean;
    location: boolean;
  }>;
  checkMediaPermissions(): Promise<{
    camera: boolean;
    microphone: boolean;
    location: boolean;
  }>;
  requestCameraPermissions(): Promise<{
    camera: boolean;
    microphone: boolean;
    location: boolean;
  }>;
  requestLocationPermission(): Promise<{
    camera: boolean;
    microphone: boolean;
    location: boolean;
  }>;
  requestLocationNative(): Promise<{ requested: boolean }>;
  checkMockLocation(): Promise<{ mock: boolean }>;
  setShutterKeys(opts: { enabled: boolean }): Promise<void>;
  minimizeApp(): Promise<void>;
  vibrate(opts: { pattern: number[] }): Promise<void>;
}

export interface NativePermStates {
  camera: boolean;
  microphone: boolean;
  location: boolean;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { NativeBridge?: NativeBridgePlugin };
}

function cap(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * Running as an INSTALLED app (Play Store APK, or a PWA added to the home
 * screen) rather than a browser tab.
 *
 * Matters for auto-saving: writing a photo to the device is a browser
 * DOWNLOAD, and Chrome announces every download with its own banner —
 * which the page cannot suppress. In a tab that is reasonable feedback; in
 * something the user installed and uses as a camera, a download banner
 * after every shot is noise.
 */
export function isInstalledApp(): boolean {
  if (isNativeApp()) return true;
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      window.matchMedia?.("(display-mode: fullscreen)").matches ||
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

export function isNativeApp(): boolean {
  return cap()?.isNativePlatform?.() ?? false;
}

function bridge(): NativeBridgePlugin | undefined {
  return cap()?.Plugins?.NativeBridge;
}

/**
 * Volume rocker = shutter, but ONLY while the viewfinder is on screen.
 * Everywhere else (the gallery especially, where it has to set playback
 * volume) the keys must do their normal job. No-op on web and on APKs
 * older than this feature.
 */
export async function setShutterKeys(enabled: boolean): Promise<void> {
  const b = bridge();
  if (!b?.setShutterKeys) return;
  try {
    await b.setShutterKeys({ enabled });
  } catch {
    // older APK without the method — volume keys keep their old behaviour
  }
}

/** Shutter feedback through the system vibrator. No-op off-device. */
export function nativeVibrate(pattern: number[]): boolean {
  const b = bridge();
  if (!b?.vibrate) return false;
  try {
    void b.vibrate({ pattern });
    return true;
  } catch {
    return false;
  }
}

/** Back pressed at the camera root: background the app. */
export async function minimizeNativeApp(): Promise<void> {
  const b = bridge();
  if (!b?.minimizeApp) return;
  try {
    await b.minimizeApp();
  } catch {
    // stay in the app rather than crash a back press
  }
}

/** Permission STATES, never prompting. null on web / old APKs. */
export async function checkNativePermissions(): Promise<NativePermStates | null> {
  const b = bridge();
  if (!b?.checkMediaPermissions) return null;
  try {
    return await b.checkMediaPermissions();
  } catch {
    return null;
  }
}

/**
 * Request Android runtime permissions NATIVELY — the ONLY prompt source
 * on first run, fired from the explicit "Enable camera" gate so nothing
 * races: getUserMedia is never called until this reports camera=true,
 * and MainActivity then answers the WebView's permission relay
 * deterministically. Returns null on web / old APKs.
 */
export async function ensureNativePermissions(): Promise<NativePermStates | null> {
  const b = bridge();
  if (!b?.ensureMediaPermissions) return null;
  try {
    return await b.ensureMediaPermissions();
  } catch {
    return null;
  }
}

/** Step 1 of the split first-run flow: camera + microphone only. */
export async function ensureCameraPermissions(): Promise<NativePermStates | null> {
  const b = bridge();
  if (!b?.requestCameraPermissions) return ensureNativePermissions();
  try {
    return await b.requestCameraPermissions();
  } catch {
    return null;
  }
}

/**
 * Step 2, solo — fired after the camera is already up and stable. Uses
 * the CLASSIC ActivityCompat path (nothing held across the dialog; the
 * grant arrives as a "gpscamLocationGranted" window event), because both
 * the Capacitor launcher path and the WebView geolocation relay crashed
 * devices at the moment of the location grant.
 */
export async function requestLocationPermissionNative(): Promise<void> {
  const b = bridge();
  try {
    if (b?.requestLocationNative) {
      await b.requestLocationNative();
    } else if (b?.requestLocationPermission) {
      // older APK bridge fallback
      await b.requestLocationPermission();
      window.dispatchEvent(new Event("gpscamLocationGranted"));
    }
  } catch {
    // state re-checked on next boot
  }
}

/**
 * Mock-location disclosure: Android reports its own isMock() flag for the
 * last known fix, so a capture made while a fake-GPS app is running can
 * be LABELLED (never blocked). null = unknown (web, or old APK bridge).
 */
export async function nativeMockLocation(): Promise<boolean | null> {
  const b = bridge();
  if (!b?.checkMockLocation) return null;
  try {
    return (await b.checkMockLocation()).mock;
  } catch {
    return null;
  }
}

/** Installed APK version, or null in the browser. */
export async function nativeAppVersion(): Promise<string | null> {
  const b = bridge();
  if (!b) return null;
  try {
    const r = await b.getAppInfo();
    return r.ok && r.versionName
      ? `${r.versionName} (build ${r.versionCode ?? "?"})`
      : null;
  } catch {
    return null;
  }
}

export interface NativeAddress {
  addressLine: string;
  subLocality?: string;
  locality?: string;
  adminArea?: string;
}

/** OS reverse geocode (English). Null in the browser or on failure. */
/**
 * Take or hand back Android audio focus.
 *
 * Releasing the microphone does not resume the user's music — only
 * abandoning focus does, because that is what sends the media app
 * AUDIOFOCUS_GAIN. No-op on the web build.
 */
export async function nativeAudioFocus(hold: boolean): Promise<void> {
  const b = bridge();
  if (!b?.audioFocus) return;
  try {
    await b.audioFocus({ hold });
  } catch {
    // focus is best-effort; never block capture on it
  }
}

export async function nativeReverseGeocode(
  lat: number,
  lng: number,
  lang = "en"
): Promise<NativeAddress | null> {
  const b = bridge();
  if (!b) return null;
  try {
    const r = await b.reverseGeocode({ lat, lng, lang });
    if (!r.ok || !r.addressLine) return null;
    return {
      addressLine: r.addressLine,
      subLocality: r.subLocality,
      locality: r.locality,
      adminArea: r.adminArea,
    };
  } catch {
    return null;
  }
}

// 3 MB binary per bridge message: large enough to amortise call
// overhead, small enough that base64 strings never spike memory
const SAVE_CHUNK_BYTES = 3 * 1024 * 1024;

function blobChunkToBase64(chunk: Blob): Promise<string> {
  return new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => rej(new Error("read failed"));
    fr.readAsDataURL(chunk);
  });
}

/** Share a file through the Android share sheet (ACTION_SEND), streamed
 *  in chunks. Returns false in the browser — callers fall back to the
 *  Web Share API / download. */
export async function nativeShareFile(
  blob: Blob,
  filename: string,
  text: string
): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  let id: string | undefined;
  try {
    const begin = await b.shareBegin({
      filename,
      mime: blob.type || "application/octet-stream",
    });
    if (!begin.ok || !begin.id) return false;
    id = begin.id;
    for (let off = 0; off < blob.size; off += SAVE_CHUNK_BYTES) {
      const base64 = await blobChunkToBase64(
        blob.slice(off, off + SAVE_CHUNK_BYTES)
      );
      const r = await b.shareChunk({ id, base64 });
      if (!r.ok) throw new Error("chunk failed");
    }
    return (await b.shareEnd({ id, text })).ok;
  } catch {
    return false;
  }
}

/** Save a captured file into the device gallery (MediaStore), streamed
 *  in chunks. Returns false in the browser — callers fall back to
 *  <a download>. */
export async function nativeSaveToGallery(
  blob: Blob,
  filename: string
): Promise<boolean> {
  const b = bridge();
  if (!b) return false;
  let id: string | undefined;
  try {
    const begin = await b.saveToGalleryBegin({
      filename,
      mime: blob.type || "application/octet-stream",
    });
    if (!begin.ok || !begin.id) return false;
    id = begin.id;
    // pipeline: encode chunk N+1 while chunk N crosses the bridge
    let nextRead: Promise<string> | null =
      blob.size > 0 ? blobChunkToBase64(blob.slice(0, SAVE_CHUNK_BYTES)) : null;
    for (let off = 0; off < blob.size; off += SAVE_CHUNK_BYTES) {
      const base64 = await nextRead!;
      const following = off + SAVE_CHUNK_BYTES;
      nextRead =
        following < blob.size
          ? blobChunkToBase64(blob.slice(following, following + SAVE_CHUNK_BYTES))
          : null;
      const r = await b.saveToGalleryChunk({ id, base64 });
      if (!r.ok) throw new Error("chunk write failed");
    }
    return (await b.saveToGalleryEnd({ id })).ok;
  } catch {
    if (id) {
      try {
        await b.saveToGalleryAbort({ id });
      } catch {
        // nothing left to clean up
      }
    }
    return false;
  }
}
