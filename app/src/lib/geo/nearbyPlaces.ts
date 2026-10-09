/**
 * What is within a few tens of metres of the photographer, by name — the
 * address chooser's list (components/AddressPicker.tsx).
 *
 * No single source knows the buildings and tenants around a point, so
 * this asks several at once and merges what comes back:
 *  - the phone's own geocoder, probed at the point and four points around
 *    it (NativeBridgePlugin.nearbyAddresses) — street addresses, and the
 *    building or premises name when it has one;
 *  - OpenStreetMap: named buildings, offices and shops within the radius
 *    (Overpass), and the building-level reverse lookup (Nominatim);
 *  - Google Places, with the user's own key only.
 *
 * Which of them run follows the geocoder setting, so a user who chose the
 * phone's geocoder alone, for privacy, is not sent to OpenStreetMap by
 * the back door — and "off" means no lookup at all: the chooser offers
 * typing instead. Everything here runs only when the person opens the
 * chooser.
 */
import { useSettingsStore } from "../../store";
import { nativeNearbyAddresses, nativeSearchAddresses, type NativePlace } from "../native";
import { metresBetween } from "./addressPins";
import { cleanAddress } from "../geocode";

export interface PlaceCandidate {
  key: string;
  /** the place's own name: building, office, shop */
  title?: string;
  /** the address to print; empty when the source has only a name */
  address: string;
  lat?: number;
  lng?: number;
  /** metres from the photographer */
  distance?: number;
  source: "phone" | "osm" | "google";
}

type Source = PlaceCandidate["source"];

/** What one source came back with — shown in the chooser, so "why only
 *  OpenStreetMap?" answers itself. */
export interface SourceReport {
  source: Source;
  /** answered, did not answer in time, or Google without a key */
  state: "ok" | "failed" | "no-key";
  /** results it returned at all */
  found: number;
  /** of those, places within reach that made the list */
  kept: number;
}
type At = { lat: number; lng: number };

/** The user's own "50 metres". */
export const NEARBY_RADIUS_M = 50;
/** A candidate can sit a little outside the radius — GPS is not exact. */
const NEARBY_KEEP_M = 80;
/** How far a SEARCH result may be from the photographer and still label
 *  the photo: farther than this, it is a different place. */
export const SEARCH_USABLE_M = 150;
const TIMEOUT_MS = 9000;

function sources(): Source[] {
  const { geocoder } = useSettingsStore.getState().settings;
  const google: Source[] = ["google"];
  switch (geocoder) {
    case "off":
      return [];
    case "system":
      return ["phone"];
    case "nominatim":
      return ["osm"];
    case "google":
      return [...google, "phone"];
    default:
      return ["phone", "osm", ...google];
  }
}

/** Whether the chooser can look anything up at all. */
export function lookupsEnabled(): boolean {
  return sources().length > 0;
}

async function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((r) => setTimeout(() => r(fallback), TIMEOUT_MS)),
  ]);
}

// ---- the phone's geocoder ------------------------------------------------

/** The geocoder's feature name is the building when it has one, and the
 *  house number or the road name when it does not — only the first is a
 *  title worth printing. */
function featureTitle(p: NativePlace): string | undefined {
  const f = (p.premises ?? p.feature ?? "").trim();
  if (!f || /^\d+[a-z]?$/i.test(f) || f === p.thoroughfare || f === p.subThoroughfare) {
    return undefined;
  }
  if (p.line.startsWith(f) && /^\d/.test(f)) return undefined;
  return f;
}

/** "26RM+6F4" — what Google's geocoder calls a spot it has no name for. */
const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}\b/i;

function fromPhone(list: NativePlace[], at: At): PlaceCandidate[] {
  // a Plus Code is a grid square, not a place anyone would put on a card
  return list.filter((p) => !PLUS_CODE.test(p.line.trim())).map((p) => ({
    key: `phone:${p.line}`,
    title: featureTitle(p),
    address: p.line,
    lat: p.lat,
    lng: p.lng,
    distance: p.lat != null && p.lng != null ? metresBetween(at, { lat: p.lat, lng: p.lng }) : undefined,
    source: "phone" as const,
  }));
}

// ---- OpenStreetMap ------------------------------------------------------------

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function osmAddress(t: Record<string, string>): string {
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  return [street, t["addr:suburb"], t["addr:city"], t["addr:postcode"]].filter(Boolean).join(", ");
}

