/**
 * Backup and restore (§ settings).
 *
 * A reinstall wipes the WebView's IndexedDB, and with it the gallery,
 * the settings, the watermark layout, the profile and the lens
 * calibration. The JPEGs auto-saved to the device gallery survive as
 * files — but nothing in the app knows about them any more.
 *
 * So the backup is deliberately METADATA ONLY: records, tags, settings,
 * watermark, profile and calibration, but no pixels. It stays in the
 * kilobytes, which is what makes it something a user will actually keep
 * in their email or a notes app, and the pixels come back separately by
 * re-reading the photos themselves (see importPhotos.ts) — where every
 * capture already carries its own GPS, time and jurisdiction in EXIF.
 *
 * Records are re-attached to those files by CAPTURE TIME, not by id: a
 * reinstalled app mints new ids, and the timestamp is the one value that
 * is stamped into the JPEG, printed on the card and used for the
 * filename. It is the only thing both halves agree on.
 */
import { listMedia, getMedia, putMedia, kvGet, kvSet } from "./db";
import type { AppSettings, MediaRecord, Profile, WatermarkConfig } from "../types";
import {
  loadLensOverrides,
  loadLensProfile,
  saveLensProfile,
  type Lens,
} from "./camera";
import { useSettingsStore, hydrateSettings } from "../store";

export const BACKUP_FORMAT = "gpscam-backup";
export const BACKUP_VERSION = 1;

const LENS_KEY = "gpscam-lens-factors";

export interface CalibrationBlock {
  /** per-lens zoom factors the user measured or corrected by hand */
  lensOverrides: Record<string, number>;
  /** the discovered rear-camera line-up */
  lensProfile: Lens[];
  /** microphone offset, in dB */
  dbCalibration: number;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: number;
  app?: { versionName?: string; versionCode?: number };
  settings: AppSettings;
  watermark: WatermarkConfig;
  profile: Profile;
  calibration: CalibrationBlock;
  /** every media record, minus its pixels */
  media: MediaRecord[];
}

/**
 * Calibration on its own — the lens factors are measured per PHONE MODEL,
 * so they are worth handing to someone with the same handset who would
 * otherwise have to run the measurement themselves.
 */
export function readCalibration(): CalibrationBlock {
  return {
    lensOverrides: loadLensOverrides(),
    lensProfile: loadLensProfile(),
    dbCalibration: useSettingsStore.getState().settings.dbCalibration ?? 0,
  };
}

export function applyCalibration(cal: Partial<CalibrationBlock> | undefined): void {
  if (!cal) return;
  try {
    if (cal.lensOverrides && typeof cal.lensOverrides === "object") {
      localStorage.setItem(LENS_KEY, JSON.stringify(cal.lensOverrides));
    }
    if (Array.isArray(cal.lensProfile) && cal.lensProfile.length) {
      saveLensProfile(cal.lensProfile);
    }
  } catch {
    // storage unavailable — the app re-measures on next launch
  }
  if (typeof cal.dbCalibration === "number") {
    useSettingsStore.getState().setSettings({ dbCalibration: cal.dbCalibration });
  }
  // the running camera controller caches the line-up; tell it to re-read
  window.dispatchEvent(new Event("gpscam:lenses-updated"));
}

/** Everything worth keeping, as a JSON blob. */
export async function buildBackup(appInfo?: {
  versionName?: string;
  versionCode?: number;
}): Promise<Blob> {
  const st = useSettingsStore.getState();
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    app: appInfo,
    settings: st.settings,
    watermark: st.watermark,
    profile: st.profile,
    calibration: readCalibration(),
    media: await listMedia(),
  };
  return new Blob([JSON.stringify(file, null, 1)], {
    type: "application/json",
  });
}

export function backupFilename(at = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `gpscam-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(
    d.getDate()
  )}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

export class BackupFormatError extends Error {}

export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupFormatError("That file isn't a backup — it isn't valid JSON.");
  }
  const f = parsed as Partial<BackupFile>;
  if (!f || f.format !== BACKUP_FORMAT) {
    throw new BackupFormatError(
      "That file isn't a GPS Camera backup."
    );
  }
  if (typeof f.version !== "number" || f.version > BACKUP_VERSION) {
    throw new BackupFormatError(
      `That backup was written by a newer version of the app (format ${String(
        f.version
      )}). Update the app first.`
    );
  }
  return f as BackupFile;
}

export interface RestoreReport {
  settings: boolean;
  watermark: boolean;
  profile: boolean;
  calibration: boolean;
  /** records written whose pixels are already present */
  mediaRestored: number;
  /** records in the backup with no pixels on this device yet — these come
   *  back when the user re-imports their photos */
  mediaPending: number;
}

/**
 * Apply a backup.
 *
 * Media records are only written when their blobs are actually present
 * (i.e. restoring onto the same install, or after the photos have been
 * re-imported). Writing a record with no pixels would put a permanently
 * broken tile in the grid, so those are reported as pending instead and
 * left for `importPhotos`, which matches them up by capture time.
 */
export async function applyBackup(file: BackupFile): Promise<RestoreReport> {
  const report: RestoreReport = {
    settings: false,
    watermark: false,
    profile: false,
    calibration: false,
    mediaRestored: 0,
    mediaPending: 0,
  };

  if (file.settings) {
    await kvSet("settings", file.settings);
    report.settings = true;
  }
  if (file.watermark) {
    await kvSet("watermark-config", file.watermark);
    report.watermark = true;
  }
  if (file.profile) {
    // hasPhoto refers to a blob this backup does not carry; keep the flag
    // honest rather than pointing the renderer at a missing asset
    const existing = await import("./db").then((m) =>
      m.getBlob("profile", "raw")
    );
    await kvSet("profile", { ...file.profile, hasPhoto: !!existing });
    report.profile = true;
  }
  if (file.calibration) {
    applyCalibration(file.calibration);
    report.calibration = true;
  }

  const { getBlob } = await import("./db");
  for (const rec of file.media ?? []) {
    if (!rec || typeof rec.id !== "string") continue;
    const variant = rec.kind === "photo" ? "final" : "source";
    const has = await getBlob(rec.id, variant);
    if (has) {
      // do not clobber a record that already exists and may be newer
      const cur = await getMedia(rec.id);
      if (!cur) {
        await putMedia(rec);
        report.mediaRestored++;
      }
    } else {
      report.mediaPending++;
    }
  }

  // re-read settings/watermark/profile into the live store
  await hydrateSettings();
  return report;
}

/**
 * The backup's records indexed by capture second — the join key used when
 * re-importing photos. Several photos can share a second, so this maps to
 * a list and importPhotos consumes them in order.
 */
export function indexByCaptureSecond(
  file: BackupFile | null
): Map<number, MediaRecord[]> {
  const m = new Map<number, MediaRecord[]>();
  for (const rec of file?.media ?? []) {
    const t = rec?.data?.timestamp ?? rec?.createdAt;
    if (typeof t !== "number") continue;
    const key = Math.floor(t / 1000);
    const list = m.get(key);
    if (list) list.push(rec);
    else m.set(key, [rec]);
  }
  return m;
}

/** Remember the last imported backup so a later photo import can use it. */
export async function stashPendingBackup(file: BackupFile): Promise<void> {
  await kvSet("pending-backup", file);
}

export async function takePendingBackup(): Promise<BackupFile | null> {
  const f = await kvGet<BackupFile>("pending-backup");
  return f ?? null;
}

export async function clearPendingBackup(): Promise<void> {
  await kvSet("pending-backup", undefined);
}
