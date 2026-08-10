/**
 * Share a whole selection (§ gallery selection mode).
 *
 * Android goes through the native bridge (one ACTION_SEND_MULTIPLE, one
 * chooser). The browser hands the files straight to navigator.share.
 *
 * The caption is decided by shareText.captionForMany: the full civic
 * block when every item is from one place, and count-and-dates only when
 * they are not — captioning a mixed batch with one address would be a
 * false claim about the rest.
 */
import { getBlob } from "./db";
import { isNativeApp, nativeShareFiles } from "./native";
import { suggestedName } from "./share";
import { captionForMany } from "./shareText";
import type { MediaRecord } from "../types";

export type ShareManyResult =
  | { kind: "shared" }
  | { kind: "empty" }
  | { kind: "blocked" } // the browser refused (usually lost user activation)
  | { kind: "failed"; error: string };

async function filesFor(
  recs: MediaRecord[]
): Promise<{ blob: Blob; filename: string }[]> {
  const out: { blob: Blob; filename: string }[] = [];
  for (const rec of recs) {
    // videos may only have their recorded source if never exported
    const blob =
      (await getBlob(rec.id, "final")) ??
      (rec.kind === "video" ? await getBlob(rec.id, "source") : null);
    if (!blob) continue;
    out.push({
      blob,
      filename: suggestedName(rec.kind, rec.createdAt, blob.type),
    });
  }
  return out;
}

export async function shareRecords(
  recs: MediaRecord[]
): Promise<ShareManyResult> {
  if (!recs.length) return { kind: "empty" };
  const text = captionForMany(recs);

  let files: { blob: Blob; filename: string }[];
  try {
    files = await filesFor(recs);
  } catch (e) {
    return { kind: "failed", error: String(e) };
  }
  if (!files.length) return { kind: "empty" };

  if (isNativeApp()) {
    return (await nativeShareFiles(files, text))
      ? { kind: "shared" }
      : { kind: "failed", error: "the share sheet could not be opened" };
  }

  const asFiles = files.map(
    (f) => new File([f.blob], f.filename, { type: f.blob.type || "image/jpeg" })
  );
  const nav = navigator as Navigator & {
    canShare?: (d: ShareData) => boolean;
  };
  if (nav.share) {
    // canShare is a hint only; attempt the share and let the browser
    // refuse if it must (see the note in share.ts)
    const worthTrying = nav.canShare ? nav.canShare({ files: asFiles }) : true;
    if (worthTrying) {
      try {
        await nav.share({ files: asFiles, text });
        return { kind: "shared" };
      } catch (e) {
        // dismissing the sheet is not a failure
        if ((e as { name?: string })?.name === "AbortError") {
          return { kind: "shared" };
        }
        // Reading the files spends the tap's "user activation", and some
        // browsers then reject the share. Say so rather than dumping a
        // pile of downloads the user did not ask for — the blobs are warm
        // now, so an immediate second tap generally succeeds.
        return { kind: "blocked" };
      }
    }
  }
  return { kind: "blocked" };
}
