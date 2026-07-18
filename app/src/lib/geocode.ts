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
 *  - native (APK build only): android.location.Geocoder in English —
 *    tried first because it needs no key, no quota, and no third party.
 */
import { useSettingsStore } from "../store";
import { nativeReverseGeocode } from "./native";

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

/** Mappls (MapmyIndia) reverse geocode — user-supplied key. */
async function mappls(
  lat: number,
  lng: number,
  key: string
): Promise<GeocodeResult | null> {
  const url =
    `https://apis.mappls.com/advancedmaps/v1/${encodeURIComponent(key)}` +
    `/rev_geocode?lat=${lat}&lng=${lng}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = (await r.json()) as {
    results?: {
      formatted_address?: string;
      locality?: string;
      subLocality?: string;
      city?: string;
      district?: string;
      state?: string;
    }[];
  };
  const first = j.results?.[0];
  if (!first?.formatted_address) return null;
  return {
    address: cleanAddress(first.formatted_address, first.state ?? "Tamil Nadu"),
    locality: joinLocality(
      first.subLocality ?? first.locality,
      first.city ?? first.district
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
  const mode = settings.geocoder;
  if (mode === "off") return null;
  try {
    const trySystem = async () => {
      // APK build: the OS geocoder answers offline-fast in English and
      // costs nothing (no-op in the browser)
      const n = await nativeReverseGeocode(lat, lng);
      return n
        ? {
            address: cleanAddress(n.addressLine, n.adminArea ?? "Tamil Nadu"),
            locality: joinLocality(n.subLocality, n.locality),
          }
        : null;
    };
    if (mode === "system") return await trySystem();
    if (mode === "google")
      return settings.googleApiKey
        ? await google(lat, lng, settings.googleApiKey)
        : null;
    if (mode === "mappls")
      return settings.mapplsApiKey
        ? await mappls(lat, lng, settings.mapplsApiKey)
        : null;
    if (mode === "nominatim") return await nominatim(lat, lng);

    // auto: system → google (keyed) → mappls (keyed) → nominatim
    const sys = await trySystem();
    if (sys) return sys;
    if (settings.googleApiKey) {
      const g = await google(lat, lng, settings.googleApiKey);
      if (g) return g;
    }
    if (settings.mapplsApiKey) {
      const m = await mappls(lat, lng, settings.mapplsApiKey);
      if (m) return m;
    }
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
