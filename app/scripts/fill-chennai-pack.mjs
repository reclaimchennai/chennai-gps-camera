#!/usr/bin/env node
/**
 * Fill the Chennai pack's gaps from the statewide Tamil Nadu pack.
 *
 * The Chennai pack wins every point inside its rectangle (the smallest
 * pack containing a point is used), and that rectangle reaches well past
 * the bodies it was built for: it carried GCC, Tambaram and a few
 * municipalities, but not Avadi's wards, Ponneri, Thiruverkadu, most of
 * Maraimalainagar, or any village panchayat. Inside it, a point in one of
 * those printed no local body at all — or, across the Avadi police
 * commissionerate, "Avadi Corporation" for villages such as
 * Chembarambakkam and Puliyur, because that police polygon stood in for
 * Avadi's missing wards.
 *
 * The statewide pack (TNGIS) has all of them. This copies, into the
 * Chennai pack:
 *   - every statewide local body that the Chennai pack does not already
 *     draw ward by ward (Avadi, Ponneri, Maraimalainagar, the town
 *     panchayats…), after the Chennai pack's own wards, so its curated
 *     GCC and Tambaram wards and their zone names still answer first;
 *   - every statewide village panchayat that reaches into the rectangle,
 *     as the `villages` layer, which lookup() consults when no ward
 *     matches;
 *   - grid indexes for both layers, as the statewide pack has.
 *
 * Avadi Corporation's 48 wards come from scripts/sources/
 * avadi_wards_current.geojson — TNGIS's wards as corrected for the
 * current boundary — in both packs, in place of TNGIS's originals. The
 * expansion proposed under G.O. 201 / Gazette 429 is an intention notice,
 * not yet in force, so its added areas stay with their present bodies.
 *
 * Re-runnable: features it added carry `filled: true` and are replaced.
 *
 *   node scripts/fill-chennai-pack.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKS = join(__dirname, "../public/data/packs");
const CELL_DEG = 0.05;

const read = (n) => JSON.parse(readFileSync(join(PACKS, n), "utf8"));
const chennai = read("chennai.json");
const tn = read("tamilnadu.json");

const round = (v) => Math.round(v * 1e5) / 1e5;
const flat = (c) => (typeof c[0] === "number" ? [round(c[0]), round(c[1])] : c.map(flat));
function bboxOf(geom) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])];
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return b.map(round);
}
const avadiSrc = JSON.parse(
  readFileSync(join(__dirname, "sources/avadi_wards_current.geojson"), "utf8")
);
const avadi = avadiSrc.features.map((f) => {
  const geometry = { type: f.geometry.type, coordinates: flat(f.geometry.coordinates) };
  return {
    type: "Feature",
    properties: {
      corp: "Avadi Corporation",
      city: "Avadi",
      ward: String(f.properties.ward_number),
      kind: "corporation",
      district: f.properties.district_name || "Tiruvallur",
    },
    geometry,
    bbox: bboxOf(geometry),
  };
});
const [x0, y0, x1, y1] = chennai.bbox;
const reaches = (b) =>
  Array.isArray(b) && b.every((v) => typeof v === "number") &&
  !(b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1);

// ---- statewide pack: Avadi's current wards -------------------------------
// First, so that where the corrected boundary overlaps a neighbour's
// older polygon (GCC ward 85, Thirunindravur), Avadi's ward answers.
tn.layers.ulb.features = [
  ...avadi,
  ...tn.layers.ulb.features.filter((f) => f.properties.corp !== "Avadi Corporation"),
];

// the Chennai pack's own features, without anything a previous run added
const own = chennai.layers.ulb.features.filter((f) => !f.properties?.filled);
const ownCount = {};
for (const f of own) ownCount[f.properties.corp] = (ownCount[f.properties.corp] ?? 0) + 1;

// statewide names for the bodies the Chennai pack already draws
const SAME_BODY = { "Chennai Corporation": "Greater Chennai Corporation" };
const swCount = {};
for (const f of tn.layers.ulb.features) {
  if (!reaches(f.bbox)) continue;
  const corp = SAME_BODY[f.properties.corp] ?? f.properties.corp;
  swCount[corp] = (swCount[corp] ?? 0) + 1;
}
// A body stays the Chennai pack's when it draws it at least as finely as
// the statewide data does (ward by ward); otherwise the statewide wards
// replace it.
const keepOwn = new Set(
  Object.keys(ownCount).filter((c) => ownCount[c] >= (swCount[c] ?? 0))
);
const ownKept = own.filter((f) => keepOwn.has(f.properties.corp));
const dropped = Object.keys(ownCount).filter((c) => !keepOwn.has(c));

const added = tn.layers.ulb.features
  .filter((f) => reaches(f.bbox))
  .filter((f) => !keepOwn.has(SAME_BODY[f.properties.corp] ?? f.properties.corp))
  .map((f) => ({ ...f, properties: { ...f.properties, filled: true } }));
const villages = tn.layers.villages.features
  .filter((f) => reaches(f.bbox))
  .map((f) => ({ ...f, properties: { ...f.properties, filled: true } }));

function gridIndex(features, [minX, minY, maxX, maxY]) {
  const cols = Math.max(1, Math.ceil((maxX - minX) / CELL_DEG));
  const rows = Math.max(1, Math.ceil((maxY - minY) / CELL_DEG));
  const cells = {};
  features.forEach((f, i) => {
    const [bx0, by0, bx1, by1] = f.bbox;
    const c0 = Math.max(0, Math.floor((bx0 - minX) / CELL_DEG));
    const c1 = Math.min(cols - 1, Math.floor((bx1 - minX) / CELL_DEG));
    const r0 = Math.max(0, Math.floor((by0 - minY) / CELL_DEG));
    const r1 = Math.min(rows - 1, Math.floor((by1 - minY) / CELL_DEG));
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) (cells[`${c}_${r}`] ??= []).push(i);
    }
  });
  return { cell: CELL_DEG, minX, minY, cols, rows, cells };
}

tn.grids.ulb = gridIndex(tn.layers.ulb.features, tn.bbox);
delete tn.version;
tn.version = createHash("sha256").update(JSON.stringify(tn)).digest("hex").slice(0, 12);
const tnOut = JSON.stringify(tn);
writeFileSync(join(PACKS, "tamilnadu.json"), tnOut);

// cantonments first (MoD land inside GCC's older polygons), then Avadi's
// corrected wards, then the pack's own wards, then the rest
const isCant = (f) => f.properties.kind === "cantonment";
const isAvadi = (f) => f.properties.corp === "Avadi Corporation";
const ulb = [
  ...ownKept.filter(isCant),
  ...added.filter(isAvadi),
  ...ownKept.filter((f) => !isCant(f)),
  ...added.filter((f) => !isAvadi(f)),
];
chennai.layers.ulb = { type: "FeatureCollection", features: ulb };
chennai.layers.villages = { type: "FeatureCollection", features: villages };
chennai.grids = {
  ulb: gridIndex(ulb, chennai.bbox),
  villages: gridIndex(villages, chennai.bbox),
};
if (!/TNGIS/.test(chennai.attribution ?? "")) {
  chennai.attribution = `${chennai.attribution}; TNGIS / Tamil Nadu Government (local bodies, village panchayats)`;
}

delete chennai.version;
chennai.version = createHash("sha256").update(JSON.stringify(chennai)).digest("hex").slice(0, 12);
const out = JSON.stringify(chennai);
writeFileSync(join(PACKS, "chennai.json"), out);

const index = read("index.json");
const tnEntry = index.packs.find((p) => p.id === "tamilnadu");
tnEntry.version = tn.version;
tnEntry.bytes = Buffer.byteLength(tnOut);
const entry = index.packs.find((p) => p.id === "chennai");
entry.version = chennai.version;
entry.bytes = Buffer.byteLength(out);
entry.attribution = chennai.attribution;
index.version = createHash("sha256")
  .update(index.packs.map((p) => p.version).join("|"))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(PACKS, "index.json"), JSON.stringify(index, null, 1));

console.log(
  `chennai.json: own wards kept ${ownKept.length} (${[...keepOwn].join(", ")}); ` +
    `replaced by statewide: ${dropped.join(", ") || "none"}; ` +
    `statewide bodies added ${added.length}, villages ${villages.length}; ` +
    `${(out.length / 1024).toFixed(0)} KB, version ${chennai.version}`
);
