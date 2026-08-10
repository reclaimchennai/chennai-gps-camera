/**
 * Backup & restore (§ settings → advanced).
 *
 * Two halves with wildly different sizes: a small metadata file carrying
 * everything the app knows, and the photos, which stay where they already
 * are — in the device's own gallery. So restoring is "load the small file,
 * then let the app re-read your photos".
 *
 * This is a REPAIR tool, not a sync service. Photos taken from here on are
 * written to the gallery and to the app's own store at capture time, so
 * there is nothing to watch for: recovery only matters after a reinstall,
 * or when photos arrive from another device. The screen says exactly that,
 * because an earlier draft claiming to be "watching" a folder read as an
 * ongoing background job that does not exist.
 *
 * Kept to plain Rows rather than prose-and-buttons: this screen is reached
 * from Settings and should look and behave like the rest of it.
 */
import { useEffect, useRef, useState } from "react";
import { Check, AlertTriangle, Loader } from "lucide-react";
import { Row, Screen } from "./ui";
import { shareBlob } from "../lib/share";
import { listMedia } from "../lib/db";
import {
  applyBackup,
  backupFilename,
  buildBackup,
  clearPendingBackup,
  parseBackup,
  stashPendingBackup,
  takePendingBackup,
  BackupFormatError,
  type BackupFile,
  type RestoreReport,
} from "../lib/backup";
import {
  importPhotos,
  mergeBackupIntoLibrary,
  scanMediaFolder,
  type ImportProgress,
  type ImportReport,
} from "../lib/importPhotos";
import { buildModelPack, type ModelPackProgress } from "../lib/modelpack";
import {
  isNativeApp,
  nativeAppVersion,
  nativeForgetMediaFolder,
  nativeMediaFolder,
  nativePickMediaFolder,
} from "../lib/native";

