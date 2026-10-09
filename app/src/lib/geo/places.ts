/**
 * Where is this, in the words people use?
 *
 * Geocoders answer with an ADMINISTRATIVE hierarchy. At 12.9293, 80.2025
 * Google and OSM both say "…Salai, Perungudi, Chennai, Sholinganallur,
 * Chennai" — Perungudi being Greater Chennai Corporation Zone 14 and
 * Sholinganallur the revenue taluk. Both are kilometres across, both are
 * real, and the person standing there lives in Pallikaranai, 589 m away,
 * which the answer never mentions. A user asked why their card named two
 * places ten kilometres from home; this is why.
 *
 * The packs now carry the named settlements OSM holds (see
 * scripts/build-places.mjs), and this picks the one a point is in — the
 * name a neighbour would give — offline and in the card's script.
 *
 * Nearest-node is the standard way to do this without polygons, and its
 * weakness is known: near the boundary between two places it can pick
 * either. That costs a few hundred metres of precision between two
 * ADJACENT names. Its strength is that it can never be ten kilometres
 * wrong, which is the failure that prompted it.
 */
import type { GeoPack } from "./geodata";

export type PlaceType =
  | "city"
  | "town"
  | "suburb"
  | "quarter"
  | "neighbourhood"
  | "locality"
  | "village"
  | "hamlet";

export interface Place {
  name: string;
  /** name in the card's language where OSM has one */
  local?: Record<string, string>;
  type: PlaceType;
  lat: number;
  lng: number;
  /** metres from the queried point */
  distance: number;
}

const DECODE: Record<string, PlaceType> = {
  c: "city",
  t: "town",
  s: "suburb",
  q: "quarter",
  n: "neighbourhood",
  l: "locality",
  v: "village",
  h: "hamlet",
};

/**
 * How far from its node a place can plausibly still be "here".
 *
 * Settlements are not points, but OSM records them as points, so each
 * type is given the reach it typically has: a Chennai suburb is two or
 * three kilometres across, a neighbourhood or a hamlet a kilometre. Past
 * these, nearest-node stops being evidence and becomes a guess.
 */
export const REACH_M: Record<PlaceType, number> = {
  city: 15_000,
  town: 4_000,
  suburb: 2_500,
  quarter: 1_500,
  neighbourhood: 1_000,
  locality: 1_000,
  village: 2_500,
  hamlet: 1_200,
};

/** The level a card is titled at: an area someone would recognise. */
const AREA: PlaceType[] = ["suburb", "quarter", "village"];
/** Finer names, for the address line only, and only when very close. */
const MICRO: PlaceType[] = ["neighbourhood", "locality", "hamlet"];
const MICRO_REACH_M = 700;

interface Table {
  type: "PlaceTable";
  names: string[];
  types: string;
  coords: number[];
  scale: number;
  local?: Record<string, Record<string, string>>;
}

interface Decoded {
  names: string[];
  types: string;
  lat: Float64Array;
  lng: Float64Array;
  local: Record<string, Record<string, string>>;
  /** cell key -> place indices */
  grid: Map<string, number[]>;
}

/** 0.02° cells, about 2.2 km: a 3x3 block always covers the reach of
 *  anything below a town. Towns and cities are searched wider. */
