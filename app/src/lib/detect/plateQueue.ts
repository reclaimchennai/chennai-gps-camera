/**
 * Background licence-plate scan queue (EXPERIMENTAL).
 *
 * Photos are queued AFTER they're fully saved — OCR never sits on the
 * capture path, so the shutter stays as fast as ever; scans just grind
 * through one at a time behind everything else. Results land on the
 * record's `plates` field and a media-updated event refreshes any open
 * views. Everything is best-effort and silent on failure.
 */
import { getBlob, getMedia, putMedia } from "../db";
import { detectPlates } from "./plates";
import { useSettingsStore } from "../../store";

const q: string[] = [];
let running = false;
// ids whose scan failed THIS session — don't grind the same failure on
// every detail-open; a fresh app launch retries them
const failedThisSession = new Set<string>();

export function queuePlateScan(id: string): void {
  if (!useSettingsStore.getState().settings.plateOcr) return;
  if (failedThisSession.has(id)) return;
  if (!q.includes(id)) q.push(id);
  if (!running) void run();
}

async function run(): Promise<void> {
  running = true;
  try {
    while (q.length) {
      const id = q.shift()!;
      try {
        const rec = await getMedia(id);
        if (!rec || rec.kind !== "photo") continue;
        const blob = await getBlob(id, "final");
        if (!blob) continue;
        const plates = await detectPlates(blob);
        // re-read: the record may have gained tags/backfill meanwhile
        const cur = await getMedia(id);
        if (!cur || cur.kind !== "photo") continue;
        await putMedia({ ...cur, plates, plateScanError: undefined });
        window.dispatchEvent(
          new CustomEvent("gpscam:media-updated", { detail: { id } })
        );
      } catch (e) {
        // engine failure — record WHY so the details sheet can say it,
        // and stop retrying this id for the session
        failedThisSession.add(id);
        try {
          const cur = await getMedia(id);
          if (cur && cur.kind === "photo") {
            await putMedia({
              ...cur,
              plateScanError: String(e).slice(0, 300),
            });
            window.dispatchEvent(
              new CustomEvent("gpscam:media-updated", { detail: { id } })
            );
          }
        } catch {
          // storage also failing — nothing more to do
        }
      }
    }
  } finally {
    running = false;
  }
}
