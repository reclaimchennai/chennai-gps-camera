#!/usr/bin/env node
/**
 * Build-time geodata filter for the Chennai GPS camera app.
 *
 * Reads the statewide Tamil Nadu GeoJSON layers from the police-locator
 * project and emits a small, normalized bundle covering only the three
 * in-scope corporations (Greater Chennai, Tambaram, Avadi) plus a buffer,
 * so a GPS fix just outside a boundary edge still finds its polygon.
 *
 * Normalization happens HERE, not in app code: the raw shapefile-derived
 * property names (police_sta, police_s_1, Sub-Division, ...) never reach
 * the app. Per-feature bboxes are precomputed into the GeoJSON `bbox`
 * member so the runtime prefilter is free.
 *
 * Output: app/public/data/{lo,traffic,ulb,stations}.geojson + version.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import { polygon as turfPolygon } from "@turf/helpers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(
  process.env.HOME,
  "projects/police/police-locator-20260525-1033/public/data"
);
const OUT = join(__dirname, "..", "public", "data");

// Buffer around the seed region, in degrees (~2.2 km at this latitude).
const BUFFER_DEG = 0.02;
// Coordinate precision: 5 decimals ≈ 1.1 m — plenty for boundary polygons.
const COORD_DECIMALS = 5;

const load = (name) =>
  JSON.parse(readFileSync(join(SRC, name), "utf8"));

console.log("Loading source layers…");
const lo = load("lo.geojson");
const traffic = load("traffic.geojson");
const ulb = load("ulb.geojson");
const stations = load("stations.geojson");

// ---- Region seeds ------------------------------------------------
// GCC + Tambaram ward polygons, and the 11 L&O polygons whose locality
// is "Avadi" (Avadi has no ward polygons in the source data — the L&O
// layer is the only geometry that covers it).
const ulbSeeds = ulb.features.filter(
  (f) =>
    f.properties.ulbType === "Corporation" &&
    (f.properties.ulb === "Chennai" || f.properties.ulb === "Tambaram")
);
const avadiSeeds = lo.features.filter((f) => f.properties.district === "Avadi");
if (ulbSeeds.length === 0 || avadiSeeds.length === 0) {
  throw new Error("Region seeds missing — source data layout changed?");
}
console.log(
  `Seeds: ${ulbSeeds.length} ward polygons (GCC+Tambaram), ${avadiSeeds.length} Avadi L&O polygons`
);

let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
for (const f of [...ulbSeeds, ...avadiSeeds]) {
  const [a, b, c, d] = bbox(f);
  if (a < minX) minX = a;
  if (b < minY) minY = b;
  if (c > maxX) maxX = c;
  if (d > maxY) maxY = d;
}
minX -= BUFFER_DEG; minY -= BUFFER_DEG; maxX += BUFFER_DEG; maxY += BUFFER_DEG;
const regionRect = turfPolygon([[
  [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
]]);
console.log(
  `Region rect: [${minX.toFixed(4)}, ${minY.toFixed(4)}] – [${maxX.toFixed(4)}, ${maxY.toFixed(4)}]`
);

// ---- Helpers -----------------------------------------------------
const round = (n) => Number(n.toFixed(COORD_DECIMALS));
const roundCoords = (coords) =>
  typeof coords[0] === "number"
    ? [round(coords[0]), round(coords[1])]
    : coords.map(roundCoords);

const bboxOverlaps = (b) =>
  b[0] <= maxX && b[2] >= minX && b[1] <= maxY && b[3] >= minY;

const clean = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
};
// Shapefile text is often ALL CAPS; normalize to title case for display.
const titleish = (s) =>
  s && s.toUpperCase() === s
    ? s.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase())
    : s;

function filterLayer(fc, { normalize, pointLayer = false }) {
  const out = [];
  for (const f of fc.features) {
    const b = bbox(f);
    if (!bboxOverlaps(b)) continue;
    if (!pointLayer) {
      try {
        if (!booleanIntersects(f, regionRect)) continue;
      } catch {
        continue; // invalid geometry — drop
      }
    }
    const props = normalize(f.properties);
    if (!props) continue;
    out.push({
      type: "Feature",
      bbox: b.map(round),
      properties: props,
      geometry: {
        type: f.geometry.type,
        coordinates: roundCoords(f.geometry.coordinates),
      },
    });
  }
  return { type: "FeatureCollection", features: out };
}

// ---- Layer-specific normalization --------------------------------
const loOut = filterLayer(lo, {
  normalize: (p) => ({
    station: titleish(clean(p.station)),
    locality: clean(p.district), // source `district` is actually a locality
    district: clean(p.districtName),
    ac: clean(p.ac),
    dc: clean(p.dc),
    zone: clean(p.zone),
    phone: clean(p.phone),
    // Avadi Police Commissionerate area = only geometry covering Avadi
    // Corporation. Used at runtime for the "in Avadi, ward data not yet
    // available" honesty rule.
    avadi: p.district === "Avadi" || undefined,
  }),
});

const trafficOut = filterLayer(traffic, {
  normalize: (p) => {
    // Outside GCTP limits `police_sta` carries the L&O name (wrong for
    // traffic) while `tiw` has the correct Traffic Investigation Wing
    // label; inside GCTP `tiw` is null and `police_sta` is correct.
    // Preferring tiw handles both. " TIW" suffix is redundant on a
    // field always labelled "Traffic".
    const raw =
      clean(p.tiw) ?? clean(p.station) ?? clean(p.police_sta) ?? clean(p.police_s_2);
    return {
      station: titleish(raw ? raw.replace(/\s+TIW\s*$/i, "") : undefined),
      subDivision: titleish(clean(p["Sub-Division"]) ?? clean(p.taluk) ?? clean(p.taluk_name)),
      district: titleish(clean(p.District) ?? clean(p.district) ?? clean(p.district_n)),
    };
  },
});

const ulbOut = filterLayer(ulb, {
  normalize: (p) => ({
    ulb: clean(p.ulb),
    ulbType: clean(p.ulbType),
    zone: clean(p.zone),
    ward: clean(p.ward),
    district: clean(p.district),
  }),
});

const stationsOut = filterLayer(stations, {
  pointLayer: true,
  normalize: (p) =>
    p.active === false
      ? null
      : { code: clean(p.code), name: clean(p.name), label: clean(p.label) },
});

// ---- Write -------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const files = {
  "lo.geojson": loOut,
  "traffic.geojson": trafficOut,
  "ulb.geojson": ulbOut,
  "stations.geojson": stationsOut,
};

const manifest = { version: "", files: {} };
const hashes = [];
for (const [name, fc] of Object.entries(files)) {
  const json = JSON.stringify(fc);
  const sha = createHash("sha256").update(json).digest("hex");
  writeFileSync(join(OUT, name), json);
  manifest.files[name] = {
    features: fc.features.length,
    bytes: Buffer.byteLength(json),
    sha256: sha.slice(0, 16),
  };
  hashes.push(sha);
  console.log(
    `${name}: ${fc.features.length} features, ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`
  );
}
manifest.version = createHash("sha256")
  .update(hashes.join(""))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(OUT, "version.json"), JSON.stringify(manifest, null, 2));
console.log(`Bundle version: ${manifest.version}`);
