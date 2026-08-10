/**
 * Backup & restore (§ settings).
 *
 * Two halves that are deliberately separate, because they have wildly
 * different sizes: a small metadata file that carries everything the app
 * knows, and the photos themselves, which stay where they already are —
 * in the device's own gallery. Restoring is therefore "load the small
 * file, then point the app at your photos", and the screen walks the user
 * through it in that order rather than making them work it out.
 */
import { useEffect, useRef, useState } from "react";
import {
  Download,
  Upload,
  Images,
  Cpu,
  Check,
  AlertTriangle,
  Loader,
} from "lucide-react";
import { Screen } from "./ui";
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
  type ImportProgress,
  type ImportReport,
} from "../lib/importPhotos";
import { buildModelPack, type ModelPackProgress } from "../lib/modelpack";
import { nativeAppVersion } from "../lib/native";

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

  return (
    <Screen title="Backup & restore">
      {/* hidden pickers — the buttons below drive them */}
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

      {note && (
        <div className={`backup-note ${note.kind}`}>
          {note.kind === "ok" ? <Check size={16} /> : <AlertTriangle size={16} />}
          <span>{note.text}</span>
        </div>
      )}

      {busy && (
        <div className="backup-note ok">
          <Loader size={16} className="spin" />
          <span>
            {busy}
            {progress && progress.total > 1
              ? ` ${progress.done} / ${progress.total}`
              : ""}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-title">Backup</div>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          Saves your settings, watermark layout, profile, camera calibration
          and the details of all {total} item{total === 1 ? "" : "s"} — tags,
          places and times. It does <b>not</b> include the pictures
          themselves, so it stays small enough to keep in an email; the
          pictures come back from your device gallery.
        </p>
        <button
          className="primary-btn"
          style={{ width: "100%" }}
          disabled={!!busy}
          onClick={() => void onBackup()}
        >
          <Download size={17} /> Save a backup file
        </button>
      </div>

      <div className="card">
        <div className="card-title">Restore</div>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          Step 1 — load the backup file. Settings, watermark, profile and
          calibration come back immediately.
        </p>
        <button
          className="ghost-btn"
          style={{ width: "100%" }}
          disabled={!!busy}
          onClick={() => backupInput.current?.click()}
        >
          <Upload size={17} /> Choose backup file
        </button>

        <p className="hint" style={{ margin: "14px 0 10px" }}>
          Step 2 — point the app at your photos. Select everything in{" "}
          <b>DCIM/GPS Camera</b>. Each photo already carries its own location
          and time, so the ward, zone and police stations are worked out again
          on the device — nothing is sent anywhere.
          {pending && (
            <>
              {" "}
              <b>
                A restored backup is waiting, so your tags will be put back
                too.
              </b>
            </>
          )}
        </p>
        <button
          className={pending ? "primary-btn" : "ghost-btn"}
          style={{ width: "100%" }}
          disabled={!!busy}
          onClick={() => photosInput.current?.click()}
        >
          <Images size={17} /> Import photos from this device
        </button>
      </div>

      <div className="card">
        <div className="card-title">Model files</div>
        <p className="hint" style={{ margin: "0 0 10px" }}>
          The face-detection, pose and licence-plate models that run on this
          device, as one archive (~37 MB). They are the same for every
          install and never change — this is for sharing them with someone
          who can't download them, or for a self-hosted copy of the app.
        </p>
        <button
          className="ghost-btn"
          style={{ width: "100%" }}
          disabled={!!busy}
          onClick={() => void onModels()}
        >
          <Cpu size={17} /> Export model files
        </button>
      </div>
    </Screen>
  );
}
