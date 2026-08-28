/**
 * "Which station am I at?"
 *
 * A great deal of civic reporting happens at railway stations, and for
 * those photos the station IS the address. A card reading "Grand Southern
 * Trunk Road, Sattamangalam" for a picture taken on Potheri's platform is
 * technically an address and practically useless to whoever has to act on
 * it. So when a fix falls inside a station, the station names the card and
 * the street address stays underneath it, unchanged.
 *
 * Matching is against the station's own PLATFORM ENVELOPE, not a circle
 * around a point (see scripts/build-rail.mjs). Platforms are long and
 * thin; a circle big enough to reach the end of one is big enough to
 * swallow the neighbourhood around it, and this app has already been
 * bitten once by claiming more precision over a wider area than the data
 * supports.
 */
import type { GeoPack } from "./geodata";
import { LANGS, langOf } from "../i18n/languages";

export interface RailStation {
  name: string;
  /** name in the card's language, where OSM has one */
  names?: Record<string, string>;
  /** Indian Railways station code, e.g. MSC */
  code?: string;
  operator?: string;
  kind: "station" | "halt";
  /** absent means heavy rail */
  mode?: "metro" | "monorail" | "light_rail";
  lat: number;
  lng: number;
  /** platform bounding box [minLng, minLat, maxLng, maxLat] */
  env?: number[];
  /** fallback circle, metres, when no platform is mapped */
  radius: number;
  measured: boolean;
  /** how far the fix was from the station point, filled in at lookup */
  distance: number;
}

/**
 * Concourse, entrance, forecourt — how far outside the platforms still
 * counts as being at the station. Kept here rather than baked into the
 * data so it is one number in one place and can be tuned without a
 * rebuild of every pack.
 */
const BUFFER_M = 60;

const metres = (
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number => {
  const dLat = (aLat - bLat) * 111_320;
  const dLng = (aLng - bLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

/** Distance from a point to a lat/lng bounding box; 0 when inside. */
function metresToEnv(lat: number, lng: number, env: number[]): number {
  const [w, s, e, n] = env;
  const dLng = lng < w ? w - lng : lng > e ? lng - e : 0;
  const dLat = lat < s ? s - lat : lat > n ? lat - n : 0;
  return Math.hypot(
    dLat * 111_320,
    dLng * 111_320 * Math.cos((lat * Math.PI) / 180)
  );
}

/**
 * The station this point is at, or null.
 *
 * When several overlap — interchange complexes, a halt inside a bigger
 * station's envelope — the nearest station POINT wins, which is the one
 * whose name a person standing there would use.
 */
export function stationAt(
  pack: GeoPack | null,
  lat: number,
  lng: number
): RailStation | null {
  const feats = pack?.layers?.rail?.features;
  if (!Array.isArray(feats)) return null;

  let best: RailStation | null = null;
  for (const f of feats as unknown as {
    geometry?: { coordinates?: number[] };
    properties?: Record<string, unknown>;
  }[]) {
    const c = f.geometry?.coordinates;
    const p = f.properties;
    if (!c || !p || typeof p.name !== "string") continue;
    const sLng = c[0];
    const sLat = c[1];

    const env = Array.isArray(p.env) ? (p.env as number[]) : null;
    const inside = env
      ? metresToEnv(lat, lng, env) <= BUFFER_M
      : metres(lat, lng, sLat, sLng) <= (typeof p.radius === "number" ? p.radius : 0);
    if (!inside) continue;

    const distance = metres(lat, lng, sLat, sLng);
    if (best && best.distance <= distance) continue;
    best = {
      name: p.name,
      names: (p.names as Record<string, string>) ?? undefined,
      code: typeof p.code === "string" ? p.code : undefined,
      operator: typeof p.operator === "string" ? p.operator : undefined,
      kind: p.kind === "halt" ? "halt" : "station",
      mode: (p.mode as RailStation["mode"]) ?? undefined,
      lat: sLat,
      lng: sLng,
      env: env ?? undefined,
      radius: typeof p.radius === "number" ? p.radius : 0,
      measured: p.measured === true,
      distance,
    };
  }
  return best;
}

/**
 * What to print as the title.
 *
 * OSM names the place, not the kind of place: "Chennai Chetpet",
 * "Potheri" and "Guindy Railway Station" all appear, and a bare
 * "Perambur" on a card reads as a neighbourhood rather than as the
 * station a complaint is about. So the kind is appended where the name
 * does not already carry it.
 *
 * The halt/station distinction OSM records is deliberately NOT surfaced.
 * It is inconsistently tagged — Potheri, a busy suburban stop, is a
 * "halt" — and in Indian usage both are the railway station. Guessing
 * wrong about the mode IS surfaced, because a metro station and a
 * railway station are different places to send someone.
 */
const HAS_KIND = /station|halt|நிலைய|स्टेशन|ನಿಲ್ದಾಣ|స్టేషన్|স্টেশন|স্টেশান/i;

export function stationTitle(st: RailStation, lang: string): string {
  const code = langOf(lang);
  const name = (st.names?.[code] ?? st.name).trim();
  if (HAS_KIND.test(name)) return name;
  // The suffix follows the CARD's language, not the name's. A Tamil name
  // with an English "Railway Station" bolted on is neither language, and
  // it is the same mistake as transliterating an address.
  const t = LANGS[code].strings;
  const kind =
    st.mode === "metro" || st.mode === "light_rail"
      ? t.metroStation
      : t.railStation;
  return `${name} ${kind}`;
}
