/**
 * Turn a finished (or recovered) recording into a gallery item and a file
 * on the device. One path for both, so a recording rebuilt after a crash
 * is saved exactly like one that ended normally.
 */
import { newId, putBlob, putMedia } from "../db";
import { makeThumbnail } from "../img";
import { scheduleBackfill } from "../backfill";
import { saveBlobToDevice, suggestedName } from "../share";
import { isNativeApp } from "../native";
import { useSettingsStore } from "../../store";
import { finalizeVideoBlob } from "./postprocess";
import type { VideoRecord, WatermarkConfig, WatermarkData } from "../../types";

export interface SaveRecordingInput {
  raw: Blob;
  durationMs: number;
  createdAt: number;
  data: WatermarkData;
  config: WatermarkConfig;
  width: number;
  height: number;
  liveBlur?: boolean;
  blurBurned?: boolean;
  watermarkBurned?: boolean;
  /** rebuilt from stored chunks after the app stopped mid-recording */
  recovered?: boolean;
  /** live element to take the thumbnail from; decoded from the file if absent */
  thumbFrom?: HTMLVideoElement | null;
}

/** A frame from the file itself — for a recovered recording there is no
 *  live viewfinder to take one from. Bounded: the element streams. */
async function thumbFromFile(blob: Blob): Promise<Blob | null> {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  const url = URL.createObjectURL(blob);
  v.src = url;
  try {
    const ok = await Promise.race([
      new Promise<boolean>((res) => (v.onloadeddata = () => res(true))),
      new Promise<boolean>((res) => (v.onerror = () => res(false))),
      new Promise<boolean>((res) => setTimeout(() => res(false), 8000)),
    ]);
    if (!ok || !v.videoWidth) return null;
    return await makeThumbnail(v, v.videoWidth, v.videoHeight);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function saveRecording(
  input: SaveRecordingInput
): Promise<{ record: VideoRecord; thumb: Blob | null }> {
  const { settings: appSettings } = useSettingsStore.getState();
  const data = input.data;
  // address not resolved yet (offline or geocoder still working) — queue
  // it so a later export carries the full watermark
  const needsBackfill =
    Boolean(data.fix) &&
    appSettings.geocoder !== "off" &&
    input.config.fields.address &&
    !data.address;

  // container fixes — progressive MP4 with sample tables, real duration,
  // GPS atom; or a WebM duration — all in bounded memory (remux.ts)
  const blob = await finalizeVideoBlob(input.raw, input.durationMs, data.fix);

  const record: VideoRecord = {
    id: newId(),
    kind: "video",
    createdAt: input.createdAt,
    duration: input.durationMs / 1000,
    width: input.width,
    height: input.height,
    mimeType: blob.type,
    data,
    config: input.config,
    liveBlur: input.liveBlur || undefined,
    blurBurned: input.blurBurned || undefined,
    watermarkBurned: input.watermarkBurned || undefined,
    backfill: needsBackfill ? "pending" : "not-needed",
    recovered: input.recovered || undefined,
  };

  await putBlob(record.id, "source", blob);
  let thumb: Blob | null = null;
  try {
    const v = input.thumbFrom;
    thumb =
      v && v.videoWidth
        ? await makeThumbnail(v, v.videoWidth, v.videoHeight)
        : await thumbFromFile(blob);
    if (thumb) await putBlob(record.id, "thumb", thumb);
  } catch {
    // no thumb — the gallery shows a placeholder
  }
  await putMedia(record);
  if (needsBackfill) scheduleBackfill();

  // the device copy, awaited: the caller only deletes the stored chunks
  // once the file is known to be safe somewhere else
  if (appSettings.autoSaveToDevice || isNativeApp()) {
    try {
      await saveBlobToDevice(blob, suggestedName("video", record.createdAt, blob.type));
    } catch {
      // download blocked — the in-app copy is already saved
    }
  }
  return { record, thumb };
}
