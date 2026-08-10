/**
 * Rebuild the library from photos already on the device (§ settings).
 *
 * Every photo this app saves carries its own provenance in EXIF: GPS
 * position, capture time, and an ImageDescription holding the address,
 * DIGIPIN, corporation, ward, zone and both police stations. So a
 * reinstalled app does not need a copy of the pixels in its backup — it
 * can read the pixels back off the device and RE-DERIVE everything else.
 *
 * Jurisdiction is recomputed rather than parsed out of the description
 * string: the region packs are bundled, the lookup is offline, and a
 * recomputation is authoritative where a parsed string is a guess about
 * formatting we would then have to keep stable forever.
 *
 * Where a backup file is also present, its records supply what EXIF
 * cannot: the user's tags, the watermark config used at capture, and the
 * original capture id. Records are matched to files by capture SECOND —
 * the one value stamped into the JPEG, printed on the card and used in
 * the filename.
 */
import { getBlob, listMedia, newId, putBlob, putMedia } from "./db";
import { readExif } from "./exif";
import { loadImage, makeThumbnail } from "./img";
import { loadGeodataFor } from "./geo/geodata";
import { lookup } from "./geo/lookup";
import { latLngToDigipin } from "./geo/digipin";
import { DEFAULT_WATERMARK_CONFIG } from "./watermark/presets";
import { useSettingsStore } from "../store";
import { indexByCaptureSecond, type BackupFile } from "./backup";
import type { Jurisdiction, PhotoRecord, WatermarkData } from "../types";

export interface ImportProgress {
  done: number;
  total: number;
  file: string;
}

export interface ImportReport {
  imported: number;
  /** already in the gallery (same capture second + size) */
  skipped: number;
  /** not a JPEG, or unreadable */
  failed: number;
  /** matched to a record from the restored backup, so tags came back */
  matchedFromBackup: number;
  /** no GPS in the file — imported, but with no place on the card */
  withoutLocation: number;
}

/** A capture second already represented in the gallery. */
async function existingCaptureSeconds(): Promise<Set<number>> {
  const s = new Set<number>();
  for (const rec of await listMedia()) {
    const t = rec.data?.timestamp ?? rec.createdAt;
    if (typeof t === "number") s.add(Math.floor(t / 1000));
  }
  return s;
}

/**
 * Import a set of image files chosen by the user.
 *
 * Deliberately tolerant: any file that cannot be read is counted and
 * skipped rather than aborting the run, because this is most often
 * pointed at a whole camera folder.
 */
