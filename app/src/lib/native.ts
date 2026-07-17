/**
 * Bridge to the Android APK build (Capacitor WebView).
 *
 * The web bundle deliberately does NOT import Capacitor — in the browser
 * `window.Capacitor` simply doesn't exist and every helper here is a
 * cheap no-op. Inside the APK, Capacitor injects the bridge and the
 * custom NativeBridge plugin (android/…/NativeBridgePlugin.java) exposes:
 *  - reverseGeocode: android.location.Geocoder with Locale.ENGLISH —
 *    human-readable English addresses straight from the OS, no network
 *    service of ours involved.
 *  - saveToGallery: MediaStore insert, because <a download> with a
 *    blob: URL does nothing inside an Android WebView.
 */

interface NativeBridgePlugin {
  reverseGeocode(opts: { lat: number; lng: number }): Promise<{
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
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { NativeBridge?: NativeBridgePlugin };
}

function cap(): CapacitorGlobal | undefined {
  return (window as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativeApp(): boolean {
  return cap()?.isNativePlatform?.() ?? false;
}

function bridge(): NativeBridgePlugin | undefined {
  return cap()?.Plugins?.NativeBridge;
}

export interface NativeAddress {
  addressLine: string;
  subLocality?: string;
  locality?: string;
  adminArea?: string;
}

/** OS reverse geocode (English). Null in the browser or on failure. */
export async function nativeReverseGeocode(
  lat: number,
  lng: number
): Promise<NativeAddress | null> {
  const b = bridge();
  if (!b) return null;
  try {
    const r = await b.reverseGeocode({ lat, lng });
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
    for (let off = 0; off < blob.size; off += SAVE_CHUNK_BYTES) {
      const base64 = await blobChunkToBase64(
        blob.slice(off, off + SAVE_CHUNK_BYTES)
      );
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