async function overpassNearby(at: At, lang: string): Promise<PlaceCandidate[]> {
  const q =
    `[out:json][timeout:8];` +
    `(nwr(around:${NEARBY_RADIUS_M},${at.lat},${at.lng})[name];);out center 40;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: new URLSearchParams({ data: q }),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { elements?: OsmElement[] };
  const out: PlaceCandidate[] = [];
  for (const e of j.elements ?? []) {
    const t = e.tags ?? {};
    // roads are what an address is made of, not a place to choose
    if (t.highway || t.boundary || t.route) continue;
    const name = t[`name:${lang}`] ?? t.name;
    const lat = e.lat ?? e.center?.lat;
    const lng = e.lon ?? e.center?.lon;
    if (!name || lat == null || lng == null) continue;
    out.push({
      key: `osm:${e.type}/${e.id}`,
      title: name,
      address: osmAddress(t),
      lat,
      lng,
      distance: metresBetween(at, { lat, lng }),
      source: "osm",
    });
  }
  return out;
}

async function nominatimBuilding(at: At, lang: string): Promise<PlaceCandidate[]> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${at.lat}&lon=${at.lng}&zoom=18&addressdetails=1&namedetails=1`;
  const r = await fetch(url, {
    headers: { "Accept-Language": lang === "en" ? "en" : `${lang},en` },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as {
    osm_type?: string;
    osm_id?: number;
    name?: string;
    category?: string;
    display_name?: string;
    lat?: string;
    lon?: string;
  };
  if (!j.display_name) return [];
  // the nearest object is often a road or trail: its name is part of an
  // address, not a place to choose
  if (j.category === "highway") j.name = undefined;
  const lat = Number(j.lat);
  const lng = Number(j.lon);
  return [
    {
      key: `osm:${j.osm_type}/${j.osm_id}`,
      title: j.name || undefined,
      address: j.display_name.replace(/,\s*India$/, ""),
      lat,
      lng,
      distance: Number.isFinite(lat) ? metresBetween(at, { lat, lng }) : undefined,
      source: "osm",
    },
  ];
}

async function nominatimSearch(query: string, at: At, lang: string): Promise<PlaceCandidate[]> {
  const d = 0.015; // ~1.6 km either way
  const url =
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&bounded=1` +
    `&viewbox=${at.lng - d},${at.lat + d},${at.lng + d},${at.lat - d}` +
    `&q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: { "Accept-Language": lang === "en" ? "en" : `${lang},en` },
  });
  if (!r.ok) return [];
  const j = (await r.json()) as {
    osm_type: string;
    osm_id: number;
    name?: string;
    display_name: string;
    lat: string;
    lon: string;
  }[];
  return j.map((x) => {
    const lat = Number(x.lat);
    const lng = Number(x.lon);
    return {
      key: `osm:${x.osm_type}/${x.osm_id}`,
      title: x.name || undefined,
      address: x.display_name.replace(/,\s*India$/, ""),
      lat,
      lng,
      distance: metresBetween(at, { lat, lng }),
      source: "osm" as const,
    };
  });
}

// ---- Google Places (the user's own key) ------------------------------------------

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude: number; longitude: number };
}

