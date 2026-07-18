/** Share / download helpers for gallery items. */
import { nativeSaveToGallery, nativeShareFile, isNativeApp } from "./native";

function extFor(type: string): string {
  if (type.includes("jpeg")) return "jpg";
  if (type.includes("png")) return "png";
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4")) return "mp4";
  return "bin";
}

export function suggestedName(kind: "photo" | "video", createdAt: number, type: string): string {
  const d = new Date(createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${kind === "photo" ? "IMG" : "VID"}_${stamp}_gpscam.${extFor(type)}`;
}

export async function shareBlob(
  blob: Blob,
  filename: string,
  text?: string
): Promise<"shared" | "downloaded"> {
  // APK: the WebView's navigator.share can't attach files, so use the
  // native ACTION_SEND share sheet (matches the web behaviour of opening
  // a real share target with the file + caption).
  if (isNativeApp()) {
    if (await nativeShareFile(blob, filename, text ?? "")) return "shared";
  }
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
  };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text });
      return "shared";
    } catch {
      // user cancelled or share failed — fall through to download
    }
  }
  downloadBlob(blob, filename);
  return "downloaded";
}

/** Save a file to the device and resolve when the hand-off is complete —
 *  the download queue awaits this so files go out strictly one by one. */
export async function saveBlobToDevice(
  blob: Blob,
  filename: string
): Promise<void> {
  // APK build: <a download> with a blob: URL is a silent no-op inside an
  // Android WebView — route through MediaStore so files land in the
  // device gallery. Falls through to the anchor path in the browser.
  const saved = await nativeSaveToGallery(blob, filename);
  if (saved) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadBlob(blob: Blob, filename: string): void {
  void saveBlobToDevice(blob, filename);
}
