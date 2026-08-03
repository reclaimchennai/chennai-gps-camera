/**
 * Translation sheet: export to CSV, import back.
 *
 * The point is a round trip. A one-way dump gets validated once, the
 * corrections land in a comment thread, and the code drifts. Exporting to
 * CSV, correcting in a shared sheet, and importing back makes the sheet
 * the source of truth for wording while the code stays the source of
 * truth for structure.
 *
 *   node scripts/i18n-sheet.mjs export  > strings.csv
 *   node scripts/i18n-sheet.mjs import  < strings.csv
 *
 * Columns: key, context, en, ta, hi, kn, te, mr, bn
 * `context` tells a validator where the string appears — a translator
 * seeing "Max" alone cannot know it means the loudest reading, not a
 * maximum permitted value.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "../src/lib/i18n/languages.ts");
const LANGS = ["en", "ta", "hi", "kn", "te", "mr", "bn"];

const CONTEXT = {
  digipin: "Label before India Post's DIGIPIN code on the card",
  ward: "Label before the ward number",
  zone: "Label before the zone number",
  block: "Label for a development block (village panchayats)",
  district: "Label for a district",
  policeBoth: "Police line when L&O and Traffic are the SAME station",
  policeLo: "Police station responsible for law and order",
  traffic: "Traffic police station",
  noise: "Ambient sound level measured by the phone's mic",
  avg: "Average of the noise readings — abbreviated, space is tight",
  min: "Quietest noise reading — abbreviated",
  max: "Loudest noise reading — abbreviated",
  facing: "Compass direction the camera was pointing",
  acquiring: "Shown while the GPS has no fix yet",
  wardPending: "Shown where we have the corporation but not its ward map",
  mock: "Warning that the GPS position may be faked. Keep the ⚠",
  pincode: "Label before the 6-digit postal code",
  "coords.lat": "Label before the latitude number",
  "coords.lng": "Label before the longitude number",
  "alt.label": "Label before altitude in metres",
  "alt.metre": "Abbreviation for metres",
  "meridiem.0": "Before noon (AM)",
  "meridiem.1": "After noon (PM)",
  zoneWord: "The word 'Zone' as used on the local body's own signage",
};

function read() {
  const src = fs.readFileSync(SRC, "utf8");
  const out = {};
  for (const lang of LANGS) {
    const block = src.match(
      new RegExp(`\\n  ${lang}: \\{([\\s\\S]*?)\\n  \\},`, "m")
    );
    if (!block) continue;
    const b = block[1];
    const grab = (re) => (b.match(re) || [, ""])[1];
    const strings = {};
    for (const [, k, v] of b.matchAll(/(\w+): "((?:[^"\\]|\\.)*)"/g)) {
      strings[k] = v;
    }
    out[lang] = {
      ...strings,
      "coords.lat": grab(/coords: \{ lat: "((?:[^"\\]|\\.)*)"/),
      "coords.lng": grab(/lng: "((?:[^"\\]|\\.)*)" \}/),
      "alt.label": grab(/alt: \{ label: "((?:[^"\\]|\\.)*)"/),
      "alt.metre": grab(/metre: "((?:[^"\\]|\\.)*)" \}/),
      "meridiem.0": grab(/meridiem: \["((?:[^"\\]|\\.)*)"/),
      "meridiem.1": grab(/meridiem: \[".*?", "((?:[^"\\]|\\.)*)"\]/),
    };
  }
  return out;
}

const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

if (process.argv[2] === "export") {
  const data = read();
  const keys = Object.keys(CONTEXT).filter((k) => data.en?.[k] !== undefined);
  const rows = [["key", "context", ...LANGS].map(esc).join(",")];
  for (const k of keys) {
    rows.push(
      [k, CONTEXT[k] ?? "", ...LANGS.map((l) => data[l]?.[k] ?? "")]
        .map(esc)
        .join(",")
    );
  }
  process.stdout.write(rows.join("\n") + "\n");
  process.stderr.write(`${keys.length} keys x ${LANGS.length} languages\n`);
} else if (process.argv[2] === "import") {
  const csv = fs.readFileSync(0, "utf8");
  // minimal CSV reader: quoted fields, doubled quotes, embedded newlines
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (q) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  const li = LANGS.map((l) => head.indexOf(l));
  let src = fs.readFileSync(SRC, "utf8");
  let changed = 0;
  for (const r of rows) {
    if (!r[0]) continue;
    const key = r[0];
    LANGS.forEach((lang, n) => {
      const val = r[li[n]];
      if (val === undefined || val === "") return;
      const blockRe = new RegExp(`(\\n  ${lang}: \\{[\\s\\S]*?\\n  \\},)`, "m");
      const m = src.match(blockRe);
      if (!m) return;
      let block = m[1];
      const before = block;
      if (key.includes(".")) return; // nested keys are edited by hand
      block = block.replace(
        new RegExp(`(\\b${key}: )"(?:[^"\\\\]|\\\\.)*"`),
        (_, p) => `${p}${JSON.stringify(val)}`
      );
      if (block !== before) { src = src.replace(m[1], block); changed++; }
    });
  }
  fs.writeFileSync(SRC, src);
  process.stderr.write(`updated ${changed} strings in languages.ts\n`);
} else {
  process.stderr.write("usage: i18n-sheet.mjs export|import\n");
  process.exit(1);
}
