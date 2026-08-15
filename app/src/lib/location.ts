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
import { isNativeApp, nativeMockLocation } from "./native";
import type { Fix } from "../types";

const RELOOKUP_MIN_METERS = 8;
/** Once a real GPS fix lands, coarse fixes stay ignored this long. */
const FINE_FRESH_MS = 10_000;

/**
 * How well a point must be known before it can name a place.
 *
 * This is the number that matters most in the app. Ward, zone and police
 * boundaries are drawn from our own polygons using the fix, so the fix's
 * error IS the attribution's error: a ward in a city is often under a
 * kilometre across and a panchayat boundary can be tighter still, so a
 * point known to ±800 m does not merely give a vague answer, it gives a
 * confident WRONG one — a photo addressed to the wrong police station,
 * which is the one mistake this app must not make.
 *
 * 100 m is small against any ward, village or ULB boundary we carry, and
 * comfortably inside what a real GNSS fix delivers outdoors.
 */
const ATTRIBUTABLE_M = 100;

/**
 * How fast someone might be moving, for judging a stale fix.
 *
 * Used to compare a known-good fix that is a few seconds old against a
 * fresh but coarse one: a GPS fix from 5 s ago is wrong by at most a few
 * tens of metres, which still beats a cell-tower fix that is honestly
 * ±1200 m. Roughly city-traffic speed, deliberately pessimistic.
 */
const DRIFT_M_PER_S = 15;

let watchId: number | null = null;
let coarseWatchId: number | null = null;
let lastFineAt = 0;
/** The last high-accuracy fix, kept so a coarse one can be judged
 *  against it rather than simply replacing it on age. */
let lastFineFix: { accuracy?: number; t: number } | null = null;
let lastLookupAt: { lat: number; lng: number } | null = null;
let retryTimer = 0;
let retries = 0;
const MAX_RETRIES = 20;

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
  /**
   * "ok" means "good enough to name a place", not "a number arrived".
   *
   * The viewfinder badge is the only warning a user gets before pressing
   * the shutter, so it must not go green on a cell-tower estimate.
   */
  store.setGpsStatus(
    fix.accuracy != null && fix.accuracy > ATTRIBUTABLE_M ? "approximate" : "ok"
  );

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

/**
 * Mock/spoofed-GPS disclosure. Never a restriction: spoofing stays
 * possible, it only gets LABELLED so a fake-located capture can't pass as
 * genuine. Android is authoritative (the OS's own isMock() flag, via the
 * native bridge).
 *
 * The web has no such API, and a false accusation on a civic photo is a
 * real harm, so the browser check is deliberately conservative: ONLY a
 * physically impossible jump (faster than an airliner) between two
 * *high-accuracy* fixes counts. Requiring good accuracy on both ends is
 * what keeps a wildly-off network/IP fix followed by a real GPS lock —
 * routine on the web — from being called spoofing. Anything less certain
 * stays unlabelled.
 */
let lastFixForMock: { lat: number; lng: number; t: number } | null = null;
const IMPLAUSIBLE_KMH = 1500;
const TRUST_ACC_M = 50;

async function assessMock(pos: GeolocationPosition): Promise<void> {
  const c = pos.coords;
  let mock = false;
  if (isNativeApp()) {
    mock = (await nativeMockLocation()) === true;
  } else if (c.accuracy != null && c.accuracy <= TRUST_ACC_M) {
    const prev = lastFixForMock;
    if (prev) {
      const dtH = (pos.timestamp - prev.t) / 3600_000;
      if (dtH > 0) {
        const dLat = (c.latitude - prev.lat) * 111.32;
        const dLng =
          (c.longitude - prev.lng) *
          111.32 *
          Math.cos((c.latitude * Math.PI) / 180);
        if (Math.hypot(dLat, dLng) / dtH > IMPLAUSIBLE_KMH) mock = true;
      }
    }
  }
  // only remember trustworthy fixes as the baseline for the jump test
  if (c.accuracy != null && c.accuracy <= TRUST_ACC_M) {
    lastFixForMock = { lat: c.latitude, lng: c.longitude, t: pos.timestamp };
  }
  // sticky within a session: once a spoof is seen, keep disclosing it
  // (fake-GPS apps are usually toggled on for a whole shooting session)
  if (mock || isNativeApp()) useLiveStore.getState().setMockLocation(mock);
}

export function startLocation(): void {
  if (watchId != null || !("geolocation" in navigator)) return;
  useLiveStore.getState().setGpsStatus("waiting");
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      retries = 0;
      lastFineAt = Date.now();
      lastFineFix = { accuracy: pos.coords.accuracy ?? undefined, t: lastFineAt };
      void assessMock(pos);
      void onFix(pos);
    },
    (err) => {
      useLiveStore
        .getState()
        .setGpsStatus(err.code === err.PERMISSION_DENIED ? "denied" : "waiting");
      // Fresh-install race: on a first launch the OS permission dialog
      // may still be open when this first fails — a denied watch never
      // recovers on its own, so re-arm it a few times until the grant
      // lands (harmlessly cheap if the user truly denied).
      if (err.code === err.PERMISSION_DENIED && retries < MAX_RETRIES) {
        retries++;
        window.clearTimeout(retryTimer);
        retryTimer = window.setTimeout(() => {
          stopLocation();
          startLocation();
        }, 6000);
      }
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
  // Fast first fix: a parallel low-accuracy watch rides the OS
  // network/fused provider (WiFi + cell), which answers in a second or
  // two indoors where GPS can take minutes. Its fixes carry an honest
  // ±accuracy and step aside whenever real GPS is fresh.
  coarseWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (Date.now() - lastFineAt < FINE_FRESH_MS) return;
      /**
       * A coarse fix may only take over when it is genuinely better than
       * what we already hold.
       *
       * It used to take over on age alone: ten seconds without GPS and a
       * cell-tower estimate became THE fix, silently, reported as "ok".
       * Riding through a city that happens constantly — under a flyover,
       * between tall buildings, in a station — and the result is not a
       * vaguer photo but a wrong one, because the ward, zone and police
       * station are all derived from the fix. A point half a kilometre
       * away lands in the next ward and names the next station, and every
       * part of the card agrees with every other part, so nothing looks
       * amiss.
       *
       * So compare expected error: what this coarse fix admits to,
       * against how far the last good fix could have drifted since.
       */
      const acc = pos.coords.accuracy ?? Infinity;
      const lastGood = lastFineFix;
      if (lastGood) {
        const staleS = Math.max(0, (Date.now() - lastGood.t) / 1000);
        const drifted = (lastGood.accuracy ?? 0) + staleS * DRIFT_M_PER_S;
        if (acc >= drifted) return; // the old GPS fix is still the better guess
      }
      void onFix(pos);
    },
    () => {
      // coarse provider unavailable — the GPS watch still stands
    },
    { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 }
  );
}

export function stopLocation(): void {
  window.clearTimeout(retryTimer);
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (coarseWatchId != null) {
    navigator.geolocation.clearWatch(coarseWatchId);
    coarseWatchId = null;
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
