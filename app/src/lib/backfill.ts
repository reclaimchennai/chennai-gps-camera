/**
 * Background address / online-map backfill (§7).
 *
 * Photos saved before their reverse-geocoded address (or optional Google
 * mini-map) was available carry backfill === "pending" and keep their raw
 * frame. This queue re-composites them opportunistically — on capture,
 * on app start, and whenever connectivity returns. Failures never block
 * anything; the offline-resolved photo is already complete and valid.
 */
import { listMedia, getMedia, putMedia, deleteBlob } from "./db";
import { reverseGeocode, fetchGoogleMiniMap } from "./geocode";
import { recompositePhoto } from "./capture";
import type { PhotoRecord, WatermarkData } from "../types";

let running = false;
let scheduled = false;

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
  scheduleBackfill(5000); // catch pending items from previous sessions
}

async function runBackfill(): Promise<void> {
  if (running || !navigator.onLine) return;
  running = true;
  try {
    const pending = (await listMedia()).filter(
      (m): m is PhotoRecord => m.kind === "photo" && m.backfill === "pending"
    );
    for (const rec of pending) {
      if (!navigator.onLine) break;
      await backfillOne(rec.id);
    }
  } finally {
    running = false;
  }
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
  } else {
    // Raw missing (e.g. annotated copy) — nothing to re-composite.
    await putMedia({ ...rec, backfill: "failed" });
  }
}