const fmtBytes = (n: number) =>
  n > 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function BackupView() {
  const [counts, setCounts] = useState<{ photos: number; videos: number } | null>(
    null
  );
  const [busy, setBusy] = useState<null | string>(null);
  const [note, setNote] = useState<
    | null
    | { kind: "ok" | "warn"; text: string }
  >(null);
  const [restored, setRestored] = useState<RestoreReport | null>(null);
  const [imported, setImported] = useState<ImportReport | null>(null);
  const [progress, setProgress] = useState<ImportProgress | ModelPackProgress | null>(
    null
  );
  const [pending, setPending] = useState<BackupFile | null>(null);
  /** the granted device folder's label, on Android only */
  const [folder, setFolder] = useState<string | null>(null);

  const backupInput = useRef<HTMLInputElement | null>(null);
  const photosInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      const items = await listMedia();
      setCounts({
        photos: items.filter((i) => i.kind === "photo").length,
        videos: items.filter((i) => i.kind === "video").length,
      });
      setPending(await takePendingBackup());
      setFolder(await nativeMediaFolder());
    })();
  }, [restored, imported]);

  // ---- write a backup -------------------------------------------------
  const onBackup = async () => {
    setBusy("Writing backup…");
    setNote(null);
    try {
      const version = await nativeAppVersion();
      const blob = await buildBackup(
        version ? { versionName: version } : undefined
      );
      const name = backupFilename();
      const how = await shareBlob(blob, name, "Chennai GPS Camera backup");
      setNote({
        kind: "ok",
        text:
          how === "shared"
            ? `Backup ready (${fmtBytes(blob.size)}) — pick where to keep it.`
            : `Backup saved as ${name} (${fmtBytes(blob.size)}).`,
      });
    } catch (e) {
      setNote({ kind: "warn", text: `Couldn't write the backup: ${String(e)}` });
    } finally {
      setBusy(null);
    }
  };

  // ---- read a backup --------------------------------------------------
  const onRestoreFile = async (file: File) => {
    setBusy("Restoring…");
    setNote(null);
    try {
      const parsed = parseBackup(await file.text());
      const report = await applyBackup(parsed);
      // photos already on this device get their tags back straight away
      await mergeBackupIntoLibrary(parsed);
      // keep it so a photo import later can still re-attach tags, even
      // after the app is closed and reopened
      await stashPendingBackup(parsed);
      setPending(parsed);
      setRestored(report);
      setNote({
        kind: "ok",
        text: `Settings, watermark, profile and calibration restored.${
          report.mediaPending
            ? ` ${report.mediaPending} photo${report.mediaPending === 1 ? "" : "s"} still need their picture files — import them below.`
            : ""
        }`,
      });
    } catch (e) {
      setNote({
        kind: "warn",
        text:
          e instanceof BackupFormatError
            ? e.message
            : `Couldn't read that backup: ${String(e)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  // ---- rebuild the library from the device's photos -------------------
  const onPhotos = async (files: File[]) => {
    if (!files.length) return;
    setBusy("Importing photos…");
    setNote(null);
    setProgress({ done: 0, total: files.length, file: "" });
    try {
      const report = await importPhotos(files, {
        backup: pending,
        onProgress: setProgress,
      });
      setImported(report);
      const bits = [`${report.imported} imported`];
      if (report.skipped) bits.push(`${report.skipped} already here`);
      if (report.matchedFromBackup)
        bits.push(`${report.matchedFromBackup} matched to your backup`);
      if (report.withoutLocation)
        bits.push(`${report.withoutLocation} had no GPS`);
      if (report.failed) bits.push(`${report.failed} unreadable`);
      setNote({ kind: report.imported ? "ok" : "warn", text: bits.join(" · ") });
      if (report.imported && pending) await clearPendingBackup();
    } catch (e) {
      setNote({ kind: "warn", text: `Import failed: ${String(e)}` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  // ---- scan the granted device folder ---------------------------------
  const onScan = async (grantFirst: boolean) => {
    setNote(null);
    let label = folder;
    if (grantFirst || !label) {
      label = await nativePickMediaFolder();
      setFolder(label);
      if (!label) {
        setNote({
          kind: "warn",
          text: "No folder chosen — nothing was scanned.",
        });
        return;
      }
    }
    setBusy("Scanning your photos…");
    setProgress(null);
    try {
      const report = await scanMediaFolder({
        backup: pending,
        onProgress: setProgress,
      });
      if (!report) {
        setNote({ kind: "warn", text: "Couldn't read that folder." });
        return;
      }
      setImported(report);
      const bits: string[] = [];
      bits.push(`${report.imported} imported`);
      if (report.alreadyHad) bits.push(`${report.alreadyHad} already here`);
      if (report.matchedFromBackup)
        bits.push(`${report.matchedFromBackup} matched to your backup`);
      if (report.failed) bits.push(`${report.failed} unreadable`);
      setNote({
        kind: "ok",
        text: `Scanned ${report.scanned} photo${report.scanned === 1 ? "" : "s"} — ${bits.join(" · ")}.`,
      });
      if (report.imported && pending) await clearPendingBackup();
    } catch (e) {
      setNote({ kind: "warn", text: `Scan failed: ${String(e)}` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  // ---- model pack -----------------------------------------------------
  const onModels = async () => {
    setBusy("Packing model files…");
    setNote(null);
    setProgress(null);
    try {
      const { blob, missing } = await buildModelPack(setProgress);
      const how = await shareBlob(
        blob,
        "gpscam-models.zip",
        "Chennai GPS Camera — on-device model files"
      );
      setNote({
        kind: missing.length ? "warn" : "ok",
        text:
          `Model pack ${how === "shared" ? "ready" : "saved"} (${fmtBytes(blob.size)}).` +
          (missing.length ? ` ${missing.length} file(s) unavailable in this build.` : ""),
      });
    } catch (e) {
      setNote({ kind: "warn", text: `Couldn't build the pack: ${String(e)}` });
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const total = (counts?.photos ?? 0) + (counts?.videos ?? 0);
  const native = isNativeApp();

  return (
    <Screen title="Backup & restore">
      {/* hidden pickers — the rows below drive them */}
      <input
        ref={backupInput}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onRestoreFile(f);
        }}
      />
      <input
        ref={photosInput}
        type="file"
        accept="image/jpeg,image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void onPhotos(files);
        }}
      />

      {(busy || note) && (
        <div className={`backup-note ${busy ? "ok" : note!.kind}`}>
          {busy ? (
            <Loader size={16} className="spin" />
          ) : note!.kind === "ok" ? (
            <Check size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>
            {busy
              ? `${busy}${progress && progress.total > 1 ? ` ${progress.done} / ${progress.total}` : ""}`
              : note!.text}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-title">Backup</div>
        <Row
          label="Save a backup file"
          hint={`Settings, watermark, profile, calibration and the tags and places of ${total} item${total === 1 ? "" : "s"}. Not the pictures — those stay in your gallery.`}
          onClick={busy ? undefined : () => void onBackup()}
        />
      </div>

      <div className="card">
        <div className="card-title">Restore</div>
        <Row
          label="Load a backup file"
          hint="Brings back settings, watermark, profile, calibration and tags"
          onClick={busy ? undefined : () => backupInput.current?.click()}
        />
        {native ? (
          <>
            <Row
              label={folder ? "Recover photos" : "Recover photos from this device"}
              hint={
                folder
                  ? `Reads ${folder} and adds anything missing`
                  : "Pick the folder your photos are saved in — that one folder only, no photo permission"
              }
              onClick={busy ? undefined : () => void onScan(!folder)}
            />
            {folder && (
              <Row
                label="Change folder"
                hint={folder}
                onClick={
                  busy
                    ? undefined
                    : () => void nativeForgetMediaFolder().then(() => setFolder(null))
                }
              />
            )}
          </>
        ) : (
          <Row
            label="Recover photos from this device"
            hint="Select your saved photos — in a browser they are in your Downloads folder"
            onClick={busy ? undefined : () => photosInput.current?.click()}
          />
        )}
        <div className="card-note">
          Only needed after a reinstall, or for photos copied from another
          device — new photos are added automatically as you take them.
        </div>
      </div>

      <div className="card">
        <div className="card-title">Model files</div>
        <Row
          label="Export model files"
          hint="37 MB — the face, pose and plate models that run on this device. Identical for every install; for sharing offline or self-hosting."
          onClick={busy ? undefined : () => void onModels()}
        />
      </div>
    </Screen>
  );
}
