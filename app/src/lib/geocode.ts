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
import { langsFor } from "./i18n/languages";
import { cachedAddress, rememberAddress } from "./geocache";
import { currentPackId, loadGeodataFor } from "./geo/geodata";
import { lookup } from "./geo/lookup";
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

/** Does this text actually contain the script we asked for? */
const SCRIPT_OF: Record<string, RegExp> = {
  ta: /[\u0B80-\u0BFF]/,
  hi: /[\u0900-\u097F]/,
  mr: /[\u0900-\u097F]/,
  kn: /[\u0C80-\u0CFF]/,
  te: /[\u0C00-\u0C7F]/,
  bn: /[\u0980-\u09FF]/,
};

function inLanguage(text: string | undefined, lang: string): boolean {
  const re = SCRIPT_OF[lang];
  if (!re) return true; // English, or a language with no script test
  return !!text && re.test(text);
}

/**
 * What our OWN offline data says is true of this point.
 *
 * The packs are authoritative for jurisdiction — they are the reason the
 * app exists — so they are also the yardstick for whether an outside
 * geocoder's answer is plausible.
 */
async function localTruth(lat: number, lng: number): Promise<string[]> {
  try {
    const pack = await loadGeodataFor(lat, lng);
    if (!pack) return [];
    const j = lookup(pack, lat, lng).jurisdiction;
    if (!j || j.scope === "out") return [];
    // loMeta/trafficMeta are "AC · DC · Zone" / "Sub-Division · District"
    // strings. They matter: a municipality's own ULB feature often has no
    // district field, and the district is exactly what an outside
    // geocoder is most likely to name correctly ("… Chengalpattu").
    const meta = [j.loMeta, j.trafficMeta]
      .filter((v): v is string => typeof v === "string")
      .flatMap((v) => v.split("·"));
    return [
      j.city,
      j.district,
      j.corporation,
      j.wardName,
      j.zone,
      j.block,
      ...meta,
    ]
      .map((v) => (typeof v === "string" ? v.trim() : v))
      .filter((v): v is string => typeof v === "string" && v.length > 2);
  } catch {
    return [];
  }
}

/** Spaces and case are not signal: "Maraimalainagar" vs "Maraimalai Nagar". */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Does this answer name anywhere our own data places this point?
 *
 * Android's Geocoder returned "17, Kambar St, Potheri, Kuilkuppam,
 * Velachery, Chennai, Kattankulathur" for a point our packs put in
 * Maraimalainagar Municipality, Chengalpattu — Velachery is a Chennai
 * neighbourhood 25 km away, and the card ended up titled with it. The
 * same point in the browser (Nominatim) answered "Sattamangalam,
 * Kattangulathur, Chengalpattu", which names the district we resolved.
 *
 * So: an answer that names the resolved city, district, body, ward or
 * zone is corroborated; one that names none of them is not trusted, and
 * the next provider gets a turn. Nothing is REJECTED outright — if no
 * provider corroborates, the first answer is still used, because a
 * possibly-imprecise address beats no address at all.
 */
function corroborated(r: GeocodeResult | null, truth: string[]): boolean {
  if (!r?.address || truth.length === 0) return true; // nothing to check against
  const hay = squash(`${r.address} ${r.locality ?? ""}`);
  return truth.some((t) => {
    const needle = squash(t);
    return needle.length > 3 && hay.includes(needle);
  });
}

async function remember(
  lat: number,
  lng: number,
  lang: string,
  r: GeocodeResult | null
): Promise<GeocodeResult | null> {
  if (r) void rememberAddress(lat, lng, lang, r);
  return r;
}

export async function reverseGeocode(
  lat: number,
  lng: number
): Promise<GeocodeResult | null> {
  const { settings, watermark } = useSettingsStore.getState();
  const mode = settings.geocoder;
  if (mode === "off") return null;
  // Ask for the address in the card's language ONLY where that language
  // is actually local. A Tamil card in Bengaluru was getting a Tamil
  // TRANSLITERATION of a Kannada address — "Inner Circle Municipal Park"
  // respelt in Tamil letters — which is neither language and helps
  // nobody. Outside its home region the address comes back in English
  // while the labels stay in the chosen language.
  const chosen = langOf(watermark.language);
  const local = langsFor(currentPackId());
  const lang = local.includes(chosen) ? chosen : "en";
  const stateFallback = STATE_FALLBACK[lang] ?? STATE_FALLBACK.en;

  // A place we have already asked about answers instantly and costs the
  // provider nothing. Same cell, same language, within a month.
  const remembered = await cachedAddress(lat, lng, lang);
  // `address` is required on a result; a cache entry holding only a
  // locality is not a usable answer, so fall through and ask properly
  if (remembered?.address) {
    return { address: remembered.address, locality: remembered.locality };
  }

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
    /**
     * Android's Geocoder takes a Locale but frequently answers in English
     * anyway, so asking politely is not enough. When the user has chosen a
     * local language, check what came back and go to a provider that
     * honours the language parameter if the script is wrong. The
     * English answer is kept as the fallback — a right address in the
     * wrong language beats no address.
     */
    const localised = async (
      first: GeocodeResult | null
    ): Promise<GeocodeResult | null> => {
      if (lang === "en" || inLanguage(first?.address, lang)) return first;
      if (!navigator.onLine) return first;
      if (settings.googleApiKey) {
        const g = await google(lat, lng, settings.googleApiKey, lang);
        if (inLanguage(g?.address, lang)) return g;
      }
      const n = await nominatim(lat, lng, lang);
      if (inLanguage(n?.address, lang)) return n;
      return first;
    };

    // A pinned provider is a deliberate choice — honour it as asked.
    if (mode === "system")
      return remember(lat, lng, lang, await localised(await trySystem()));
    if (mode === "google")
      return settings.googleApiKey
        ? remember(lat, lng, lang, await google(lat, lng, settings.googleApiKey, lang))
        : null;
    if (mode === "mappls")
      return settings.mapplsApiKey
        ? remember(lat, lng, lang, await mappls(lat, lng, settings.mapplsApiKey))
        : null;
    if (mode === "nominatim")
      return remember(lat, lng, lang, await nominatim(lat, lng, lang));

    /**
     * auto: system → google (keyed) → mappls (keyed) → nominatim.
     *
     * Each answer is checked against our own offline jurisdiction before
     * it is accepted. An uncorroborated answer does not stop the chain —
     * it is kept as the fallback and the next provider gets a turn — so
     * this can only ever improve on the old "first non-null wins", never
     * leave a capture with no address.
     */
    const truth = await localTruth(lat, lng);
    let fallback: GeocodeResult | null = null;
    const consider = (r: GeocodeResult | null): GeocodeResult | null => {
      if (!r) return null;
      if (corroborated(r, truth)) return r;
      fallback ??= r;
      return null;
    };

    const sys = consider(await trySystem());
    if (sys) return remember(lat, lng, lang, await localised(sys));
    if (settings.googleApiKey) {
      const g = consider(await google(lat, lng, settings.googleApiKey, lang));
      if (g) return remember(lat, lng, lang, g);
    }
    if (settings.mapplsApiKey) {
      const m = consider(await mappls(lat, lng, settings.mapplsApiKey));
      if (m) return remember(lat, lng, lang, m);
    }
    const n = consider(await nominatim(lat, lng, lang));
    if (n) return remember(lat, lng, lang, n);
    // nobody agreed with our own data; the first answer still beats none
    return remember(lat, lng, lang, fallback);
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
