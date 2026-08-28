#!/usr/bin/env node
/**
 * Railway stations, into the packs.
 *
 * A great deal of civic reporting happens at stations — the subway that
 * floods, the approach road, the platform with no light — and the card
 * naming "Grand Southern Trunk Road, Sattamangalam" for a photo taken on
 * Potheri's platform is technically an address and practically useless to
 * the person reading the complaint. The station is the landmark; the
 * street is the detail underneath it.
 *
 * THE FOOTPRINT IS MEASURED, NOT ASSUMED, AND IT IS NOT A CIRCLE.
 *
 * A station's extent is its platforms, and platforms are long and thin: a
 * terminus runs 600 m end to end while a suburban halt is under 200. The
 * obvious approach — one radius from the station point — fails at both
 * ends. Sized to reach the end of the platforms it becomes a 350 m circle
 * claiming every road, shop and house around the station; sized to the
 * building it stops short of the platform a photo was taken on.
 *
 * So each station carries the BOUNDING BOX of its own platforms, plus a
 * small buffer for concourse and entrances. That is the shape of the
 * thing, taken from the geometry OSM already holds. Stations with no
 * mapped platform fall back to a circle whose radius is the median of the
 * measured ones — still a measurement, just somebody else's.
 *
 *   node scripts/build-rail.mjs [packId ...]
 *
 * Data © OpenStreetMap contributors, ODbL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PACKS = "public/data/packs";
const OVERPASS = "https://overpass-api.de/api/interpreter";
/** Platforms further than this from a station point belong to another
 *  station; beyond it we are measuring the next stop down the line. */
const PLATFORM_SEARCH_M = 700;
/** Concourse, entrances and forecourt: how far outside the platforms
 *  still counts as being at the station. */
const BUFFER_M = 60;
/** Bounds for the fallback circle used where no platform is mapped. */
const MIN_RADIUS_M = 80;
const MAX_RADIUS_M = 250;
/** Card languages we can actually draw (see i18n/languages.ts). */
const LANG_TAGS = ["ta", "hi", "kn", "te", "ml", "bn", "mr"];

