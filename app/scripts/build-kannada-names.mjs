/**
 * Kannada names for Bengaluru's wards, zones, corporations and police
 * stations, generated from bengawalk's officials.json.
 *
 * These are the government's own Kannada spellings, not transliteration —
 * the same reason tamil-places.ts is built from the LGD list rather than
 * guessed at. A wrong station name on a complaint sends it to the wrong
 * desk, so anything without a verified Kannada name is simply left in
 * English by the renderer.
 *
 * Source: https://github.com/Vonter/city-officials static/blr/officials.json
 * Licence: data is CC BY 4.0 (the repo's code is GPL-3.0; we take no code).
 *
 * The suffix is normalised on the way in: bengawalk writes the station
 * furniture as "ಪಿಎಸ್", which is the Latin letters P-S spelled out
 * phonetically rather than the Kannada words. We store the bare place and
 * let the renderer append the real term, exactly as the Tamil path does.
 *
 *   node scripts/build-kannada-names.mjs path/to/officials.json
 */
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/build-kannada-names.mjs <officials.json>");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(src, "utf8"));

/** Strip a leading "94: " ward number — the number is rendered separately. */
const unnumber = (s) => s.replace(/^\s*\d+\s*:\s*/, "").trim();
/** Strip a trailing zone number, "KR Puram (2)" → "KR Puram". */
const unzone = (s) => s.replace(/\s*\(\d+\)\s*$/, "").trim();
/** Strip station furniture in either language. */
const unstation = (s) =>
  s
    .replace(/\s*(ಸಂಚಾರ\s*)?(ಪೊಲೀಸ್\s*ಠಾಣೆ|ಪಿಎಸ್)\s*$/u, "")
    .replace(/\s*(Aw\.?P\.?S\.?|P\.?S\.?|Police Station)\s*$/i, "")
    .trim();

/**
 * Which departments feed which dictionary, and how names are cleaned.
 *
 * The revenue villages are deliberately left out. They are 1,787 entries
 * (62 KB raw, 19 KB gzipped — two thirds of the file) and they cover
 * nothing the app actually draws: every ward, zone, corporation and
 * station our Bengaluru pack contains is already covered without them,
 * and a Kannada card asks the geocoder in Kannada, so a rural locality
 * arrives translated anyway. Pass --villages if that ever stops being
 * true.
 */
const PLACE_DEPTS = {
  police_city: unstation,
  police_traffic: unstation,
  gba_ward: unnumber,
  bbmp_wards: unnumber,
  gba_zone: unzone,
  bbmp_zone: unzone,
  ...(process.argv.includes("--villages")
    ? { admin_village: (s) => s.trim() }
    : {}),
};
const BODY_DEPTS = new Set(["gba_corporation"]);

const places = new Map();
const bodies = new Map();

for (const r of rows) {
  const en = (r.Area ?? "").trim();
  const kn = (r.AreaRegional ?? "").trim();
  if (!en || !kn) continue;
  // guard against rows where the "regional" name was left in English
  if (!/[ಀ-೿]/u.test(kn)) continue;

  if (BODY_DEPTS.has(r.Department)) {
    bodies.set(en, kn);
    continue;
  }
  const clean = PLACE_DEPTS[r.Department];
  if (!clean) continue;
  const k = clean(en);
  const v = clean(kn);
  if (!k || !v) continue;
  // first writer wins; police names are the most carefully maintained, so
  // they are read first by virtue of PLACE_DEPTS' order
  if (!places.has(k)) places.set(k, v);
}

/** Normalise for lookup: fold case, punctuation and spacing. */
const key = (s) =>
  s.toLowerCase().replace(/[.\-_]+/g, " ").replace(/\s+/g, " ").trim();

// collapse entries that differ only by punctuation/case
const byKey = new Map();
for (const [k, v] of places) if (!byKey.has(key(k))) byKey.set(key(k), [k, v]);

