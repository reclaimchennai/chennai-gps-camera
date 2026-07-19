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

export function queuePlateScan(id: string): void {
  if (!useSettingsStore.getState().settings.plateOcr) return;
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
        await putMedia({ ...cur, plates });
        window.dispatchEvent(
          new CustomEvent("gpscam:media-updated", { detail: { id } })
        );
      } catch {
        // experimental — skip this photo, keep draining
      }
    }
  } finally {
    running = false;
  }
}
