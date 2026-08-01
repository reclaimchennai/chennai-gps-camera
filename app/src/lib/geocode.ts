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
import { langOf } from "./watermark/signboard";
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
 * Country names to drop, in every script we render.
 *
 * The rule only matched lowercase "india", so a Tamil address kept
 * "இந்தியா" on the card. The country adds nothing — the app is for Indian
 * civic bodies — while the STATE is worth keeping, which is the opposite
 * of what this did before.
 */
const COUNTRY = new Set(
  [
    "india", "bharat", "भारत", "इंडिया", "இந்தியா", "ಭಾರತ", "ಇಂಡಿಯಾ",
    "భారతదేశం", "ఇండియా", "ভারত", "ইন্ডিয়া",
  ].map((c) => c.toLowerCase())
);

/**
 * Address cleanup:
 *  - drop the country segment in any script; KEEP the state
 *  - drop administrative noise ("CMWSSB Division 61", "Ward 61")
 *  - strip zone prefixes from area names ("Zone 5 Royapuram" → "Royapuram")
 *  - join the trailing pincode as "Chennai - 600008"
 */
function cleanAddress(address: string, state?: string): string {
  const st = state?.toLowerCase();
  const out: string[] = [];
  for (let seg of address.split(/,\s*/).map((s) => s.trim())) {
    const low = seg.toLowerCase();
    if (!seg || COUNTRY.has(low)) continue;
    if (/^cmwssb\s+division\s*\d+$/i.test(seg)) continue;
    if (/^ward\s*\d+[a-z]?$/i.test(seg)) continue;
    if (/^zone\s*\d+$/i.test(seg)) continue;
    seg = seg.replace(/^zone\s*\d+\s+/i, "");
    // "Tamil Nadu 600017" arrives as one segment — split it so the state
    // reads as a state and the pincode joins the tail properly
    if (st && low.startsWith(`${st} `) && /\d{6}$/.test(seg)) {
      out.push(seg.slice(0, st.length).trim());
      seg = seg.slice(st.length).trim();
    }
    if (!seg || out[out.length - 1]?.toLowerCase() === seg.toLowerCase()) continue;
    out.push(seg);
  }
  let joined = out.join(", ") || address;
  // "…, Chennai, 600008" → "…, Chennai - 600008"
  joined = joined.replace(/,\s*(\d{6})$/, " - $1");
  return joined;
}

async function nominatim(
  lat: number,
  lng: number,
  lang: string
): Promise<GeocodeResult | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
    `&lat=${lat}&lon=${lng}&zoom=17&addressdetails=1`;
  // ask for the card's language but keep English as the fallback rung, so
  // a place with no Tamil name still comes back named rather than blank
  const r = await fetch(url, {
    headers: { "Accept-Language": lang === "en" ? "en" : `${lang},en` },
  });
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
  key: string,
  lang: string
): Promise<GeocodeResult | null> {
  const url =
    `https://maps.googleapis.com/maps/api/geocode/json` +
    `?latlng=${lat},${lng}&key=${encodeURIComponent(key)}` +
    `&language=${encodeURIComponent(lang)}`;
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

/**
 * The address is watermark content, so it follows the card's language —
 * every provider here can answer in Tamil or Hindi (Android's Geocoder
 * takes a Locale, Google takes `language`, Nominatim takes
 * Accept-Language). Mappls is left alone: it has no documented language
 * parameter, so asking would silently return English and only look like
 * it worked.
 *
 * State names in the cleanup fallbacks stay per-language too, otherwise
 * a Tamil address keeps an English "Tamil Nadu" segment that the
 * strip-the-state rule then fails to match.
 */
const STATE_FALLBACK: Record<string, string> = {
  en: "Tamil Nadu",
  ta: "\u0ba4\u0bae\u0bbf\u0bb4\u0bcd\u0ba8\u0bbe\u0b9f\u0bc1",
  hi: "\u0924\u092e\u093f\u0932\u0928\u093e\u0921\u0941",
};

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<GeocodeResult | null> {
  const { settings, watermark } = useSettingsStore.getState();
  const mode = settings.geocoder;
  if (mode === "off") return null;
  const lang = langOf(watermark.language);
  const stateFallback = STATE_FALLBACK[lang] ?? STATE_FALLBACK.en;
  try {
    const trySystem = async () => {
      // APK build: the OS geocoder answers offline-fast and costs nothing
      // (no-op in the browser)
      const n = await nativeReverseGeocode(lat, lng, lang);
      return n
        ? {
            address: cleanAddress(n.addressLine, n.adminArea ?? stateFallback),
            locality: joinLocality(n.subLocality, n.locality),
          }
        : null;
    };
    if (mode === "system") return await trySystem();
    if (mode === "google")
      return settings.googleApiKey
        ? await google(lat, lng, settings.googleApiKey, lang)
        : null;
    if (mode === "mappls")
      return settings.mapplsApiKey
        ? await mappls(lat, lng, settings.mapplsApiKey)
        : null;
    if (mode === "nominatim") return await nominatim(lat, lng, lang);

    // auto: system → google (keyed) → mappls (keyed) → nominatim
    const sys = await trySystem();
    if (sys) return sys;
    if (settings.googleApiKey) {
      const g = await google(lat, lng, settings.googleApiKey, lang);
      if (g) return g;
    }
    if (settings.mapplsApiKey) {
      const m = await mappls(lat, lng, settings.mapplsApiKey);
      if (m) return m;
    }
    return await nominatim(lat, lng, lang);
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
