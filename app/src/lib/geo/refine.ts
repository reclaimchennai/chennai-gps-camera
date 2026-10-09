/**
 * Make a geocoder's address name the right places.
 *
 * Geocoders are good at the street and poor at the neighbourhood. For
 * Indian addresses they climb an ADMINISTRATIVE ladder, and the rungs
 * they print as if they were places are often zones and taluks:
 *
 *     Major Mukund Varadharajan Salai, Perungudi, Chennai,
 *     Sholinganallur, Chennai, Tamil Nadu 600100
 *
 * for a point in Pallikaranai. "Perungudi" is Greater Chennai Corporation
 * Zone 14; "Sholinganallur" is the revenue taluk; "Chennai" appears twice
 * because it is both the city and the district. A user read that card and
 * asked why it named two places ten kilometres from home.
 *
 * Our own data can tell those rungs apart. The zone polygon says this
 * point is in Zone 14 Perungudi; the place layer says the nearest place
 * actually called Perungudi is kilometres away and Pallikaranai is 589 m
 * off. So the street stays exactly as the geocoder gave it — that is
 * what it is good at — and the place names are checked:
 *
 *   - a name that is a place near here stays;
 *   - a name that is one of our administrative units (zone, taluk,
 *     district, assembly constituency) and NOT a place near here goes;
 *   - a name that IS a place we hold, but far from here, goes;
 *   - a name we know nothing about stays — plenty of real neighbourhoods
 *     are simply unmapped, and deleting them would be its own error;
 *   - when no checked place survives, ours goes in, before the city.
 *
 * Every decision is written to `notes`, so Diagnostics can show WHY a
 * name was changed — this app has been wrong about places before and the
 * fix has always started with being able to see the reasoning.
 */
import type { Jurisdiction } from "../../types";
import type { GeoPack } from "./geodata";
import { REACH_M, nearestNamed, placeLabel, areaAt, type Place } from "./places";
import { localPlace } from "./local-names";

export interface GeocoderAnswer {
  address?: string;
  locality?: string;
  /** structured fields, where the provider supplies them */
  subLocality?: string;
  /** the taluk / tehsil, on Android */
  subAdminArea?: string;
  /** other areas the provider offered for the same point */
  altSubLocalities?: string[];
}

