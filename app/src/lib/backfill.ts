/**
 * Background address / online-map backfill (§7).
 *
 * Capture never waits for the network: shoot with just a GPS lock and
 * whatever resolves offline (ward, DIGIPIN, mini-map from local packs).
 * Anything still missing queues here:
 *  - photos keep their raw frame and are re-composited with the full
 *    watermark once the address (or Google map) arrives;
 *  - videos have nothing burned at record time, so the queue just fills
 *    record.data in — later exports/shares carry the full card.
 * The queue drains on capture, app start, connectivity return, tab
 * focus, and retries on a backoff while anything stays pending.
 */
import { listMedia, getMedia, putMedia, deleteBlob } from "./db";
import { reverseGeocode, fetchGoogleMiniMap } from "./geocode";
import { recompositePhoto } from "./capture";
import type { PhotoRecord, VideoRecord, WatermarkData } from "../types";

const RETRY_MS = 30_000;

let running = false;
let scheduled = false;

/** Tell the gallery a queued item just gained its full watermark/address,
 *  so it can refresh that cell with a highlight animation. */
function announceUpdated(id: string): void {
  window.dispatchEvent(new CustomEvent("gpscam:media-updated", { detail: { id } }));
}

export function scheduleBackfill(delayMs = 1500): void {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(() => {
    scheduled = false;
    void runBackfill();
  }, delayMs);
}

export function initBackfill(): void {
  window.addEventListener("online", () => scheduleBackfill(2000));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleBackfill(1000);
  });
  scheduleBackfill(5000); // catch pending items from previous sessions
}

async function runBackfill(): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const pending = (await listMedia()).filter(
      (m) => m.backfill === "pending"
    );
    for (const rec of pending) {
      if (!navigator.onLine) break;
      if (rec.kind === "photo") await backfillOne(rec.id);
      else await backfillVideo(rec.id);
    }
    // whatever the geocoder couldn't answer this round retries later
    const stillPending = (await listMedia()).some(
      (m) => m.backfill === "pending"
    );
    if (stillPending) scheduleBackfill(RETRY_MS);
  } finally {
    running = false;
  }
}

async function backfillVideo(id: string): Promise<void> {
  const rec = (await getMedia(id)) as VideoRecord | undefined;
  if (!rec || rec.backfill !== "pending") return;
  const fix = rec.data.fix;
  if (!fix || rec.data.address) {
    await putMedia({ ...rec, backfill: "not-needed" });
    return;
  }
  const geo = await reverseGeocode(fix.lat, fix.lng);
  if (!geo) return; // stays pending for the next window
  await putMedia({
    ...rec,
    data: { ...rec.data, address: geo.address, locality: geo.locality },
    backfill: "done",
  });
  announceUpdated(id);
}

async function backfillOne(id: string): Promise<void> {
  const rec = (await getMedia(id)) as PhotoRecord | undefined;
  if (!rec || rec.backfill !== "pending") return;
  const fix = rec.data.fix;
  if (!fix) {
    await putMedia({ ...rec, backfill: "not-needed" });
    return;
  }

  const wantsAddress = rec.config.fields.address && !rec.data.address;
  const geo = wantsAddress
    ? await reverseGeocode(fix.lat, fix.lng)
    : null;
  const googleMap = await fetchGoogleMiniMap(fix.lat, fix.lng);

  if (wantsAddress && !geo && !googleMap) {
    // Nothing gained; leave pending for the next connectivity window.
    return;
  }

  const data: WatermarkData = {
    ...rec.data,
    address: geo?.address ?? rec.data.address,
    locality: geo?.locality ?? rec.data.locality,
  };

  const updated = await recompositePhoto(rec, data, {
    miniMap: googleMap ?? undefined,
    miniMapIsGoogle: Boolean(googleMap),
  });
  if (updated) {
    await putMedia({ ...updated, backfill: "done", hasRaw: false });
    await deleteBlob(id, "raw");
    announceUpdated(id);
  } else {
    // Raw missing (e.g. annotated copy) — nothing to re-composite.
    await putMedia({ ...rec, backfill: "failed" });
  }
}
