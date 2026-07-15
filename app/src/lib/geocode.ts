/**
 * Reverse geocoding — strictly background/backfill, never on the capture
 * path (§7).
 *
 * Providers:
 *  - google: the owner's own Google Cloud key (Geocoding API). Not
 *    provisioned by default; enabled by pasting a key in Settings.
 *  - nominatim: free OSM fallback, same service the sibling
 *    police-locator app uses. Light usage fits the fair-use policy;
 *    attribution lives on the About screen.
 */
import { useSettingsStore } from "../store";

export interface GeocodeResult {
  address: string;
  /** Display-ready city-level line, e.g. "Kodambakkam, Chennai". */
  locality?: string;
}

/** "Zone 5 Royapuram" → "Royapuram" (OSM suburbs carry the zone prefix). */
function cleanArea(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/^zone\s*\d+\s*/i, "").trim();
  return cleaned || undefined;
}

function joinLocality(
  suburb: string | undefined,
  city: string | undefined
): string | undefined {
  const area = cleanArea(suburb);
  if (area && city && !area.includes(city)) return `${area}, ${city}`;
  return area ?? city;
}

/**
 * City-level address cleanup:
 *  - drop state + country segments ("Tamil Nadu", "India")
 *  - drop administrative noise ("CMWSSB Division 61", "Ward 61")
 *  - strip zone prefixes from area names ("Zone 5 Royapuram" → "Royapuram")
 *  - join the trailing pincode as "Chennai - 600008"
 */
function cleanAddress(address: string, state?: string): string {
  const st = state?.toLowerCase();
  const out: string[] = [];
  for (let seg of address.split(/,\s*/).map((s) => s.trim())) {
    const low = seg.toLowerCase();
    if (!seg || low === "india") continue;
    if (st && low === st) continue;
    if (/^cmwssb\s+division\s*\d+$/i.test(seg)) continue;
    if (/^ward\s*\d+[a-z]?$/i.test(seg)) continue;
    if (/^zone\s*\d+$/i.test(seg)) continue;
    seg = seg.replace(/^zone\s*\d+\s+/i, "");
    // "Tamil Nadu 600017" → keep the pincode
    if (st && low.startsWith(`${st} `)) seg = seg.slice(st.length).trim();
    if (!seg || out[out.length - 1]?.toLowerCase() === seg.toLowerCase()) continue;
    out.push(seg);
  }
  let joined = out.join(", ") || address;
  // "…, Chennai, 600008" → "…, Chennai - 600008"
  joined = joined.replace(/,\s*(\d{6})$/, " - $1");
  return joined;
}

async function nominatim(lat: number, lng: number): Promise<GeocodeResult | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`;
  const r = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    display_name?: string;
    address?: Record<string, string>;
  };
  if (!j.display_name) return null;
  const a = j.address ?? {};
  return {
    address: cleanAddress(j.display_name, a.state ?? "Tamil Nadu"),
    locality: joinLocality(
      a.suburb ?? a.neighbourhood ?? a.quarter ?? a.city_district,
      a.city ?? a.town ?? a.village ?? a.municipality
    ),
  };
}

async function google(
  lat: number,
  lng: number,
  key: string
): Promise<GeocodeResult | null> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?latlng=${lat},${lng}&key=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as {
    status: string;
    results?: {
      formatted_address: string;
      address_components: { long_name: string; types: string[] }[];
    }[];
  };
  const first = j.results?.[0];
  if (j.status !== "OK" || !first) return null;
  const comp = (type: string) =>
    first.address_components.find((c) => c.types.includes(type))?.long_name;
  return {
    address: cleanAddress(
      first.formatted_address,
      comp("administrative_area_level_1") ?? "Tamil Nadu"
    ),
    locality: joinLocality(
      comp("sublocality_level_1") ?? comp("sublocality"),
      comp("locality")
    ),
  };
}

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<GeocodeResult | null> {
  const { settings } = useSettingsStore.getState();
  if (settings.geocoder === "off") return null;
  try {
    if (
      settings.googleApiKey &&
      (settings.geocoder === "google" || settings.geocoder === "auto")
    ) {
      const g = await google(lat, lng, settings.googleApiKey);
      if (g) return g;
      if (settings.geocoder === "google") return null;
    }
    if (settings.geocoder === "google") return null;
    return await nominatim(lat, lng);
  } catch {
    return null;
  }
}

/** Google Static Maps thumbnail for the online mini-map upgrade (§5.4). */
export async function fetchGoogleMiniMap(
  lat: number,
  lng: number
): Promise<ImageBitmap | null> {
  const { settings, watermark } = useSettingsStore.getState();
  if (!settings.googleApiKey || !watermark.onlineMapUpgrade) return null;
  try {
    const url =
      `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}` +
      `&zoom=16&size=256x256&scale=2&markers=color:red%7C${lat},${lng}` +
      `&key=${encodeURIComponent(settings.googleApiKey)}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    return await createImageBitmap(await r.blob());
  } catch {
    return null;
  }
}