const CELL = 0.02;
const cellOf = (lat: number, lng: number) =>
  `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

const cache = new WeakMap<GeoPack, Decoded | null>();

function decoded(pack: GeoPack | null): Decoded | null {
  if (!pack) return null;
  if (cache.has(pack)) return cache.get(pack) ?? null;
  const t = (pack.layers as unknown as { places?: Table }).places;
  if (!t || t.type !== "PlaceTable" || !Array.isArray(t.names)) {
    cache.set(pack, null);
    return null;
  }
  const n = t.names.length;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    lng[i] = t.coords[i * 2] / t.scale;
    lat[i] = t.coords[i * 2 + 1] / t.scale;
    const k = cellOf(lat[i], lng[i]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const d: Decoded = { names: t.names, types: t.types, lat, lng, local: t.local ?? {}, grid };
  cache.set(pack, d);
  return d;
}

const metres = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const dLat = (aLat - bLat) * 111_320;
  const dLng = (aLng - bLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

function placeAt(d: Decoded, i: number, lat: number, lng: number): Place {
  const local: Record<string, string> = {};
  for (const [l, m] of Object.entries(d.local)) {
    const v = m[i];
    if (v) local[l] = v;
  }
  return {
    name: d.names[i],
    local: Object.keys(local).length ? local : undefined,
    type: DECODE[d.types[i]] ?? "locality",
    lat: d.lat[i],
    lng: d.lng[i],
    distance: metres(lat, lng, d.lat[i], d.lng[i]),
  };
}

/** Visit every place index whose node is within `radiusM`. */
function forEachNear(
  d: Decoded,
  lat: number,
  lng: number,
  radiusM: number,
  visit: (i: number, m: number) => void
): void {
  const span = Math.ceil(radiusM / (CELL * 111_320)) + 1;
  const cy = Math.floor(lat / CELL);
  const cx = Math.floor(lng / CELL);
  for (let y = cy - span; y <= cy + span; y++) {
    for (let x = cx - span; x <= cx + span; x++) {
      for (const i of d.grid.get(`${y}:${x}`) ?? []) {
        const m = metres(lat, lng, d.lat[i], d.lng[i]);
        if (m <= radiusM) visit(i, m);
      }
    }
  }
}

/** Every place whose node is within `radiusM`, nearest first. */
export function placesNear(
  pack: GeoPack | null,
  lat: number,
  lng: number,
  radiusM: number
): Place[] {
  const d = decoded(pack);
  if (!d) return [];
  const out: Place[] = [];
  forEachNear(d, lat, lng, radiusM, (i) => out.push(placeAt(d, i, lat, lng)));
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * The area this point is in: the nearest suburb, quarter or village
 * within its reach, else the nearest town. Null when nothing qualifies —
 * the caller falls back to the city rather than stretching a name past
 * where it is believable.
 */
export function areaAt(pack: GeoPack | null, lat: number, lng: number): Place | null {
  const near = placesNear(pack, lat, lng, REACH_M.town);
  const area = near.find((p) => AREA.includes(p.type) && p.distance <= REACH_M[p.type]);
  if (area) return area;
  return near.find((p) => p.type === "town" && p.distance <= REACH_M.town) ?? null;
}

/** A finer name than the area, only when it is right on top of the point. */
export function microAt(pack: GeoPack | null, lat: number, lng: number): Place | null {
  return (
    placesNear(pack, lat, lng, MICRO_REACH_M).find((p) => MICRO.includes(p.type)) ?? null
  );
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * How far away is the nearest place carrying this name?
 *
 * Used to judge a geocoder's place names. "Perungudi" 300 m away is the
 * neighbourhood; "Perungudi" six kilometres away, at a point our own zone
 * polygon puts in Zone 14 Perungudi, is the zone. Null means the name is
 * not one of the places we hold within `searchM` — not proof of anything,
 * since plenty of real neighbourhoods are unmapped.
 */
export function nearestNamed(
  pack: GeoPack | null,
  name: string,
  lat: number,
  lng: number,
  searchM = 8_000
): Place | null {
  const d = decoded(pack);
  const want = squash(name);
  if (!d || !want) return null;
  // Names compared before anything is built: in the statewide pack this
  // square holds thousands of places and only the matches matter. A
  // common name far away ("Gandhi Nagar" exists everywhere) is not
  // evidence about this one, which is why the search stops at 8 km.
  let best = -1;
  let bestM = Infinity;
  forEachNear(d, lat, lng, searchM, (i, m) => {
    if (m >= bestM) return;
    let hit = squash(d.names[i]) === want;
    if (!hit) {
      for (const map of Object.values(d.local)) {
        const v = map[i];
        if (v && squash(v) === want) {
          hit = true;
          break;
        }
      }
    }
    if (hit) {
      best = i;
      bestM = m;
    }
  });
  return best < 0 ? null : placeAt(d, best, lat, lng);
}

/** Display name in the card's language, falling back to the OSM name. */
export function placeLabel(p: Place, lang: string): string {
  return p.local?.[lang] ?? p.name;
}