const sorted = [...byKey.values()].sort((a, b) => a[0].localeCompare(b[0]));
const bodyRows = [...bodies.entries()].sort((a, b) => a[0].localeCompare(b[0]));

const q = (s) => JSON.stringify(s);
const out = `/**
 * Kannada names for Bengaluru's localities, wards and police stations.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *   node scripts/build-kannada-names.mjs <officials.json>
 *
 * Source: bengawalk's city-officials dataset (CC BY 4.0), which carries the
 * government's own Kannada spellings for every ward, zone, corporation and
 * station. This is the Kannada counterpart of tamil-places.ts, and it
 * follows the same rule: a name we cannot verify is returned UNCHANGED
 * rather than transliterated, because a half-right name on a complaint
 * document is worse than an English one that is right.
 *
 * The station suffix is NOT stored here. bengawalk writes it as "ಪಿಎಸ್",
 * which is the letters P-S spelled phonetically rather than the Kannada
 * words; we keep the bare place and append the real term below.
 */

/** Station-name furniture, translated separately from the place. */
const SUFFIX_KN = "ಪೊಲೀಸ್ ಠಾಣೆ";

const PLACES: Record<string, string> = {
${sorted.map(([k, v]) => `  ${q(k)}: ${q(v)},`).join("\n")}
};

/** Municipal bodies, whose full names are translated as a unit. */
const BODIES: Record<string, string> = {
${bodyRows.map(([k, v]) => `  ${q(k)}: ${q(v)},`).join("\n")}
};

/** Normalise for lookup: fold case, punctuation and spacing. */
function key(s: string): string {
  return s.toLowerCase().replace(/[.\\-_]+/g, " ").replace(/\\s+/g, " ").trim();
}

const INDEX = new Map<string, string>(
  Object.entries(PLACES).map(([k, v]) => [key(k), v])
);
const BODY_INDEX = new Map<string, string>(
  Object.entries(BODIES).map(([k, v]) => [key(k), v])
);

/** Kannada for a bare locality or ward, or null when we have no name. */
export function kannadaPlace(name: string): string | null {
  if (!name) return null;
  const bare = name.replace(/^\\s*\\d+\\s*:\\s*/, "").replace(/\\s*\\(\\d+\\)\\s*$/, "");
  return INDEX.get(key(bare)) ?? null;
}

/** Kannada for a municipal body's full name, or null. */
export function kannadaBody(name: string): string | null {
  return name ? BODY_INDEX.get(key(name)) ?? null : null;
}

/**
 * Kannada for a full station name, keeping any beat code.
 *
 * "Adugodi PS" → "ಆಡುಗೋಡಿ ಪೊಲೀಸ್ ಠಾಣೆ". Returns the input untouched when
 * the locality is not in the dictionary.
 */
export function kannadaStation(raw: string): string {
  if (!raw) return raw;
  const m = /^([A-Z]{1,2}\\s?\\d+[A-Z]?)[.\\s]+(.*)$/.exec(raw.trim());
  const code = m ? m[1].replace(/\\s+/g, "") : "";
  let rest = (m ? m[2] : raw).trim();
  let hadSuffix = false;
  rest = rest
    .replace(/\\s*(Aw\\.?P\\.?S\\.?|P\\.?S\\.?|Police Station)\\s*$/i, () => {
      hadSuffix = true;
      return "";
    })
    .trim();
  const kn = kannadaPlace(rest);
  if (!kn) return raw;
  return [code, kn, hadSuffix ? SUFFIX_KN : ""].filter(Boolean).join(" ");
}
`;

const dest = path.join(import.meta.dirname, "../src/lib/geo/kannada-places.ts");
fs.writeFileSync(dest, out);
console.error(
  `${sorted.length} places + ${bodyRows.length} bodies -> ${path.relative(process.cwd(), dest)} (${(out.length / 1024).toFixed(1)} KB)`
);
