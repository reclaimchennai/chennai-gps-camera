/**
 * Recording on the phone's camera (NativeCameraPlugin: CameraX VideoCapture
 * with an OverlayEffect).
 *
 * The WebView recorder redrew every frame onto a canvas on the page's own
 * thread, 30 times a second, and recorded the canvas: the viewfinder and
 * the controls competed with it, it could only see the cameras the
 * WebView is shown, and switching to video meant closing one camera and
 * opening another. Here the phone records and the GPU draws the card into
 * each frame. The page's part is the card itself, redrawn once a second
 * for the clock, the coordinates and the sound level.
 */
import { camera } from "../camera";
import { cardAssets, cardStrips, collectWatermarkData, type StripRect } from "../capture";
import { newId, putBlob, putMedia } from "../db";
import { readNativeFile, nativeCamera, type NativeRecorded } from "../nativeCamera";
import { suggestedName } from "../share";
import { scheduleBackfill } from "../backfill";
import { useLiveStore, useSettingsStore } from "../../store";
import type { VideoRecord, WatermarkConfig, WatermarkData } from "../../types";

/** How often the card in the recording is redrawn. */
const CARD_EVERY_MS = 1000;
/** Where the card sits is looked for again this often (it can grow when
 *  an address arrives); in between, only its pixels are redrawn. */
const RESCAN_EVERY = 5;

export interface NativeSession {
  startedAt: number;
  data: WatermarkData;
  config: WatermarkConfig;
  audio: boolean;
  /** stop the card feed */
  stopFeed: () => void;
}

/** The recording's frame, upright for how the phone is held. */
function uprightVideoSize(rotation: number): { w: number; h: number } {
  const vw = camera.native.info?.videoW ?? 1920;
  const vh = camera.native.info?.videoH ?? 1080;
  const long = Math.max(vw, vh);
  const short = Math.min(vw, vh);
  const sideways = rotation === 90 || rotation === -90;
  return sideways ? { w: long, h: short } : { w: short, h: long };
}

/**
 * Keep the card in the recording current: drawn now, then every second.
 * Resolves once the first card is in place, so the first frame has it.
 */
async function startCardFeed(size: { w: number; h: number }): Promise<() => void> {
  const { watermark: config } = useSettingsStore.getState();
  const profile = useSettingsStore.getState().profile;
  const first = collectWatermarkData();
  const assets = await cardAssets(first, config, useLiveStore.getState().lookupResult);
  let where: StripRect[] | undefined;
  let tick = 0;
  let stopped = false;
  let busy = false;
  const draw = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const data = collectWatermarkData();
      const r = await cardStrips(size.w, size.h, data, config, profile, assets,
        tick % RESCAN_EVERY === 0 ? undefined : where);
      where = r.where;
      tick++;
      if (!stopped) await camera.native.setOverlay(r.bands, size.w, size.h);
    } catch {
      // a missed second keeps the previous card on screen
    } finally {
      busy = false;
    }
  };
  await draw();
  const t = window.setInterval(() => void draw(), CARD_EVERY_MS);
  return () => {
    stopped = true;
    window.clearInterval(t);
  };
}

/** Start recording on the phone camera; the card is in from the first frame. */
export async function startNativeRecording(rotation: number): Promise<NativeSession> {
  const data = collectWatermarkData();
  const { watermark: config } = useSettingsStore.getState();
  const stopFeed = await startCardFeed(uprightVideoSize(rotation));
  try {
    const r = await camera.native.startRecording(rotation, data.fix);
    return { startedAt: r.startedAt || Date.now(), data, config, audio: r.audio, stopFeed };
  } catch (e) {
    stopFeed();
    throw e;
  }
}

/** Stop, and file the clip in the app (the phone has put it in the gallery). */
export async function stopNativeRecording(
  s: NativeSession
): Promise<{ record: VideoRecord; thumb: Blob | null } | null> {
  s.stopFeed();
  const res = await camera.native.stopRecording(suggestedName("video", s.startedAt, "video/mp4"));
  return fileNativeRecording(res, s.data, s.config);
}

/**
 * A finished native recording into the app's gallery: the file as the
 * phone wrote it (a normal MP4 — nothing to remux), its thumbnail, and
 * the card's data for the details view and later exports.
 */
export async function fileNativeRecording(
  res: NativeRecorded,
  data: WatermarkData = collectWatermarkData(),
  config: WatermarkConfig = useSettingsStore.getState().watermark
): Promise<{ record: VideoRecord; thumb: Blob | null } | null> {
  if (!res.ok || !res.path) return null;
  const plugin = nativeCamera();
  const settings = useSettingsStore.getState().settings;
  const [blob, thumb] = await Promise.all([
    readNativeFile(res.path),
    res.thumb ? readNativeFile(res.thumb).catch(() => null) : Promise.resolve(null),
  ]);
  const needsBackfill =
    Boolean(data.fix) && settings.geocoder !== "off" && config.fields.address && !data.address;
  const record: VideoRecord = {
    id: newId(),
    kind: "video",
    createdAt: res.startedAt || Date.now(),
    duration: res.durationMs / 1000,
    width: res.width ?? 0,
    height: res.height ?? 0,
    mimeType: "video/mp4",
    data,
    config,
    watermarkBurned: true,
    backfill: needsBackfill ? "pending" : "not-needed",
  };
  await putBlob(record.id, "source", blob);
  if (thumb) await putBlob(record.id, "thumb", thumb);
  await putMedia(record);
  if (needsBackfill) scheduleBackfill();
  // the app holds its copy now; the phone's working files can go
  void plugin?.release({ path: res.path });
  if (res.thumb) void plugin?.release({ path: res.thumb });
  return { record, thumb };
}
