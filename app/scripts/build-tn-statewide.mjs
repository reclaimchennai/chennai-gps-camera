#!/usr/bin/env node
/**
 * Statewide Tamil Nadu local-body upgrade for the tamilnadu pack.
 *
 * Replaces the pack's corporation-only ulb layer with TNGIS's ward-level
 * urban_local_bodies (ALL 642 ULBs: corporations, municipalities, town
 * panchayats — 3,271 wards) plus the two OSM-derived Cantonment Board
 * polygons, and adds a NEW `villages` layer with all 12,525 village
 * panchayats. Police layers (lo/traffic/stations) pass through untouched.
 *
 * Sources: scripts/.pack-sources/tn-boundaries/*-simplified.geojson —
 * mapshaper-simplified copies of the tn-boundaries package (TNGIS WFS +
 * OSM), fetched from the data server. See that package's README.
 *
 * Fast lookup (gazetteer-inspired): each indexed layer gets a fixed-cell
 * GRID INDEX (pack.grids.<layer>) mapping ~5.5 km lat/lng cells to
 * candidate feature indices, so a statewide point lookup tests a handful
 * of polygons instead of bbox-scanning all ~15k features per GPS tick.
 *
 * Run: node scripts/build-tn-statewide.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import turfBbox from "@turf/bbox";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, ".pack-sources/tn-boundaries");
const PACKS = join(__dirname, "../public/data/packs");

const CELL_DEG = 0.05; // ≈5.5 km — a village spans 1–4 cells

const titleCase = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim();

function corpName(ulbName, ulbType) {
  const name = titleCase(ulbName);
  if (/corporation/i.test(ulbType)) {
    // official style: "Greater Chennai Corporation", "Salem Corporation"
    return /corporation$/i.test(name) ? name : `${name} Corporation`;
  }
  if (/municipality/i.test(ulbType)) return `${name} Municipality`;
  return `${name} Town Panchayat`;
}

function gridIndex(features, packBbox) {
  const [minX, minY, maxX, maxY] = packBbox;
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
      for (let r = r0; r <= r1; r++) {
        (cells[`${c}_${r}`] ??= []).push(i);
      }
    }
  });
  return { cell: CELL_DEG, minX, minY, cols, rows, cells };
}

function withBbox(feature, properties) {
  const f = {
    type: "Feature",
    properties,
    geometry: feature.geometry,
  };
  f.bbox = turfBbox(f).map((v) => Math.round(v * 1e5) / 1e5);
  return f;
}

// ---- load sources ----------------------------------------------------
const ulbSrc = JSON.parse(
  readFileSync(join(SRC, "ulb-simplified.geojson"), "utf8")
);
const vilSrc = JSON.parse(
  readFileSync(join(SRC, "villages-simplified.geojson"), "utf8")
);
const cantSrc = JSON.parse(
  readFileSync(join(SRC, "cantonment_boards.geojson"), "utf8")
);
const pack = JSON.parse(
  readFileSync(join(PACKS, "tamilnadu.json"), "utf8")
);

// ---- new ulb layer: TNGIS wards + cantonments ------------------------
const ulbFeatures = ulbSrc.features.map((f) => {
  const p = f.properties;
  const zoneNum = String(p.zone_number ?? "0");
  const props = {
    corp: corpName(p.ulb_name, p.ulb_type),
    city: titleCase(p.ulb_name),
    ward: p.ward_number ? String(p.ward_number) : undefined,
    kind:
      /corporation/i.test(p.ulb_type)
        ? "corporation"
        : /municipality/i.test(p.ulb_type)
          ? "municipality"
          : "town-panchayat",
    district: titleCase(p.district_name),
  };
  if (zoneNum !== "0" && p.zone_name) {
    // fmtZone renders "5 Kondalampatty" as "Zone 5 (Kondalampatty)"
    props.zone = `${Number(zoneNum)} ${titleCase(p.zone_name)}`;
  }
  return withBbox(f, props);
});

for (const f of cantSrc.features) {
  const p = f.properties;
  ulbFeatures.push(
    withBbox(f, {
      corp: p.name,
      city: String(p.name).replace(/\s*Cantonment$/i, ""),
      district: p.board, // renders on the second line, board name
      kind: "cantonment",
    })
  );
}

// ---- villages layer --------------------------------------------------
const villageFeatures = vilSrc.features.map((f) => {
  const p = f.properties;
  return withBbox(f, {
    corp: `${titleCase(p.village_name)} Village Panchayat`,
    city: titleCase(p.village_name),
    block: titleCase(p.block_name),
    district: titleCase(p.district_name),
    kind: "village-panchayat",
  });
});

pack.layers.ulb = { type: "FeatureCollection", features: ulbFeatures };
pack.layers.villages = {
  type: "FeatureCollection",
  features: villageFeatures,
};
pack.grids = {
  ulb: gridIndex(ulbFeatures, pack.bbox),
  villages: gridIndex(villageFeatures, pack.bbox),
};
pack.attribution =
  "TNGIS / Tamil Nadu Government (local bodies, village panchayats); " +
  "cantonments © OpenStreetMap contributors (ODbL); police boundaries: Reclaim Chennai";

// ---- version + write -------------------------------------------------
const body = JSON.stringify(pack);
pack.version = createHash("sha256").update(body).digest("hex").slice(0, 12);
const out = JSON.stringify(pack);
writeFileSync(join(PACKS, "tamilnadu.json"), out);

// index.json: bump this pack's version + the index version
const index = JSON.parse(readFileSync(join(PACKS, "index.json"), "utf8"));
const entry = index.packs.find((p) => p.id === "tamilnadu");
entry.version = pack.version;
entry.attribution = pack.attribution;
index.version = createHash("sha256")
  .update(index.packs.map((p) => p.version).join("|"))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(PACKS, "index.json"), JSON.stringify(index, null, 1));

console.log(
  `tamilnadu.json: ulb=${ulbFeatures.length} villages=${villageFeatures.length} ` +
    `size=${(out.length / 1048576).toFixed(1)}MB version=${pack.version}`
);

// ---- chennai pack: cantonments must override GCC wards ---------------
// The chennai pack outranks tamilnadu inside its bbox, and its ward
// polygons (older source) wrongly COVER the cantonment areas — TNGIS's
// mosaic has genuine holes there, this dataset doesn't. Cantonment
// Boards are Ministry of Defence territory, not GCC, so both polygons
// are PREPENDED to the chennai ulb layer: lookup returns the first
// containing feature, so the cantonment claims the point before any
// overlapping GCC/Tambaram ward can.
const chennai = JSON.parse(
  readFileSync(join(PACKS, "chennai.json"), "utf8")
);
chennai.layers.ulb.features = chennai.layers.ulb.features.filter(
  (f) => f.properties?.kind !== "cantonment" // idempotent re-runs
);
const cantFeatures = cantSrc.features.map((f) => {
  const p = f.properties;
  return withBbox(f, {
    corp: p.name,
    city: String(p.name).replace(/\s*Cantonment$/i, ""),
    district: p.board,
    kind: "cantonment",
  });
});
chennai.layers.ulb.features = [
  ...cantFeatures,
  ...chennai.layers.ulb.features,
];
if (!/OpenStreetMap/.test(chennai.attribution ?? "")) {
  chennai.attribution =
    `${chennai.attribution ?? ""}; cantonments © OpenStreetMap contributors (ODbL)`
      .replace(/^; /, "");
}
const cBody = JSON.stringify(chennai);
chennai.version = createHash("sha256").update(cBody).digest("hex").slice(0, 12);
writeFileSync(join(PACKS, "chennai.json"), JSON.stringify(chennai));
const cEntry = index.packs.find((p) => p.id === "chennai");
cEntry.version = chennai.version;
cEntry.attribution = chennai.attribution;
index.version = createHash("sha256")
  .update(index.packs.map((p) => p.version).join("|"))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(PACKS, "index.json"), JSON.stringify(index, null, 1));
console.log(
  `chennai.json: ulb=${chennai.layers.ulb.features.length} (+${cantFeatures.length} cantonments, prepended) version=${chennai.version}`
);
