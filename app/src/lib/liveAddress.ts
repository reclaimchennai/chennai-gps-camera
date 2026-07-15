/**
 * Best-effort live address for the viewfinder preview. Throttled hard:
 * at most one reverse-geocode every 25 s and only after moving ~120 m.
 * Purely cosmetic for the overlay — the capture path never waits on it
 * (a fresh nearby result just gets baked in for free, §7).
 */
import { useLiveStore } from "../store";
import { useSettingsStore } from "../store";
import { reverseGeocode } from "./geocode";

const MIN_INTERVAL_MS = 25_000;
const MIN_MOVE_METERS = 120;

let started = false;
let lastAt = 0;
let lastPos: { lat: number; lng: number } | null = null;
let inFlight = false;

function moved(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

async function maybeGeocode(): Promise<void> {
  if (inFlight || !navigator.onLine) return;
  const { fix } = useLiveStore.getState();
  const { settings } = useSettingsStore.getState();
  if (!fix || settings.geocoder === "off") return;
  const now = Date.now();
  if (now - lastAt < MIN_INTERVAL_MS) return;
  if (lastPos && moved(lastPos, fix) < MIN_MOVE_METERS) return;

  inFlight = true;
  lastAt = now;
  lastPos = { lat: fix.lat, lng: fix.lng };
  try {
    const res = await reverseGeocode(fix.lat, fix.lng);
    if (res) {
      useLiveStore
        .getState()
        .setAddress(res.address, res.locality, { lat: fix.lat, lng: fix.lng });
    }
  } finally {
    inFlight = false;
  }
}

export function startLiveAddress(): void {
  if (started) return;
  started = true;
  useLiveStore.subscribe(() => void maybeGeocode());
  window.addEventListener("online", () => {
    lastAt = 0;
    void maybeGeocode();
  });
}