export interface Refined {
  address?: string;
  locality?: string;
  notes: string[];
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** "Zone 14 Perungudi" -> "Perungudi"; "Madipakkam AC" -> "Madipakkam". */
const bareAdmin = (s: string) =>
  s
    .replace(/^zone\s*\d+\s*/i, "")
    .replace(/\s+(ac|a\.c\.|assembly constituency|taluk|tehsil|mandal|block)$/i, "")
    .trim();

type Verdict = "here" | "far" | "admin" | "unknown";

/** A segment that names itself as an administrative unit. Never a
 *  neighbourhood, whatever the geocoder's intent in printing it. */
const ADMIN_WORDING =
  /\b(district|taluk|tehsil|mandal|sub-?division|zone|block|corporation|municipality|panchayat union|revenue division)\s*$/i;

function judge(
  name: string,
  admin: Set<string>,
  pack: GeoPack | null,
  lat: number,
  lng: number
): { verdict: Verdict; place: Place | null } {
  const place = nearestNamed(pack, name, lat, lng);
  // Twice a place's reach: nearest-node is imprecise at boundaries, and a
  // name a couple of kilometres off inside a big suburb is still honest.
  if (place && place.distance <= REACH_M[place.type] * 2) {
    return { verdict: "here", place };
  }
  if (admin.has(squash(name))) return { verdict: "admin", place };
  if (place) return { verdict: "far", place };
  return { verdict: "unknown", place: null };
}

export function refineGeocode(
  r: GeocoderAnswer,
  j: Jurisdiction | null,
  pack: GeoPack | null,
  lat: number,
  lng: number,
  lang: string
): Refined {
  const notes: string[] = [];
  const cityEn = j?.city?.trim();
  const cityKey = cityEn ? squash(cityEn) : "";
  // the title's city follows the card's script too — "பள்ளிக்கரணை,
  // Chennai" is neither language
  const city =
    cityEn && lang !== "en"
      ? (localPlace(lang, cityEn) ??
        nearestNamed(pack, cityEn, lat, lng, 40_000)?.local?.[lang] ??
        cityEn)
      : cityEn;

  // Our administrative units: names a geocoder may print as if they were
  // places. The city itself is never on this list — it is a place.
  const admin = new Set<string>();
  const addAdmin = (v?: string) => {
    if (!v) return;
    for (const part of v.split("·")) {
      const k = squash(bareAdmin(part));
      if (k && k !== cityKey) admin.add(k);
    }
  };
  addAdmin(j?.zone);
  addAdmin(j?.district);
  addAdmin(j?.block);
  addAdmin(j?.loMeta);
  addAdmin(j?.trafficMeta);
  addAdmin(r.subAdminArea);

  const ours: Place | null = pack ? areaAt(pack, lat, lng) : null;
  // The provider's OWN alternatives come first when one of them checks
  // out as a place near here: same source as the street, so the address
  // reads as one voice. Ours is the fallback when none of them does.
  let areaName = ours ? placeLabel(ours, lang) : j?.area;
  for (const alt of r.altSubLocalities ?? []) {
    if (judge(alt, admin, pack, lat, lng).verdict === "here") {
      areaName = alt;
      notes.push(`area: the geocoder's alternative "${alt}" checks out as near here`);
      break;
    }
  }

  // ---- title -------------------------------------------------------------
  let locality = r.locality;
  const head = (r.subLocality ?? r.locality ?? "").split(",")[0].trim();
  if (head && squash(head) !== cityKey) {
    const { verdict, place } = judge(head, admin, pack, lat, lng);
    if (verdict === "admin" || verdict === "far") {
      const why =
        verdict === "admin"
          ? `"${head}" is an administrative unit here, not the place`
          : `"${head}" is ${Math.round((place?.distance ?? 0) / 100) / 10} km away`;
      if (areaName) {
        locality = city ? `${areaName}, ${city}` : areaName;
        notes.push(`title: ${why} — using ${areaName}`);
      } else {
        locality = city;
        notes.push(`title: ${why} — using the city`);
      }
    }
  } else if (!head && areaName) {
    locality = city ? `${areaName}, ${city}` : areaName;
    notes.push(`title: geocoder gave no area — using ${areaName}`);
  }

  // ---- address line ----------------------------------------------------
  let address = r.address;
  if (address) {
    const segs = address.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
    const kept: string[] = [];
    let placeHere = false;
    let cityAt = -1;
    segs.forEach((seg, i) => {
      const key = squash(seg.replace(/\s*-?\s*\d{6}$/, ""));
      // The first segment is the street or the building — the part the
      // geocoder is actually good at — and is never second-guessed. Nor
      // is the last (state and PIN), nor anything with a number in it
      // (a door number, "4th Cross Street").
      if (
        i === 0 ||
        i === segs.length - 1 ||
        !key ||
        /\d/.test(seg.replace(/\s*-?\s*\d{6}$/, ""))
      ) {
        kept.push(seg);
        return;
      }
      // Says what it is: "Chennai District", "Sholinganallur Taluk".
      if (ADMIN_WORDING.test(seg)) {
        notes.push(`address: dropped "${seg}" — administrative unit by its own name`);
        return;
      }
      if (key === cityKey) {
        // "Chennai" once, as the city — not again as the district
        if (cityAt >= 0) {
          notes.push(`address: dropped repeated "${seg}" — the city is named once, not again as its district`);
          return;
        }
        cityAt = kept.length;
        kept.push(seg);
        return;
      }
      const { verdict, place } = judge(seg, admin, pack, lat, lng);
      if (verdict === "admin") {
        notes.push(`address: dropped "${seg}" — administrative unit, not a place here`);
        return;
      }
      if (verdict === "far") {
        notes.push(
          `address: dropped "${seg}" — the place of that name is ` +
            `${Math.round((place?.distance ?? 0) / 100) / 10} km away`
        );
        return;
      }
      if (verdict === "here") placeHere = true;
      if (kept.some((k) => squash(k) === squash(seg))) return;
      kept.push(seg);
    });
    if (!placeHere && areaName && !kept.some((k) => squash(k) === squash(areaName))) {
      const at = cityAt >= 0 ? cityAt : Math.max(1, kept.length - 1);
      kept.splice(at, 0, areaName);
      notes.push(`address: added ${areaName} — no checked place was left in it`);
    }
    address = kept.join(", ").replace(/,\s*(\d{6})$/, " - $1");
  }

  return { address, locality, notes };
}