const metres = (aLat, aLng, bLat, bLng) => {
  const dLat = (aLat - bLat) * 111_320;
  const dLng = (aLng - bLng) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

async function overpass(query) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(OVERPASS, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Overpass answers 406 to a request with no identifiable agent
          "User-Agent": "chennai-gps-camera/1.x (+https://github.com/reclaimchennai/chennai-gps-camera)",
        },
        body: new URLSearchParams({ data: query }),
      });
      if (res.status === 429 || res.status === 504) throw new Error(`http ${res.status}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      // the public instance rate-limits hard; back off rather than hammer
      await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
    }
  }
}

const index = JSON.parse(readFileSync(join(PACKS, "index.json"), "utf8"));
const wanted = process.argv.slice(2);
const targets = wanted.length
  ? index.packs.filter((p) => wanted.includes(p.id))
  : index.packs;

/** Collected across every pack, so the fallback radius is a real median. */
const measured = { station: [], halt: [] };
const perPack = new Map();

for (const entry of targets) {
  const [w, s, e, n] = entry.bbox;
  const bbox = `${s},${w},${n},${e}`;
  process.stdout.write(`${entry.id}: stations… `);

  const q = `[out:json][timeout:300];
(
  node["railway"~"^(station|halt)$"]["name"](${bbox});
  way["railway"~"^(station|halt)$"]["name"](${bbox});
);
out center tags;`;
  const stationsRaw = (await overpass(q)).elements ?? [];

  process.stdout.write(`${stationsRaw.length} found, platforms… `);
  const qp = `[out:json][timeout:300];
(
  way["railway"="platform"](${bbox});
  way["public_transport"="platform"]["railway"](${bbox});
);
out geom;`;
  let platforms = [];
  try {
    platforms = (await overpass(qp)).elements ?? [];
  } catch {
    process.stdout.write("(platform query failed) ");
  }
  process.stdout.write(`${platforms.length}\n`);

  const list = [];
  for (const el of stationsRaw) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const t = el.tags ?? {};
    const kind = t.railway === "halt" ? "halt" : "station";
    // Metro, monorail and tram stops are all tagged railway=station, and
    // calling Alandur a "Railway Station" is as wrong as calling Potheri
    // a Metro one. The mode comes from the tags rather than the name.
    const mode =
      t.station === "subway" || t.subway === "yes"
        ? "metro"
        : t.station === "monorail" || t.monorail === "yes"
          ? "monorail"
          : t.station === "light_rail" || t.light_rail === "yes"
            ? "light_rail"
            : "rail";

    // envelope of every platform vertex belonging to this station
    let env = null;
    let far = 0;
    for (const p of platforms) {
      for (const g of p.geometry ?? []) {
        const d = metres(lat, lng, g.lat, g.lon);
        if (d > PLATFORM_SEARCH_M) continue;
        if (d > far) far = d;
        env = env
          ? [
              Math.min(env[0], g.lon), Math.min(env[1], g.lat),
              Math.max(env[2], g.lon), Math.max(env[3], g.lat),
            ]
          : [g.lon, g.lat, g.lon, g.lat];
      }
    }
    const names = {};
    for (const code of LANG_TAGS) {
      const v = t[`name:${code}`];
      if (typeof v === "string" && v.trim()) names[code] = v.trim();
    }
    if (far > 0) measured[kind].push(far);
    list.push({
      env,
      name: t.name.trim(),
      names,
      code: t.ref?.trim() || undefined,
      operator: t.operator?.trim() || undefined,
      kind,
      mode,
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
      measured: far > 0 ? Math.round(far) : null,
    });
  }
  perPack.set(entry.id, list);
}

const median = (xs) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
// Half the measured reach: the fallback is a circle around the station
// POINT, and the station point normally sits mid-platform, so half the
// distance to the far end is the honest radius for "at this station".
const fallback = {
  station: Math.round((median(measured.station) ?? 200) / 2),
  halt: Math.round((median(measured.halt) ?? 120) / 2),
};
console.log(
  `\nmeasured platform reach — station fallback radius ${fallback.station} m ` +
    `(${measured.station.length} samples), halt median ${fallback.halt} m ` +
    `(${measured.halt.length} samples)`
);

const clamp = (v) => Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, Math.round(v)));

for (const entry of targets) {
  const list = perPack.get(entry.id) ?? [];
  const features = list.map((st) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [st.lng, st.lat] },
    properties: {
      name: st.name,
      ...(Object.keys(st.names).length ? { names: st.names } : {}),
      ...(st.code ? { code: st.code } : {}),
      ...(st.operator ? { operator: st.operator } : {}),
      kind: st.kind,
      ...(st.mode !== "rail" ? { mode: st.mode } : {}),
      // The shape the app matches against. `env` is the platforms' own
      // bounding box in degrees; `radius` is the fallback circle for
      // stations whose platforms nobody has mapped. Both are widened by
      // BUFFER_M at lookup time, not here, so the buffer stays one number
      // in one place.
      ...(st.env ? { env: st.env.map((v) => +v.toFixed(6)) } : {}),
      radius: clamp(st.measured ?? fallback[st.kind]),
      measured: st.measured != null,
    },
  }));

  const file = join(PACKS, entry.file);
  const pack = JSON.parse(readFileSync(file, "utf8"));
  pack.layers.rail = { type: "FeatureCollection", features };
  if (!/OpenStreetMap/.test(pack.attribution)) {
    pack.attribution += "; railway stations © OpenStreetMap contributors (ODbL)";
  } else if (!/railway/.test(pack.attribution)) {
    pack.attribution = pack.attribution.replace(
      /cantonments © OpenStreetMap contributors \(ODbL\)/,
      "cantonments and railway stations © OpenStreetMap contributors (ODbL)"
    );
  }

  // Re-version exactly as build-packs.mjs does: blank the version, hash
  // the body, write it back in. Mutating the parsed object in place —
  // rebuilding it from a literal is how tamilnadu.grids was silently
  // dropped once before.
  pack.version = "";
  const sha = createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 12);
  pack.version = sha;
  const json = JSON.stringify(pack);
  writeFileSync(file, json);

  const ie = index.packs.find((p) => p.id === entry.id);
  ie.version = sha;
  ie.bytes = Buffer.byteLength(json);
  ie.attribution = pack.attribution;

  const withPlatforms = features.filter((f) => f.properties.measured).length;
  console.log(
    `pack ${entry.id}: ${features.length} stations ` +
      `(${withPlatforms} with measured platforms), ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`
  );
}

index.version = createHash("sha256")
  .update(index.packs.map((p) => p.version).join(""))
  .digest("hex")
  .slice(0, 12);
writeFileSync(join(PACKS, "index.json"), JSON.stringify(index, null, 1));
console.log(`index version ${index.version}`);
