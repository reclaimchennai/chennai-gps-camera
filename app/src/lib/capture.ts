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
import { writeExif } from "./exif";
import { canvasToBlob, makeThumbnail, loadImage } from "./img";
import { newId, putBlob, putMedia, getBlob } from "./db";
import { useLiveStore, useSettingsStore } from "../store";
import type { PhotoRecord, WatermarkData } from "../types";
import { scheduleBackfill } from "./backfill";
import { downloadBlob, suggestedName } from "./share";
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
    timestamp: now,
    tzOffsetMinutes: new Date(now).getTimezoneOffset(),
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

export async function capturePhoto(): Promise<CaptureResult> {
  const { watermark: config, profile, settings } = useSettingsStore.getState();
  const live = useLiveStore.getState();
  const data = collectWatermarkData();

  const frame = await camera.captureFrame();
  const w = frame.width;
  const h = frame.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  const mirror = camera.facing === "user" && settings.mirrorFrontPhoto;
  if (mirror) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(frame, 0, 0);
  if (mirror) ctx.restore();
  frame.close();

  // EXPERIMENTAL live face blur: burn mosaic over detected heads BEFORE
  // the raw copy is taken, so no retained frame keeps unblurred faces.
  // Only runs (and only costs time) when the setting is on.
  if (settings.liveFaceBlur) {
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
  if (config.fields.miniMap && data.fix) {
    assets.miniMap = await renderMiniMap(
      data.fix.lat,
      data.fix.lng,
      live.lookupResult
    );
  }
  if (config.fields.profilePhoto) {
    assets.profilePhoto = await getProfilePhoto();
  }

  renderWatermark(ctx, w, h, data, config, profile, assets);

  const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
  const withExif = await writeExif(jpeg, data);
  const thumb = await makeThumbnail(canvas, w, h);

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
  };

  await putBlob(record.id, "final", withExif);
  await putBlob(record.id, "thumb", thumb);
  if (rawBlob) await putBlob(record.id, "raw", rawBlob);
  await putMedia(record);

  // Auto-save to the device (web build: Downloads folder, which gallery
  // apps index). Saved immediately with GPS/jurisdiction data baked in;
  // the street-address backfill only upgrades the in-app copy.
  if (settings.autoSaveToDevice) {
    try {
      downloadBlob(
        withExif,
        suggestedName("photo", record.createdAt, "image/jpeg")
      );
    } catch {
      // download blocked — the in-app copy is already safe
    }
  }

  if (needsBackfill) scheduleBackfill();
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
  if (record.config.fields.miniMap && data.fix && !assets.miniMap) {
    assets.miniMap = await renderMiniMap(data.fix.lat, data.fix.lng, null);
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
