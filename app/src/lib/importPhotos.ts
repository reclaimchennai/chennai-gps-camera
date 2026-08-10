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
import { getBlob, importTombstones, listMedia, newId, putBlob, putMedia } from "./db";
import { readExif } from "./exif";
import { loadImage, makeThumbnail } from "./img";
import { loadGeodataFor } from "./geo/geodata";
import { lookup } from "./geo/lookup";
import { latLngToDigipin } from "./geo/digipin";
import { DEFAULT_WATERMARK_CONFIG } from "./watermark/presets";
import { useSettingsStore } from "../store";
import { indexByCaptureSecond, type BackupFile } from "./backup";
import {
  nativeListMediaFolder,
  nativeReadMediaFile,
  type MediaFolderFile,
} from "./native";
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
 * Capture time straight from the app's own filename, e.g.
 * `IMG_20260807_183241_gpscam.jpg` → that second, local time.
 *
 * This is what makes a folder scan cheap. Deciding whether a photo is
 * already in the gallery costs a filename parse instead of reading and
 * decoding a multi-megabyte JPEG, so a folder of 2,000 photos with
 * nothing new in it does no I/O at all.
 */
export function timestampFromName(name: string): number | null {
  const m = name.match(/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number) as unknown as number[];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) {
    return null;
  }
  const t = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isFinite(t) ? t : null;
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
  for (const t of await importTombstones()) seen.add(t);
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
      // EXIF first; then the app's own filename (IMG_<date>_<time>_gpscam),
      // which survives copying and sharing where EXIF often does not; then
      // the file's modified time so a stripped copy still lands somewhere
      // sensible on the timeline
      const timestamp =
        exif.timestamp ??
        timestampFromName(file.name) ??
        file.lastModified ??
        Date.now();
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

export interface ScanReport extends ImportReport {
  /** files in the folder the scan never had to open */
  alreadyHad: number;
  /** total JPEGs seen in the folder */
  scanned: number;
}

/**
 * Scan the granted device folder and import anything new.
 *
 * Two passes on purpose. First the cheap one: list the folder (metadata
 * only) and drop every file whose filename timestamp is already in the
 * gallery or deliberately deleted. Only what survives is read across the
 * bridge and decoded. Android-only — the browser has no folder grant, so
 * this returns null and the caller offers the file picker instead.
 */
export async function scanMediaFolder(
  opts: {
    backup?: BackupFile | null;
    onProgress?: (p: ImportProgress) => void;
    signal?: { cancelled: boolean };
  } = {}
): Promise<ScanReport | null> {
  const files = await nativeListMediaFolder();
  if (!files) return null;

  const seen = await existingCaptureSeconds();
  for (const t of await importTombstones()) seen.add(t);

  const fresh: MediaFolderFile[] = [];
  let alreadyHad = 0;
  for (const f of files) {
    const t = timestampFromName(f.name);
    // an unparseable name is NOT assumed new or old — it goes through the
    // normal path, where EXIF decides
    if (t != null && seen.has(Math.floor(t / 1000))) {
      alreadyHad++;
      continue;
    }
    fresh.push(f);
  }

  const report: ScanReport = {
    imported: 0,
    skipped: 0,
    failed: 0,
    matchedFromBackup: 0,
    withoutLocation: 0,
    alreadyHad,
    scanned: files.length,
  };
  if (!fresh.length) return report;

  // read them one at a time — a phone should never hold twenty
  // full-resolution JPEGs in memory at once
  let done = 0;
  const batch: File[] = [];
  for (const f of fresh) {
    if (opts.signal?.cancelled) break;
    done++;
    opts.onProgress?.({ done, total: fresh.length, file: f.name });
    const file = await nativeReadMediaFile(f.id, f.name);
    if (!file) {
      report.failed++;
      continue;
    }
    batch.push(file);
    // import in small groups so progress is visible and memory stays flat
    if (batch.length >= 4) {
      const r = await importPhotos(batch.splice(0), { backup: opts.backup });
      report.imported += r.imported;
      report.skipped += r.skipped;
      report.failed += r.failed;
      report.matchedFromBackup += r.matchedFromBackup;
      report.withoutLocation += r.withoutLocation;
    }
  }
  if (batch.length) {
    const r = await importPhotos(batch, { backup: opts.backup });
    report.imported += r.imported;
    report.skipped += r.skipped;
    report.failed += r.failed;
    report.matchedFromBackup += r.matchedFromBackup;
    report.withoutLocation += r.withoutLocation;
  }
  return report;
}