async function googlePlaces(
  endpoint: "searchNearby" | "searchText",
  body: Record<string, unknown>,
  at: At
): Promise<PlaceCandidate[]> {
  const key = useSettingsStore.getState().settings.googleApiKey;
  if (!key) return [];
  const r = await fetch(`https://places.googleapis.com/v1/places:${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return [];
  const j = (await r.json()) as { places?: GooglePlace[] };
  return (j.places ?? []).map((p) => {
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    return {
      key: `google:${p.id ?? p.formattedAddress}`,
      title: p.displayName?.text,
      address: (p.formattedAddress ?? "").replace(/,\s*India$/, ""),
      lat,
      lng,
      distance: lat != null && lng != null ? metresBetween(at, { lat, lng }) : undefined,
      source: "google" as const,
    };
  });
}

// ---- merging ---------------------------------------------------------------------

/** An address as the card would print it: no country, ward or zone
 *  wording (the card has its own rows for those), no grid codes. */
function tidy(address: string): string {
  if (!address) return "";
  return cleanAddress(address)
    .split(/,\s*/)
    .filter((seg) => !/\bdistrict$/i.test(seg))
    .join(", ");
}

/**
 * Name and detail for the list. A result with no name of its own leads
 * with its house number and street ("16, Nageswaran Rao Rd") — what tells
 * one door from the next — and keeps the rest muted below.
 */
export function listLines(c: PlaceCandidate): { name: string; line?: string } {
  if (c.title) {
    // "Venkatanarayana Road" over "Venkatanarayana Road, Kodambakkam…"
    const line = c.address.startsWith(`${c.title}, `) ? c.address.slice(c.title.length + 2) : c.address;
    return { name: c.title, line: line || undefined };
  }
  const segs = c.address.split(/,\s*/);
  const head = /^\d+[\w/-]*$/.test(segs[0] ?? "") && segs.length > 1 ? 2 : 1;
  const rest = segs.slice(head).join(", ");
  return { name: segs.slice(0, head).join(", "), line: rest || undefined };
}

function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** One entry per place: the same building from two sources is listed once,
 *  keeping the version that carries the most. */
function merge(lists: PlaceCandidate[][]): PlaceCandidate[] {
  const byKey = new Map<string, PlaceCandidate>();
  for (const raw of lists.flat()) {
    const c = { ...raw, address: tidy(raw.address) };
    if (!c.title && !c.address) continue;
    const k = c.title ? `t:${norm(c.title)}` : `a:${norm(c.address)}`;
    const had = byKey.get(k);
    const richness = (x: PlaceCandidate) => (x.title ? 2 : 0) + (x.address ? x.address.length / 1000 : 0);
    if (!had || richness(c) > richness(had)) byKey.set(k, c);
  }
  return [...byKey.values()].sort(
    (a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9)
  );
}

/** Named places and addresses within about NEARBY_RADIUS_M of `at`,
 *  and what each source returned. */
export async function nearbyCandidates(
  at: At,
  lang: string
): Promise<{ places: PlaceCandidate[]; report: SourceReport[] }> {
  const use = sources();
  const hasKey = Boolean(useSettingsStore.getState().settings.googleApiKey);
  const isNative = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  const none = Promise.resolve(null);
  const [phone, overpass, building, google] = await Promise.all([
    use.includes("phone") && isNative
      ? withTimeout(
          nativeNearbyAddresses(at.lat, at.lng, NEARBY_RADIUS_M, lang).then((l) => (l ? fromPhone(l, at) : null)),
          null
        )
      : none,
    use.includes("osm") ? withTimeout(overpassNearby(at, lang), null) : none,
    use.includes("osm") ? withTimeout(nominatimBuilding(at, lang), null) : none,
    use.includes("google") && hasKey
      ? withTimeout(
          googlePlaces(
            "searchNearby",
            {
              maxResultCount: 20,
              rankPreference: "DISTANCE",
              languageCode: lang,
              locationRestriction: {
                circle: { center: { latitude: at.lat, longitude: at.lng }, radius: NEARBY_RADIUS_M },
              },
            },
            at
          ),
          null
        )
      : none,
  ]);
  const places = merge([phone ?? [], overpass ?? [], building ?? [], google ?? []])
    .filter((c) => c.distance == null || c.distance <= NEARBY_KEEP_M)
    .slice(0, 25);
  const kept = (src: Source) => places.filter((p) => p.source === src).length;
  const report: SourceReport[] = [];
  if (use.includes("phone") && isNative) {
    report.push({ source: "phone", state: phone ? "ok" : "failed", found: phone?.length ?? 0, kept: kept("phone") });
  }
  if (use.includes("osm")) {
    const ok = overpass != null || building != null;
    report.push({
      source: "osm",
      state: ok ? "ok" : "failed",
      found: (overpass?.length ?? 0) + (building?.length ?? 0),
      kept: kept("osm"),
    });
  }
  if (use.includes("google")) {
    report.push(
      hasKey
        ? { source: "google", state: google ? "ok" : "failed", found: google?.length ?? 0, kept: kept("google") }
        : { source: "google", state: "no-key", found: 0, kept: 0 }
    );
  }
  return { places, report };
}

/** Places matching `query` around `at`, nearest first. Results farther
 *  than SEARCH_USABLE_M are returned too — the chooser shows them as too
 *  far to use, so the person knows the search worked. */
export async function searchCandidates(query: string, at: At, lang: string): Promise<PlaceCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const use = sources();
  const lists = await Promise.all([
    use.includes("phone")
      ? withTimeout(nativeSearchAddresses(q, at.lat, at.lng, 1.5, lang).then((l) => fromPhone(l, at)), [] as PlaceCandidate[])
      : [],
    use.includes("osm") ? withTimeout(nominatimSearch(q, at, lang), []) : [],
    use.includes("google")
      ? withTimeout(
          googlePlaces(
            "searchText",
            {
              textQuery: q,
              maxResultCount: 10,
              languageCode: lang,
              locationBias: {
                circle: { center: { latitude: at.lat, longitude: at.lng }, radius: 1500 },
              },
            },
            at
          ),
          []
        )
      : [],
  ]);
  return merge(lists).slice(0, 20);
}
