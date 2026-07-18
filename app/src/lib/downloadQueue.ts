/**
 * Deferred device-download queue (§ capture must never wait, files must
 * never ship half-labelled).
 *
 * Photos land in the in-app gallery instantly and the user keeps
 * shooting. The device download of each photo is *queued* until its
 * watermark info is complete — i.e. its backfill has resolved (address
 * baked in, or confirmed not needed / not possible). Ready files are
 * then saved to the device strictly one at a time, in capture order, in
 * the background.
 *
 * Trigger points: after each capture, whenever the backfill queue
 * upgrades a photo (gpscam:media-updated), and once at app start to
 * catch queued items from previous sessions.
 */
import { listMedia, getMedia, putMedia, getBlob } from "./db";
import { saveBlobToDevice, suggestedName } from "./share";
import type { PhotoRecord } from "../types";

let running = false;
let rerun = false;

export function initDownloadQueue(): void {
  window.addEventListener("gpscam:media-updated", () => void run());
  window.setTimeout(() => void run(), 4000); // prior-session leftovers
}

export function scheduleDownloads(): void {
  void run();
}

async function run(): Promise<void> {
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  try {
    let saved = 0;
    do {
      rerun = false;
      const queued = (await listMedia())
        .filter(
          (m): m is PhotoRecord =>
            m.kind === "photo" && m.download === "queued"
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const rec of queued) {
        // re-read: the backfill may have upgraded it while we worked
        const fresh = (await getMedia(rec.id)) as PhotoRecord | undefined;
        if (!fresh || fresh.download !== "queued") continue;
        if (fresh.backfill === "pending") continue; // info still on its way
        const blob = await getBlob(rec.id, "final");
        if (blob) {
          await saveBlobToDevice(
            blob,
            suggestedName("photo", fresh.createdAt, blob.type)
          );
          saved++;
          // polite gap so browsers treat it as an orderly sequence,
          // not a burst of simultaneous downloads
          await new Promise((r) => window.setTimeout(r, 600));
        }
        await putMedia({ ...fresh, download: "done" as const });
      }
    } while (rerun);
    if (saved > 0) {
      window.dispatchEvent(
        new CustomEvent("gpscam:downloads-drained", { detail: { count: saved } })
      );
    }
  } finally {
    running = false;
  }
}
