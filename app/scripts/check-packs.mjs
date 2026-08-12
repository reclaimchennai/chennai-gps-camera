#!/usr/bin/env node
/**
 * Guard against junk reaching a watermark.
 *
 * The packs are built from government shapefiles, and their text fields
 * arrive with artefacts: underscores standing in for spaces
 * ("MARAIMALAI_NAGAR"), doubled spaces ("Ashokanagara  PS"), a stray
 * space before a period ("Thiru .Vi.Ka."), and multipart ward ids
 * ("011_1", the same ward drawn as two polygons). All of it is printed
 * onto photos used for civic complaints, so it has to be caught before a
 * release rather than by a user reading their own card.
 *
 * Also checks the things a hand-edit of the packs can quietly break:
 * every pack's own version must match its index entry, and the byte count
 * in the index must be true.
 *
 *   node scripts/check-packs.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PACKS = "public/data/packs";

/** Fields whose values are shown to a user. */
const NAME_FIELDS = new Set([
  "station", "name", "label", "corp", "city", "block", "district",
  "wardName", "zone", "locality", "ac", "dc", "subDivision",
]);

const RULES = [
  [/_/, "underscore"],
  [/ {2,}/, "doubled space"],
  [/^\s|\s$/, "untrimmed"],
  [/\s+[,.]/, "space before punctuation"],
  [/[\t\n\r]/, "control character"],
  [/&[a-z]+;|&#\d+;/, "html entity"],
  [/Ã|â€|Â|�/, "mojibake"],
];

let problems = 0;
const report = (where, value, why) => {
  problems++;
  if (problems <= 40) console.log(`  ${why}: ${where} = ${JSON.stringify(value)}`);
};

function walk(node, parentKey, pack) {
  if (Array.isArray(node)) {
    if (node.length && typeof node[0] === "number") return; // coordinates
    for (const v of node) walk(v, parentKey, pack);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && parentKey === "properties") {
        if (k === "ward") {
          if (/_\d+$/.test(v)) {
            report(`${pack}.${k}`, v, "multipart ward id");
          }
        } else if (NAME_FIELDS.has(k)) {
          for (const [rx, why] of RULES) {
            if (rx.test(v)) { report(`${pack}.${k}`, v, why); break; }
          }
        }
      } else {
        walk(v, k, pack);
      }
    }
  }
}

const index = JSON.parse(readFileSync(join(PACKS, "index.json"), "utf8"));
const files = readdirSync(PACKS).filter((f) => f.endsWith(".json") && f !== "index.json");

console.log(`checking ${files.length} packs…`);
for (const file of files) {
  walk(JSON.parse(readFileSync(join(PACKS, file), "utf8")), "", file);
}

// index integrity — a hand-edited pack whose version was not bumped would
// never reach an installed app, which is worse than an obvious failure
for (const entry of index.packs) {
  const raw = readFileSync(join(PACKS, entry.file));
  const pack = JSON.parse(raw.toString("utf8"));
  if (pack.version !== entry.version) {
    problems++;
    console.log(
      `  version mismatch: ${entry.id} pack=${pack.version} index=${entry.version}`
    );
  }
  if (entry.bytes !== raw.length) {
    problems++;
    console.log(
      `  byte count wrong: ${entry.id} index=${entry.bytes} actual=${raw.length}`
    );
  }
}

// the statewide pack's grid index is what keeps a 12,525-polygon lookup
// off a full scan; losing it is invisible except as slowness
const tn = JSON.parse(readFileSync(join(PACKS, "tamilnadu.json"), "utf8"));
if (!tn.grids?.ulb || !tn.grids?.villages) {
  problems++;
  console.log("  tamilnadu.json is missing its grids spatial index");
}

if (problems) {
  console.log(`\n${problems} problem(s) found`);
  process.exit(1);
}
console.log("packs clean");
