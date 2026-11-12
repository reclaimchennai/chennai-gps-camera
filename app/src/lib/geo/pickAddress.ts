/**
 * Which of the phone geocoder's answers names the street you are on.
 *
 * Android's Geocoder (Google's data) answers a point with the nearest
 * BUILDINGS it has an address for, nearest-ish first, and the app used to
 * print the first one. A building's address is the street its door faces,
 * and a corner plot faces the side street: standing on Brindavan Nagar
 * Main Road, 7 m from the Mohanapuri 4th Street junction, the first answer
 * was "Plot No-63, 4th St" — and a GPS wobble of a few metres flipped it
 * back and forth. The answers just behind it were 46 and 45A Brindavan
 * Nagar Main Road, 10–12 m away.
 *
 * So the answers vote. Each one that names a street, within reach, votes
 * for that street with a weight that falls off with its distance from the
 * fix (GPS on a phone is good to 5–10 m, so a building 10 m off and one
 * 15 m off are nearly equal evidence, and one 40 m off is weak). The street
 * with the most weight wins, and its nearest building gives the address
 * line — the door number nearest to where the photo was taken.
 *
 * Near a junction the vote can still go either way: 4 m from that corner
 * Google had two buildings on 4th Street (filed under two spellings) and
 * one on the main road. Google's answers are buildings; OpenStreetMap has
 * the road lines themselves, and says which one the point is on. So when
 * the answers disagree about the street, OSM's road is asked for, and if
 * it is one of the streets Google offered, it decides.
 *
 * Pure: the results come in, a choice and its reason come out.
 */

export interface GeocodedPlace {
  line: string;
  thoroughfare?: string;
  subLocality?: string;
  locality?: string;
  adminArea?: string;
  subAdminArea?: string;
  lat?: number;
  lng?: number;
}

export interface Pick<T extends GeocodedPlace> {
  chosen: T;
  /** set when the choice is not the geocoder's first answer */
  why?: string;
}

/** a building further than this says nothing about the street you are on */
const REACH_M = 40;
/** the distance at which an answer's vote is worth half a nearby one's */
const HALF_M = 15;

const ABBR = new Map([
  ["rd", "road"],
  ["st", "street"],
  ["ave", "avenue"],
  ["ln", "lane"],
]);

/** "Mohanapuri 4th St." -> "mohanapuri 4th street" */
function streetWords(s: string): string {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => ABBR.get(w) ?? w)
    .join(" ");
}

/** One street under two names: Google files the same road as "4th Street"
 *  on one building and "Mohanapuri 4th Street" on the next. */
function sameStreet(a: string, b: string): boolean {
  return a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`);
}

export function metresBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const x = (lng2 - lng1) * rad * Math.cos(((lat1 + lat2) / 2) * rad);
  const y = (lat2 - lat1) * rad;
  return 6_371_000 * Math.hypot(x, y);
}

interface Street<T> {
  key: string;
  name: string;
  score: number;
  nearest: T;
  nearestM: number;
}

/** True when the answers within reach name more than one street — the
 *  only case where asking OpenStreetMap for the road can change anything. */
export function streetsDisagree(results: GeocodedPlace[], lat: number, lng: number): boolean {
  return streetsNear(results, lat, lng).length > 1;
}

export function pickAddress<T extends GeocodedPlace>(
  results: T[],
  lat: number,
  lng: number,
  /** the road OpenStreetMap puts this point on, when it was asked */
  osmRoad?: string
): Pick<T> | null {
  const streets = streetsNear(results, lat, lng);
  // no street near enough to judge: the geocoder's own choice stands
  if (streets.length === 0) return null;

  streets.sort((a, b) => b.score - a.score || a.nearestM - b.nearestM);
  const osmKey = osmRoad ? streetWords(osmRoad) : "";
  const onOsm = osmKey ? streets.find((s) => sameStreet(s.key, osmKey)) : undefined;
  const win = onOsm ?? streets[0];
  const chosen = win.nearest;
  if (chosen === results[0]) return { chosen };
  const first = results[0];
  const firstStreet = first.thoroughfare ? `"${first.thoroughfare}"` : "no street";
  const tally = streets.map((s) => `${s.name} ${s.score.toFixed(2)}`).join(", ");
  const reason = onOsm && onOsm !== streets[0]
    ? `OpenStreetMap puts this point on ${win.name} (vote: ${tally})`
    : onOsm
      ? `${win.name} (vote: ${tally}; OpenStreetMap agrees)`
      : `${win.name} (vote: ${tally})`;
  return {
    chosen,
    why:
      `street: ${reason} — the geocoder's first answer had ${firstStreet}; ` +
      `using the nearest building on ${win.name}, ${Math.round(win.nearestM)} m away`,
  };
}

function streetsNear<T extends GeocodedPlace>(results: T[], lat: number, lng: number): Street<T>[] {
  // A Plus Code answer ("X6P4+7CF, Mohanapuri 4th St…") is Google's name
  // for the exact spot and still says which street it is on; it votes like
  // any other, and if it is chosen the grid code is dropped from the line
  // later (cleanAddress), leaving the street.
  const usable = results.filter((r) => r.line);

  const streets: Street<T>[] = [];
  for (const r of usable) {
    if (!r.thoroughfare || r.lat == null || r.lng == null) continue;
    const m = metresBetween(lat, lng, r.lat, r.lng);
    if (m > REACH_M) continue;
    const key = streetWords(r.thoroughfare);
    if (!key) continue;
    const w = 1 / (1 + (m / HALF_M) ** 2);
    let s = streets.find((x) => sameStreet(x.key, key));
    if (!s) {
      s = { key, name: r.thoroughfare, score: 0, nearest: r, nearestM: m };
      streets.push(s);
    }
    s.score += w;
    if (m < s.nearestM) {
      s.nearest = r;
      s.nearestM = m;
    }
  }
  return streets;
}
