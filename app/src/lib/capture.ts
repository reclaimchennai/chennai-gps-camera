/**
 * Photo capture pipeline (§4 step 3).
 *
 * Everything on the tap→saved path is local: frame grab, watermark
 * composite, EXIF, IndexedDB write. Address text / online map imagery
 * are NEVER waited for — if they aren't already known, the raw frame is
 * retained and the backfill queue (backfill.ts) upgrades the photo later.
 */
import { camera } from "./camera";
import { renderWatermark, type WatermarkAssets } from "./watermark/render";
import { renderMiniMap } from "./watermark/minimap";
import { renderLocationQr } from "./watermark/qr";
import { sampleNoiseOnce } from "./audio/meter";
import { loadCrest } from "./watermark/crests";
import { ensureCardFont } from "./i18n/languages";
import { resetScriptCache } from "./watermark/signboard";
import { signStyle } from "./watermark/chennaiSign";

/** Emblems for the Chennai plate — resolved once, then handed to the
 *  renderer through `assets` so no draw path depends on load order. */
export async function chennaiSignAssets(
  config: { preset: string },
  data: { jurisdiction?: unknown }
): Promise<Partial<WatermarkAssets>> {
  if (config.preset !== "chennai") return {};
  const style = signStyle(data as never);
  if (!style) return {};
  // fetch only what this board draws — the crest set is ~540 KB and any
  // one user ever sees one of them
  const [gccEmblem, singaraLogo, corpLogo] = await Promise.all([
    loadCrest(style.leftLogo === "gcc" ? "gcc" : null),
    loadCrest(style.centreLogo === "singara" ? "singara" : null),
    loadCrest(
      style.leftLogo && style.leftLogo !== "gcc"
        ? style.leftLogo
        : style.centreLogo && style.centreLogo !== "singara"
          ? style.centreLogo
          : null
    ),
  ]);
  await ensureCardFont("ta", resetScriptCache); // the boards carry Tamil
  return { gccEmblem, singaraLogo, corpLogo };
}
import { writeExif } from "./exif";
import { canvasToBlob, makeThumbnail, loadImage } from "./img";
import { newId, putBlob, putMedia, getBlob } from "./db";
import { useLiveStore, useSettingsStore } from "../store";
import { isNativeApp } from "./native";
import type { PhotoRecord, WatermarkData } from "../types";
import { scheduleBackfill } from "./backfill";
import { scheduleDownloads } from "./downloadQueue";
import { latLngToDigipin } from "./geo/digipin";
import { detectFaces } from "./detect/faces";
import { makeMosaic, blocksFor } from "./editor/shapes";

/** Live address is only baked in if it was resolved near the capture point. */
const ADDRESS_REUSE_METERS = 150;

function nearEnough(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): boolean {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng) <= ADDRESS_REUSE_METERS;
}

export function collectWatermarkData(): WatermarkData {
  const live = useLiveStore.getState();
  const { watermark } = useSettingsStore.getState();
  const now = Date.now();
  const addressUsable =
    live.address &&
    live.addressFor &&
    live.fix &&
    nearEnough(live.addressFor, live.fix);
  return {
    fix: live.fix,
    jurisdiction: live.lookupResult?.jurisdiction ?? null,
    address: addressUsable ? live.address : undefined,
    locality: addressUsable ? live.locality : undefined,
    bearing: live.bearing,
    digipin:
      watermark.fields.digipin && live.fix
        ? (latLngToDigipin(live.fix.lat, live.fix.lng) ?? undefined)
        : undefined,
    db: watermark.fields.soundLevel ? (live.db ?? undefined) : undefined,
    dbStats: watermark.fields.soundLevel ? (live.dbStats ?? undefined) : undefined,
    timestamp: now,
    tzOffsetMinutes: new Date(now).getTimezoneOffset(),
    // disclosure only — spoofing is allowed, but a photo made with a mock
    // location must never pass as a genuinely located one
    mockLocation: live.mockLocation || undefined,
  };
}