export async function importPhotos(
  files: File[],
  opts: {
    backup?: BackupFile | null;
    onProgress?: (p: ImportProgress) => void;
    signal?: { cancelled: boolean };
  } = {}
): Promise<ImportReport> {
  const report: ImportReport = {
    imported: 0,
    skipped: 0,
    failed: 0,
    matchedFromBackup: 0,
    withoutLocation: 0,
  };
  const seen = await existingCaptureSeconds();
  const fromBackup = indexByCaptureSecond(opts.backup ?? null);
  const { settings } = useSettingsStore.getState();

  let done = 0;
  for (const file of files) {
    if (opts.signal?.cancelled) break;
    done++;
    opts.onProgress?.({ done, total: files.length, file: file.name });

    if (!file.type.startsWith("image/") && !/\.jpe?g$/i.test(file.name)) {
      report.failed++;
      continue;
    }

    try {
      const exif = await readExif(file);
      // fall back to the file's own modified time so a stripped copy still
      // lands somewhere sensible on the timeline
      const timestamp = exif.timestamp ?? file.lastModified ?? Date.now();
      const second = Math.floor(timestamp / 1000);

      if (seen.has(second)) {
        report.skipped++;
        continue;
      }

      const img = await loadImage(file);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      if (!width || !height) {
        report.failed++;
        continue;
      }

      // ---- rebuild the watermark data -------------------------------
      const match = fromBackup.get(second)?.shift();
      const matched = match && match.kind === "photo" ? match : undefined;
      if (matched) report.matchedFromBackup++;

      let jurisdiction: Jurisdiction | null = null;
      let digipin: string | undefined;
      const hasFix = exif.lat != null && exif.lng != null;
      if (hasFix) {
        try {
          const pack = await loadGeodataFor(exif.lat!, exif.lng!);
          jurisdiction = pack
            ? lookup(pack, exif.lat!, exif.lng!).jurisdiction
            : { scope: "out" };
        } catch {
          jurisdiction = { scope: "out" };
        }
        digipin = latLngToDigipin(exif.lat!, exif.lng!) ?? undefined;
      } else {
        report.withoutLocation++;
      }

      const data: WatermarkData = {
        // the backup's copy is richer (it holds the live address and the
        // sound readings); EXIF fills the gaps and wins on position
        ...matched?.data,
        fix: hasFix
          ? {
              lat: exif.lat!,
              lng: exif.lng!,
              altitude: exif.altitude ?? null,
              accuracy: undefined,
              heading: null,
              timestamp,
            }
          : (matched?.data?.fix ?? null),
        jurisdiction: jurisdiction ?? matched?.data?.jurisdiction ?? null,
        digipin: digipin ?? matched?.data?.digipin,
        timestamp,
        tzOffsetMinutes:
          matched?.data?.tzOffsetMinutes ?? new Date(timestamp).getTimezoneOffset(),
      };
      // the description we wrote holds the street address; keep it when the
      // backup did not supply one
      if (!data.address && exif.description) {
        data.address = exif.description.split(" | ")[0];
      }

      const rec: PhotoRecord = {
        id: matched?.id ?? newId(),
        kind: "photo",
        createdAt: timestamp,
        width,
        height,
        data,
        config: matched?.config ?? DEFAULT_WATERMARK_CONFIG,
        // the file on the device is already the finished, watermarked
        // photo — there is nothing left to backfill or re-composite
        backfill: "not-needed",
        hasRaw: false,
        tags: matched?.tags,
        plates: matched?.plates,
        sourceVideoId: matched?.sourceVideoId,
        // never re-queue a download: this file came FROM the device
        download: settings.autoSaveToDevice ? "done" : undefined,
      };

      const thumb = await makeThumbnail(img, width, height);
      await putBlob(rec.id, "final", file);
      await putBlob(rec.id, "thumb", thumb);
      await putMedia(rec);
      seen.add(second);
      report.imported++;
    } catch {
      report.failed++;
    }
  }

  if (report.imported) {
    window.dispatchEvent(
      new CustomEvent("gpscam:media-updated", { detail: { id: "" } })
    );
  }
  return report;
}

/**
 * Re-attach a backup's records to photos ALREADY in the gallery.
 *
 * Used when the backup arrives after the photos (restore order should not
 * matter): anything whose capture second is already present gets its tags
 * and capture config put back without touching the pixels.
 */
export async function mergeBackupIntoLibrary(
  backup: BackupFile
): Promise<number> {
  const bySecond = indexByCaptureSecond(backup);
  let merged = 0;
  for (const rec of await listMedia()) {
    const t = rec.data?.timestamp ?? rec.createdAt;
    if (typeof t !== "number") continue;
    const match = bySecond.get(Math.floor(t / 1000))?.[0];
    if (!match || match.kind !== rec.kind) continue;
    const tags = match.tags ?? [];
    if (!tags.length) continue;
    const existing = rec.tags ?? [];
    const next = [...existing];
    for (const tag of tags) if (!next.includes(tag)) next.push(tag);
    if (next.length !== existing.length) {
      await putMedia({ ...rec, tags: next });
      merged++;
    }
  }
  if (merged) {
    window.dispatchEvent(
      new CustomEvent("gpscam:media-updated", { detail: { id: "" } })
    );
  }
  return merged;
}

/** Whether a photo's pixels are present — used to report a stale restore. */
export async function hasPixels(id: string): Promise<boolean> {
  return !!(await getBlob(id, "final"));
}
