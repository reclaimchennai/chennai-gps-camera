/**
 * Continuous location + jurisdiction tracking.
 *
 * watchPosition starts at app launch (alongside camera pre-warm) so a
 * fix is normally already in hand before the first shutter tap. The
 * jurisdiction lookup re-runs only when the device has moved far enough
 * to possibly change the answer — it is pure local compute either way.
 */
import { loadGeodataFor } from "./geo/geodata";
import { lookup, type LookupResult } from "./geo/lookup";
import { useLiveStore } from "../store";
import type { Fix } from "../types";

const RELOOKUP_MIN_METERS = 8;

let watchId: number | null = null;
let lastLookupAt: { lat: number; lng: number } | null = null;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng =
    (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

async function onFix(pos: GeolocationPosition): Promise<void> {
  const fix: Fix = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy ?? undefined,
    altitude: pos.coords.altitude,
    heading: pos.coords.heading,
    timestamp: pos.timestamp,
  };
  const store = useLiveStore.getState();
  store.setFix(fix);

  if (
    !lastLookupAt ||
    metersBetween(lastLookupAt, fix) >= RELOOKUP_MIN_METERS ||
    !store.lookupResult
  ) {
    lastLookupAt = { lat: fix.lat, lng: fix.lng };
    try {
      const pack = await loadGeodataFor(fix.lat, fix.lng);
      const result: LookupResult = pack
        ? lookup(pack, fix.lat, fix.lng)
        : {
            jurisdiction: { scope: "out" },
            wardFeature: null,
            loFeature: null,
            nearestStation: null,
          };
      useLiveStore.getState().setLookupResult(result);
    } catch {
      // geodata unavailable — GPS-only mode; retried on next fix
      lastLookupAt = null;
    }
  }
}

export function startLocation(): void {
  if (watchId != null || !("geolocation" in navigator)) return;
  useLiveStore.getState().setGpsStatus("waiting");
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      useLiveStore.getState().setGpsStatus("ok");
      void onFix(pos);
    },
    (err) => {
      useLiveStore
        .getState()
        .setGpsStatus(err.code === err.PERMISSION_DENIED ? "denied" : "waiting");
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

export function stopLocation(): void {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// ---- Compass bearing (best-effort) ---------------------------------

let compassStarted = false;

export function startCompass(): void {
  if (compassStarted) return;
  compassStarted = true;
  const handler = (e: DeviceOrientationEvent): void => {
    // webkitCompassHeading (iOS) or absolute alpha (Android Chrome)
    const webkit = (e as unknown as { webkitCompassHeading?: number })
      .webkitCompassHeading;
    let bearing: number | undefined;
    if (typeof webkit === "number") bearing = webkit;
    else if (e.absolute && e.alpha != null) bearing = 360 - e.alpha;
    if (bearing != null && Number.isFinite(bearing)) {
      useLiveStore.getState().setBearing(((bearing % 360) + 360) % 360);
    }
  };
  window.addEventListener("deviceorientationabsolute", handler as EventListener);
  window.addEventListener("deviceorientation", handler as EventListener);
}