export async function getProfilePhoto(): Promise<ImageBitmap | null> {
  const { profile } = useSettingsStore.getState();
  if (!profile.hasPhoto) return null;
  const blob = await getBlob("profile", "raw");
  if (!blob) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export interface CaptureResult {
  record: PhotoRecord;
  thumb: Blob;
}


/** A grabbed frame plus the world-state snapshot at the shutter moment —
 *  everything the background pipeline needs to finish the photo without
 *  touching the live camera again. */
export interface CaptureJob {
  canvas: HTMLCanvasElement; // raw sensor frame, zoom+mirror already applied
  w: number;
  h: number;
  data: WatermarkData;
  config: import("../types").WatermarkConfig;
  lookupResult: ReturnType<typeof useLiveStore.getState>["lookupResult"];
  liveBlur: boolean;
  wantsDeviceCopy: boolean;
  /**
   * A noise reading still in flight.
   *
   * Photo mode keeps the microphone released, so the level has to be
   * sampled at the shutter — but the reading takes about half a second
   * and the card was stamped within milliseconds of firing it, so the dB
   * never made it into the photo. The frame is still grabbed instantly;
   * the BACKGROUND queue waits for the reading before compositing, which
   * costs the user nothing.
   */
  noise?: Promise<number | null> | null;
}

/**
 * FAST path — sensor only. Grabs the frame, applies zoom/mirror, and
 * snapshots the moment's world-state. Returns immediately so the shutter
 * frees for the next shot; everything else runs in the background queue
 * (processCapture). Also returns a tiny preview for the fly animation.
 */
export async function grabFrame(): Promise<{
  job: CaptureJob;
  preview: string;
}> {
  const { watermark: config, settings } = useSettingsStore.getState();
  const live = useLiveStore.getState();
  const data = collectWatermarkData();

  // start the reading BEFORE the frame grab so the two overlap, and hand
  // the promise to the queue rather than waiting on it here
  const noise =
    config.fields.soundLevel && data.db == null && !data.dbStats
      ? sampleNoiseOnce()
      : null;

  const frame = await camera.captureFrame();
  const w = frame.width;
  const h = frame.height;

  /**
   * ONE pass, not three.
   *
   * Two rotations can apply to a capture: standing the sensor frame
   * upright (ImageCapture hands back the sensor's own landscape frame
   * however the phone is held), and turning it for a phone held sideways.
   * Doing each as its own canvas meant up to THREE full-resolution
   * allocations and draws per shot — around 12 MP each — which is what
   * put the lag between photos when the shutter is held down. They
   * compose into a single quarter-turn, so compose them and draw once.
   *
   * Quarter turns, clockwise-positive:
   *   upright  = +90 when the preview is portrait but the frame is not
   *   held UI  = -90 for uiRotation 90, +90 for -90 (see the old helper)
   */
  const uprightQ = camera.previewIsPortrait() && w > h ? 1 : 0;
  const uiQ = live.uiRotation === 90 ? -1 : live.uiRotation === -90 ? 1 : 0;
  const q = (((uprightQ + uiQ) % 4) + 4) % 4; // 0..3 clockwise quarter turns

  const swap = q === 1 || q === 3;
  const outW = swap ? h : w;
  const outH = swap ? w : h;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext("2d");
  if (!ctx) {
    frame.close();
    throw new Error("2d context unavailable");
  }

  ctx.save();
  // rotation about the output centre
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.translate(-w / 2, -h / 2);
  const mirror = camera.facing === "user" && settings.mirrorFrontPhoto;
  if (mirror) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  const dz = camera.captureZoom;
  if (dz > 1) {
    const cw = w / dz;
    const ch = h / dz;
    ctx.drawImage(frame, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, w, h);
  } else {
    ctx.drawImage(frame, 0, 0);
  }
  ctx.restore();
  frame.close();
  // CRITICAL: the watermark and face blur draw on this same context next —
  // leave it with the identity transform (ctx.restore above does that).

  // tiny preview for the fly-to-gallery animation (no watermark needed)
  let preview = "";
  try {
    const pv = document.createElement("canvas");
    const scale = Math.min(1, 220 / Math.max(outW, outH));
    pv.width = Math.max(1, Math.round(outW * scale));
    pv.height = Math.max(1, Math.round(outH * scale));
    pv.getContext("2d")?.drawImage(outCanvas, 0, 0, pv.width, pv.height);
    preview = pv.toDataURL("image/jpeg", 0.6);
  } catch {
    preview = "";
  }

  return {
    preview,
    job: {
      canvas: outCanvas,
      w: outW,
      h: outH,
      data,
      config,
      lookupResult: live.lookupResult,
      liveBlur: settings.liveFaceBlur,
      wantsDeviceCopy: settings.autoSaveToDevice || isNativeApp(),
      noise,
    },
  };
}

/**
 * SLOW path — runs in the background queue, one job at a time. Face
 * blur, watermark composite, EXIF, thumbnail, IndexedDB write, download
 * scheduling. Never touches the live camera, so it can lag behind
 * rapid-fire shooting without ever stalling the shutter.
 */
export async function processCapture(job: CaptureJob): Promise<CaptureResult> {
  const { profile } = useSettingsStore.getState();
  const { canvas, w, h, data, config, lookupResult, liveBlur } = job;
  // resolve the shutter-time noise reading into the card before it draws
  if (job.noise) {
    const db = await job.noise;
    if (db != null && data.db == null) data.db = db;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // EXPERIMENTAL live face blur: burn mosaic over detected heads BEFORE
  // the raw copy is taken, so no retained frame keeps unblurred faces.
  // Only runs (and only costs time) when the setting is on.
  if (liveBlur) {
    try {
      const boxes = await detectFaces(canvas);
      if (boxes?.length) {
        const mosaic = makeMosaic(canvas, w, h, blocksFor(undefined));
        for (const b of boxes) {
          const padX = b.width * 0.15;
          const padY = b.height * 0.2;
          const x = Math.max(0, b.x - padX);
          const y = Math.max(0, b.y - padY);
          const bw = Math.min(w - x, b.width + padX * 2);
          const bh = Math.min(h - y, b.height + padY * 2);
          ctx.drawImage(mosaic, x, y, bw, bh, x, y, bw, bh);
        }
      }
    } catch {
      // detector unavailable — photo saves unblurred (best-effort)
    }
  }

  // Does this capture need a later network upgrade? (§7)
  const settings = useSettingsStore.getState().settings;
  const wantsAddress = config.fields.address && !data.address;
  const wantsGoogleMap =
    config.fields.miniMap &&
    config.onlineMapUpgrade &&
    Boolean(settings.googleApiKey);
  const needsBackfill =
    Boolean(data.fix) &&
    settings.geocoder !== "off" &&
    (wantsAddress || wantsGoogleMap);

  // Raw copy retained only while a backfill re-composite is pending.
  let rawBlob: Blob | null = null;
  if (needsBackfill) {
    rawBlob = await canvasToBlob(canvas, "image/jpeg", 0.95);
  }

  const assets: WatermarkAssets = {};
  Object.assign(assets, await chennaiSignAssets(config, data));
  if (config.fields.miniMap && data.fix) {
    assets.miniMap = await renderMiniMap(data.fix.lat, data.fix.lng, lookupResult);
  }
  if (config.fields.qrCode && data.fix && !assets.qr) {
    assets.qr = await renderLocationQr({
      lat: data.fix.lat,
      lng: data.fix.lng,
      digipin: data.digipin,
    });
  }
  if (config.fields.profilePhoto) {
    assets.profilePhoto = await getProfilePhoto();
  }

  renderWatermark(ctx, w, h, data, config, profile, assets);

  const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
  const withExif = await writeExif(jpeg, data);
  const thumb = await makeThumbnail(canvas, w, h);

  const wantsDeviceCopy = job.wantsDeviceCopy;
  const record: PhotoRecord = {
    id: newId(),
    kind: "photo",
    createdAt: data.timestamp,
    width: w,
    height: h,
    data,
    config,
    backfill: needsBackfill ? "pending" : "not-needed",
    hasRaw: Boolean(rawBlob),
    // The device copy is QUEUED, not written now: it goes out only once
    // the watermark info is complete (backfill resolved), so files on
    // the device always carry the full card. Shooting never waits.
    download: wantsDeviceCopy ? "queued" : undefined,
  };

  await putBlob(record.id, "final", withExif);
  await putBlob(record.id, "thumb", thumb);
  if (rawBlob) await putBlob(record.id, "raw", rawBlob);
  await putMedia(record);

  if (needsBackfill) scheduleBackfill();
  // photos with complete info download right away (still one by one)
  if (wantsDeviceCopy) scheduleDownloads();
  // NOTE: plate OCR is user-initiated only (the Details ⓘ button) — no
  // automatic scanning of every capture.
  return { record, thumb };
}

/** Re-composite an existing photo from its raw frame with updated data. */
export async function recompositePhoto(
  record: PhotoRecord,
  data: WatermarkData,
  extraAssets: Partial<WatermarkAssets> = {}
): Promise<PhotoRecord | null> {
  const raw = await getBlob(record.id, "raw");
  if (!raw) return null;
  const img = await loadImage(raw);
  const canvas = document.createElement("canvas");
  canvas.width = record.width;
  canvas.height = record.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  const { profile } = useSettingsStore.getState();
  const assets: WatermarkAssets = { ...extraAssets };
  Object.assign(assets, await chennaiSignAssets(record.config, data));
  if (record.config.fields.miniMap && data.fix && !assets.miniMap) {
    assets.miniMap = await renderMiniMap(data.fix.lat, data.fix.lng, null);
  }
  // independent of the map: the QR must appear even with the map off
  if (record.config.fields.qrCode && data.fix && !assets.qr) {
    assets.qr = await renderLocationQr({
      lat: data.fix.lat,
      lng: data.fix.lng,
      digipin: data.digipin,
    });
  }
  if (record.config.fields.profilePhoto && !assets.profilePhoto) {
    assets.profilePhoto = (await getProfilePhoto()) ?? undefined;
  }

  renderWatermark(
    ctx,
    record.width,
    record.height,
    data,
    record.config,
    profile,
    assets
  );

  const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
  const withExif = await writeExif(jpeg, data);
  const thumb = await makeThumbnail(canvas, record.width, record.height);

  const updated: PhotoRecord = { ...record, data };
  await putBlob(record.id, "final", withExif);
  await putBlob(record.id, "thumb", thumb);
  await putMedia(updated);
  return updated;
}
