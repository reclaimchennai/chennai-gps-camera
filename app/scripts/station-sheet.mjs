/**
 * Police-station names awaiting translation, as a CSV.
 *
 * The station name is the last stubbornly English thing on an otherwise
 * localised card, and it cannot be machine-translated: these are proper
 * nouns, and a wrong station name on a complaint sends it to the wrong
 * desk. Tamil was solved with the government's own LGD list; the other
 * languages have no equivalent source I could find, so the remaining way
 * is native speakers filling this in.
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
      rows.push({ city: id, lang, raw, code, place, translated: "" });
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

const byCity = rows.reduce((m, r) => ((m[r.city] = (m[r.city] || 0) + 1), m), {});
process.stderr.write(
  Object.entries(byCity).map(([c, n]) => `${c}: ${n}`).join(", ") +
    `\ntotal ${rows.length} stations\n`
);
