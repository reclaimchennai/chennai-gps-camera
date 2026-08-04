/**
 * Police-station names awaiting translation, as a CSV.
 *
 * The station name is the last stubbornly English thing on an otherwise
 * localised card, and it cannot be machine-translated: these are proper
 * nouns, and a wrong station name on a complaint sends it to the wrong
 * desk. Tamil was solved with the government's own LGD list and Kannada
 * with bengawalk's officials dataset (see build-kannada-names.mjs); the
 * remaining languages have no equivalent source I have found, so for those
 * the way through is native speakers filling this in.
 *
 * Emits one row per distinct station, with the beat code split out —
 * "G2" in "G2 Periyamet PS" is the force's own identifier and must stay
 * Latin, so only the place part needs translating.
 *
 *   node scripts/station-sheet.mjs > stations.csv
 */
import fs from "node:fs";
import path from "node:path";

const PACKS = path.join(import.meta.dirname, "../public/data/packs");
/** Which language each city's stations should be rendered in. */
const CITY_LANG = {
  chennai: "ta", tamilnadu: "ta", bengaluru: "kn", hyderabad: "te",
  visakhapatnam: "te", mumbai: "mr", pune: "mr", kolkata: "bn",
  delhi: "hi", chandigarh: "hi", gurugram: "hi",
};

/**
 * Names we already hold, pre-filled into the sheet so a native speaker
 * VALIDATES them instead of retyping them. The dictionaries are plain
 * `Record<string, string>` literals, so they can be read without a
 * TypeScript toolchain.
 */
const GEO = path.join(import.meta.dirname, "../src/lib/geo");
function dictionary(file, name) {
  const src = path.join(GEO, file);
  if (!fs.existsSync(src)) return new Map();
  const body = new RegExp(
    `const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`
  ).exec(fs.readFileSync(src, "utf8"));
  if (!body) return new Map();
  const obj = JSON.parse("{" + body[1].replace(/,\s*$/, "") + "}");
  return new Map(Object.entries(obj).map(([k, v]) => [fold(k), v]));
}
const fold = (s) =>
  s.toLowerCase().replace(/[.\-_]+/g, " ").replace(/\s+/g, " ").trim();

const KNOWN = {
  ta: dictionary("tamil-places.ts", "PLACES"),
  kn: dictionary("kannada-places.ts", "PLACES"),
};

const rows = [];
for (const file of fs.readdirSync(PACKS)) {
  if (!file.endsWith(".json") || file === "index.json") continue;
  const id = file.replace(/\.json$/, "");
  const lang = CITY_LANG[id];
  if (!lang) continue;
  const pack = JSON.parse(fs.readFileSync(path.join(PACKS, file), "utf8"));
  const seen = new Set();
  for (const layer of ["lo", "traffic"]) {
    for (const f of pack.layers?.[layer]?.features ?? []) {
      const raw = (f.properties?.station || "").trim();
      if (!raw || seen.has(raw)) continue;
      seen.add(raw);
      // split "G2 Periyamet PS" -> code "G2", place "Periyamet"
      const m = /^([A-Z]{1,2}\s?\d+[A-Z]?)[.\s]+(.*)$/.exec(raw);
      const code = m ? m[1].replace(/\s+/g, "") : "";
      const place = (m ? m[2] : raw)
        .replace(/\s*(Aw\.?P\.?S\.?|P\.?S\.?|Police Station)\s*$/i, "")
        .trim();
      const known = KNOWN[lang]?.get(fold(place)) ?? "";
      rows.push({ city: id, lang, raw, code, place, translated: known });
    }
  }
}

const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const out = [
  ["city", "language", "full_name_as_stored", "beat_code_keep_as_is",
   "place_name_to_translate", "translation"].map(esc).join(","),
];
rows.sort((a, b) => a.city.localeCompare(b.city) || a.place.localeCompare(b.place));
for (const r of rows) {
  out.push([r.city, r.lang, r.raw, r.code, r.place, r.translated].map(esc).join(","));
}
process.stdout.write(out.join("\n") + "\n");

const byCity = rows.reduce((m, r) => {
  const s = (m[r.city] ??= { n: 0, done: 0 });
  s.n++;
  if (r.translated) s.done++;
  return m;
}, {});
const done = rows.filter((r) => r.translated).length;
process.stderr.write(
  Object.entries(byCity)
    .map(([c, s]) => `${c}: ${s.done}/${s.n}`)
    .join(", ") +
    `\ntotal ${done}/${rows.length} stations pre-filled, ` +
    `${rows.length - done} awaiting translation\n`
);
