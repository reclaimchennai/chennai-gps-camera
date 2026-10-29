/**
 * Best-effort live address for the viewfinder preview.
 *
 * The throttle ADAPTS to how fast the phone is actually moving, because a
 * fixed one did the wrong thing at both ends. At 25 s and 120 m, someone
 * walking a street took two minutes to see the road name change, while a
 * phone sitting on a desk still woke the geocoder every time GPS jitter
 * nudged it. Standing still costs nothing now; moving costs roughly one
 * lookup per block.
 *
 * Speed comes from consecutive fixes rather than `coords.speed`, which
 * Android frequently reports as null and which is meaningless when the
 * fix is coarse. Never faster than MIN_GAP_MS, so a car on a motorway
 * cannot turn this into a request loop.
 */
import { useLiveStore } from "../store";
import { useSettingsStore } from "../store";
import { reverseGeocode } from "./geocode";
import { fixIsFromBeforeResume } from "./location";

/** Floor on request rate, whatever the speed. */
const MIN_GAP_MS = 6_000;
/** Ceiling: refresh at least this often even standing still, so a stale
 *  address does not follow the user around all afternoon. */
const MAX_GAP_MS = 180_000;
/** Below this, treat the phone as stationary — GPS jitter alone moves a
 *  resting handset tens of metres. */
const STILL_METERS = 25;
/**
 * How far someone on foot goes before the address is looked up again.
 * It was 120 m: a street corner and most of the next street, so the
 * card kept the last road's name. The phone's own geocoder costs
 * nothing, and the cache answers a spot already asked about.
 */
const WALK_TRIGGER_M = 40;
/** Fixes further apart in time than this say nothing about speed — the
 *  screen was off, or the app was away. */
const SPEED_GAP_S = 30;

let started = false;
let lastAt = 0;
let lastPos: { lat: number; lng: number } | null = null;
let lastLang = "";
let inFlight = false;
/** metres per second, smoothed across fixes */
let speed = 0;
let lastFix: { lat: number; lng: number; t: number } | null = null;
/** Back from the screen being off: look up the first fix taken after it,
 *  wherever it is. */
let resumed = false;

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
  // the held fix is where the phone was before the screen went off; the
  // address waits for the new one rather than confirming the old place
  if (fixIsFromBeforeResume()) return;
  // Switching the card's language makes the cached address the wrong
  // language, not merely stale — the distance/interval throttle exists to
  // spare the geocoder, not to make the user walk 120 m to see Tamil.
  const lang = useSettingsStore.getState().watermark.language ?? "en";
  const langChanged = lang !== lastLang;
  const now = Date.now();

  // track speed from consecutive fixes
  if (lastFix) {
    const dt = (now - lastFix.t) / 1000;
    if (dt > SPEED_GAP_S) {
      speed = 0;
      lastFix = { lat: fix.lat, lng: fix.lng, t: now };
    } else if (dt > 0.5) {
      const v = moved(lastFix, fix) / dt;
      // exponential smoothing: one GPS glitch should not read as a sprint
      speed = speed * 0.6 + Math.min(v, 40) * 0.4;
      lastFix = { lat: fix.lat, lng: fix.lng, t: now };
    }
  } else {
    lastFix = { lat: fix.lat, lng: fix.lng, t: now };
  }

  if (!langChanged && !resumed) {
    const gone = lastPos ? moved(lastPos, fix) : Infinity;
    const since = now - lastAt;
    // Distance that should trigger a refresh: a street name changes every
    // block or so on foot, but a passenger at 60 km/h does not need one
    // every 60 m. Scale the trigger with speed and cap the rate.
    const trigger = speed < 1.2 ? WALK_TRIGGER_M : Math.min(WALK_TRIGGER_M + speed * 30, 500);
    const moving = gone >= STILL_METERS;
    const haveAddress = !!useLiveStore.getState().address;
    if (since < MIN_GAP_MS) return;
    // A phone on a desk has nothing new to say. The periodic refresh is
    // only there to fill a gap — once an address is in hand, standing
    // still costs no requests at all.
    if (!moving && (haveAddress || since < MAX_GAP_MS)) return;
    if (moving && gone < trigger && since < MAX_GAP_MS) return;
  }
  lastLang = lang;
  resumed = false;

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
  // and on a settings change, so switching language re-geocodes without
  // waiting for the next GPS fix to arrive
  useSettingsStore.subscribe(() => void maybeGeocode());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resumed = true;
  });
  window.addEventListener("online", () => {
    lastAt = 0;
    void maybeGeocode();
  });
}
