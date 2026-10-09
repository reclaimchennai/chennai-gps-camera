#!/usr/bin/env node
/**
 * Neighbourhood names, into the packs.
 *
 * A user asked why their card said "Perungudi" and "Sholinganallur" when
 * both are ten kilometres from where they stood. Neither was a mistake by
 * the geocoder's lights: at 12.9293, 80.2025 Google and OSM both answer
 *
 *     Major Mukund Varadharajan Salai, Perungudi, Chennai,
 *     Sholinganallur, Chennai, Tamil Nadu 600100
 *
 * — where "Perungudi" is Greater Chennai Corporation ZONE 14 and
 * "Sholinganallur" is the revenue TALUK. Both are administrative units
 * kilometres across. The address jumps from the road straight to them and
 * never names the neighbourhood, which is Pallikaranai, 589 m away.
 *
 * Our ward and zone polygons already tell us when a geocoder has handed
 * back a zone name instead of a place. This layer supplies the place: the
 * named settlements OSM holds — suburbs, neighbourhoods, villages,
 * hamlets — so the card can say where someone actually is, offline, in
 * the card's own script where OSM has it.
 *
 * Source is a Geofabrik regional extract, read locally, not Overpass: a
 * public API rate-limits, times out and changes under you, while an
 * extract is one dated file that rebuilds the same every time.
 *
 *   # once per refresh, per zone extract:
 *   ogr2ogr -f GeoJSON places-south.geojson southern-zone-latest.osm.pbf \
 *     points -where "place IN ('suburb','neighbourhood','quarter','village',\
 *     'hamlet','town','locality','city')"
 *
 *   node scripts/build-places.mjs ~/data/osm/places-*.geojson
 *
 * STORAGE IS COLUMNAR. Tamil Nadu's bbox alone holds ~50,000 places; as
 * GeoJSON features that is ~5 MB on a 17 MB pack. One string array, one
 * type string and one integer coordinate array carry the same thing in a
 * fraction of it.
 *
 * Data © OpenStreetMap contributors, ODbL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PACKS = "public/data/packs";
/** One letter per type; the app decodes these (src/lib/geo/places.ts). */
const TYPE_CODE = {
  city: "c",
  town: "t",
  suburb: "s",
  quarter: "q",
  neighbourhood: "n",
  locality: "l",
  village: "v",
  hamlet: "h",
};
/** Card languages with a script of their own (see i18n/languages.ts). */
const LANG_TAGS = ["ta", "hi", "kn", "te", "ml", "bn", "mr"];
/** Fixed-point scale for coordinates: 1e5 is ~1.1 m, finer than any
 *  place node is placed to begin with. */
const SCALE = 1e5;

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("usage: node scripts/build-places.mjs <places.geojson> [...]");
  process.exit(2);
}

const tagsOf = (p) =>
  Object.fromEntries(
    [...String(p.other_tags ?? "").matchAll(/"([^"]+)"=>"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => [m[1], m[2]]
    )
  );

const all = [];
for (const file of inputs) {
  const fc = JSON.parse(readFileSync(file, "utf8"));
  for (const f of fc.features) {
    const p = f.properties ?? {};
    const code = TYPE_CODE[p.place];
    const name = typeof p.name === "string" ? p.name.replace(/\s+/g, " ").trim() : "";
    if (!code || !name) continue;
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const t = tagsOf(p);
    const local = {};
    for (const l of LANG_TAGS) {
      const v = t[`name:${l}`]?.trim();
      if (v && v !== name) local[l] = v;
    }
    all.push({ name, code, lat, lng, local });
  }
}
console.log(`${all.length} named places read from ${inputs.length} file(s)`);

const index = JSON.parse(readFileSync(join(PACKS, "index.json"), "utf8"));
for (const entry of index.packs) {
  const [w, s, e, n] = entry.bbox;
  // a little beyond the bbox, so a point at its edge still finds the
  // place just across it
  const pad = 0.03;
  const inside = all.filter(
    (p) => p.lng >= w - pad && p.lng <= e + pad && p.lat >= s - pad && p.lat <= n + pad
  );
  // the same place mapped twice (a node per name variant, an import
  // overlapping a manual edit) would only ever cost a lookup a comparison
  const seen = new Set();
  const kept = [];
  for (const p of inside) {
    const k = `${p.name.toLowerCase()}|${Math.round(p.lat * 500)}|${Math.round(p.lng * 500)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(p);
  }
  // stable order: a rebuild from the same extract must hash the same
  kept.sort((a, b) => a.lat - b.lat || a.lng - b.lng || a.name.localeCompare(b.name));

  const local = {};
  kept.forEach((p, i) => {
    for (const [l, v] of Object.entries(p.local)) (local[l] ??= {})[i] = v;
  });
  const table = {
    type: "PlaceTable",
    names: kept.map((p) => p.name),
    types: kept.map((p) => p.code).join(""),
    // interleaved lng,lat as integers
    coords: kept.flatMap((p) => [Math.round(p.lng * SCALE), Math.round(p.lat * SCALE)]),
    scale: SCALE,
    local,
  };

  const file = join(PACKS, entry.file);
  const pack = JSON.parse(readFileSync(file, "utf8"));
  if (!kept.length) {
    if (pack.layers.places) {
      delete pack.layers.places;
    } else {
      console.log(`pack ${entry.id}: no places in this extract set — left as is`);
      continue;
    }
  } else {
    pack.layers.places = table;
  }
  if (!/places/.test(pack.attribution)) {
    pack.attribution += "; place names © OpenStreetMap contributors (ODbL)";
  }

  // re-version in place — never rebuild the object from a literal (that
  // is how tamilnadu.grids was once silently dropped)
  pack.version = "";
  const sha = createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 12);
  pack.version = sha;
  const json = JSON.stringify(pack);
  writeFileSync(file, json);
  const ie = index.packs.find((p) => p.id === entry.id);
  ie.version = sha;
  ie.bytes = Buffer.byteLength(json);
  ie.attribution = pack.attribution;
  const counts = [...table.types].reduce((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {});
  console.log(
    `pack ${entry.id}: ${kept.length} places ${JSON.stringify(counts)}, ` +
      `${(Buffer.byteLength(JSON.stringify(table)) / 1024).toFixed(0)} KB of ` +
      `${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`
  );
}

index.version = createHash("sha256")
  .update(index.packs.map((p) => p.version).join(""))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(PACKS, "index.json"), JSON.stringify(index, null, 1));
console.log(`index version ${index.version}`);
