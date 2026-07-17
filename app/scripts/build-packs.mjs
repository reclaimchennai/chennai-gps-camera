#!/usr/bin/env node
/**
 * Region-pack builder — turns raw boundary datasets into the app's
 * versioned, normalized geodata packs (app/public/data/packs/).
 *
 * Sources:
 *  - Tamil Nadu (statewide ULB wards + L&O + traffic police + stations):
 *    the Reclaim Chennai police-locator dataset on this machine
 *    (~/projects/police/police-locator-20260525-1033/public/data).
 *  - Bengaluru, Delhi, Hyderabad, Kolkata, Mumbai, Pune, Visakhapatnam:
 *    Vonter/city-officials (github.com/Vonter/city-officials, GPL-3.0),
 *    which itself builds on datasets published on data.opencity.in and
 *    the respective government sources. Downloaded into a local cache
 *    (scripts/.pack-sources) on first run.
 *
 * Output schema per pack (data/packs/<id>.json):
 *   { id, name, attribution, version, bbox, layers: { ulb, lo, traffic, stations } }
 *   ulb feature props:   { corp, city, ward?, wardName?, zone? }
 *   lo feature props:    { station, locality?, district?, ac?, dc?, zone?, phone?, avadi? }
 *   traffic props:       { station, subDivision?, district? }
 *   stations props:      { code?, name?, label? }
 * plus data/packs/index.json listing packs in PRIORITY order (first
 * bbox match wins — chennai overrides the statewide tamilnadu pack).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import bbox from "@turf/bbox";
import booleanIntersects from "@turf/boolean-intersects";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import pointOnFeature from "@turf/point-on-feature";
import { polygon as turfPolygon } from "@turf/helpers";
import { feature as topoToGeo } from "topojson-client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TN_SRC = join(
  process.env.HOME,
  "projects/police/police-locator-20260525-1033/public/data"
);
const CACHE = join(__dirname, ".pack-sources");
const OUT = join(__dirname, "..", "public", "data", "packs");
mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const COORD_DECIMALS = 5;
const round = (n) => Number(n.toFixed(COORD_DECIMALS));
const roundCoords = (c) =>
  typeof c[0] === "number" ? [round(c[0]), round(c[1])] : c.map(roundCoords);
const clean = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
};
const titleish = (s) =>
  s && s.toUpperCase() === s
    ? s.replace(/\w\S*/g, (w) => w[0] + w.slice(1).toLowerCase())
    : s;

function normFeature(f, props) {
  return {
    type: "Feature",
    bbox: bbox(f).map(round),
    properties: props,
    geometry: {
      type: f.geometry.type,
      coordinates: roundCoords(f.geometry.coordinates),
    },
  };
}

function fc(features) {
  return { type: "FeatureCollection", features };
}

/** Download a city-officials TopoJSON into the cache, return GeoJSON FC. */
function fetchTopo(city, layer) {
  const cachePath = join(CACHE, `${city}_${layer}.json`);
  if (!existsSync(cachePath)) {
    const url = `https://raw.githubusercontent.com/Vonter/city-officials/main/static/${city}/${layer}.json`;
    console.log(`  fetching ${city}/${layer}`);
    execFileSync("curl", ["-sfL", url, "-o", cachePath]);
  }
  const topo = JSON.parse(readFileSync(cachePath, "utf8"));
  const objName = Object.keys(topo.objects)[0];
  return topoToGeo(topo, topo.objects[objName]);
}

/** point-in-polygon join helper: returns matching feature's props. */
function joinAt(feature, targets) {
  if (!targets) return undefined;
  let pt;
  try {
    pt = pointOnFeature(feature);
  } catch {
    return undefined;
  }
  for (const t of targets.features) {
    try {
      if (booleanPointInPolygon(pt, t)) return t.properties;
    } catch {
      // skip invalid target geometry
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------
// Tamil Nadu (statewide) — from the police-locator dataset
// ---------------------------------------------------------------------
function buildTamilNadu() {
  const load = (n) => JSON.parse(readFileSync(join(TN_SRC, n), "utf8"));
  console.log("Tamil Nadu: loading source layers…");
  const rawUlb = load("ulb.geojson");
  const rawLo = load("lo.geojson");
  const rawTraffic = load("traffic.geojson");
  const rawStations = load("stations.geojson");

  const ulb = fc(
    rawUlb.features.map((f) => {
      const p = f.properties;
      const name = clean(p.ulb);
      const type = clean(p.ulbType);
      const corp =
        name === "Chennai" && type === "Corporation"
          ? "Greater Chennai Corporation"
          : [name, type].filter(Boolean).join(" ");
      return normFeature(f, {
        corp,
        city: name,
        ward: clean(p.ward),
        zone: clean(p.zone),
      });
    })
  );

  const lo = fc(
    rawLo.features.map((f) => {
      const p = f.properties;
      return normFeature(f, {
        station: titleish(clean(p.station)),
        locality: clean(p.district), // source `district` is a locality name
        district: clean(p.districtName),
        ac: clean(p.ac),
        dc: clean(p.dc),
        zone: clean(p.zone),
        phone: clean(p.phone),
        avadi: p.district === "Avadi" || undefined,
      });
    })
  );

  const traffic = fc(
    rawTraffic.features.map((f) => {
      const p = f.properties;
      const raw =
        clean(p.tiw) ?? clean(p.station) ?? clean(p.police_sta) ?? clean(p.police_s_2);
      // strip TIW markers wherever they appear ("X TIW", "Coimbatore-tiw West")
      const station = raw
        ? raw.replace(/[-\s]*\btiw\b[-\s]*/gi, " ").replace(/\s{2,}/g, " ").trim()
        : undefined;
      return normFeature(f, {
        station: titleish(station),
        subDivision: titleish(
          clean(p["Sub-Division"]) ?? clean(p.taluk) ?? clean(p.taluk_name)
        ),
        district: titleish(
          clean(p.District) ?? clean(p.district) ?? clean(p.district_n)
        ),
      });
    })
  );

  const stations = fc(
    rawStations.features
      .filter((f) => f.properties.active !== false)
      .map((f) =>
        normFeature(f, {
          code: clean(f.properties.code),
          name: clean(f.properties.name),
          label: clean(f.properties.label),
        })
      )
  );

  // --- chennai pilot pack: GCC + Tambaram wards + Avadi L&O + buffer ---
  const seeds = [
    ...ulb.features.filter(
      (f) => f.properties.corp === "Greater Chennai Corporation" ||
             f.properties.corp === "Tambaram Corporation"
    ),
    ...lo.features.filter((f) => f.properties.avadi),
  ];
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of seeds) {
    const b = f.bbox;
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  const BUF = 0.02;
  minX -= BUF; minY -= BUF; maxX += BUF; maxY += BUF;
  const rect = turfPolygon([[
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
  ]]);
  const inRect = (f) => {
    const b = f.bbox;
    if (b[0] > maxX || b[2] < minX || b[1] > maxY || b[3] < minY) return false;
    try {
      return booleanIntersects(f, rect);
    } catch {
      return false;
    }
  };
  const chennaiLayers = {
    ulb: fc(ulb.features.filter(inRect)),
    lo: fc(lo.features.filter(inRect)),
    traffic: fc(traffic.features.filter(inRect)),
    stations: fc(
      stations.features.filter((f) => {
        const [x, y] = f.geometry.coordinates;
        return x >= minX && x <= maxX && y >= minY && y <= maxY;
      })
    ),
  };

  const TN_ATTRIBUTION =
    "Boundary data from public Tamil Nadu government datasets, processed by the Reclaim Chennai project";
  return [
    {
      id: "chennai",
      name: "Chennai metro (GCC · Tambaram · Avadi)",
      attribution: TN_ATTRIBUTION,
      layers: chennaiLayers,
    },
    {
      id: "tamilnadu",
      name: "Tamil Nadu (statewide)",
      attribution: TN_ATTRIBUTION,
      layers: { ulb, lo, traffic, stations },
    },
  ];
}

// ---------------------------------------------------------------------
// city-officials cities
// ---------------------------------------------------------------------
const CO_ATTRIBUTION =
  "Boundary data from Vonter/city-officials (GPL-3.0), built on data.opencity.in and government sources";

/** parse "158: Bhati" → { ward: "158", wardName: "Bhati" } */
function splitNamecol(namecol) {
  const m = String(namecol ?? "").match(/^\s*([^:]+?)\s*:\s*(.+)$/);
  if (m) return { ward: m[1].trim(), wardName: m[2].trim() };
  return { ward: clean(namecol), wardName: undefined };
}

const CITIES = [
  {
    id: "bengaluru",
    name: "Bengaluru (GBA)",
    city: "Bengaluru",
    src: "blr",
    wards: "boundaries_gba_ward",
    corpLayer: "boundaries_gba_corporation", // per-ward spatial join
    zoneLayer: "boundaries_gba_zone",
    lo: "boundaries_police_city",
    traffic: "boundaries_police_traffic",
    zoneFmt: (p) =>
      p.boundaryNumber ? `${p.namecol} (${p.boundaryNumber})` : p.namecol,
  },
  {
    id: "hyderabad",
    name: "Hyderabad (GHMC)",
    city: "Hyderabad",
    src: "hyd",
    wards: "boundaries_hyd_ward",
    corp: "Greater Hyderabad Municipal Corporation",
    zoneLayer: "boundaries_hyd_zone",
    lo: "boundaries_police_city",
    traffic: "boundaries_police_traffic",
    zoneFmt: (p) => String(p.namecol ?? "").replace(/\s+zone$/i, ""),
  },
  {
    id: "delhi",
    name: "Delhi (MCD)",
    city: "Delhi",
    src: "delhi",
    wards: "boundaries_mcd_ward",
    corp: "Municipal Corporation of Delhi",
  },
  {
    id: "kolkata",
    name: "Kolkata (KMC)",
    city: "Kolkata",
    src: "kolkata",
    wards: "boundaries_kmc_ward",
    corp: "Kolkata Municipal Corporation",
    lo: "boundaries_police_station",
    wardParse: (p) => ({
      ward: clean(p.WARD) ?? splitNamecol(p.namecol).ward,
      wardName: undefined,
      zone: clean(p.borough),
    }),
  },
  {
    id: "mumbai",
    name: "Mumbai (BMC)",
    city: "Mumbai",
    src: "mumbai",
    wards: "boundaries_bmc_ward",
    corp: "Brihanmumbai Municipal Corporation",
    lo: "boundaries_police_city",
    wardParse: (p) => ({ ward: clean(p.namecol), wardName: undefined }),
  },
  {
    id: "pune",
    name: "Pune (PMC)",
    city: "Pune",
    src: "pune",
    wards: "boundaries_pmc_admin_ward",
    corp: "Pune Municipal Corporation",
    zoneLayer: "boundaries_pmc_zone",
    zoneFmt: (p) => String(p.namecol ?? "").replace(/^zone\s+/i, ""),
  },
  {
    id: "visakhapatnam",
    name: "Visakhapatnam (GVMC)",
    city: "Visakhapatnam",
    src: "vizag",
    wards: "boundaries_vizag_corp_ward",
    corp: "Greater Visakhapatnam Municipal Corporation",
    zoneLayer: "boundaries_vizag_corp_zone",
    zoneFmt: (p) => String(p.namecol ?? "").replace(/\s+zone$/i, ""),
    wardParse: (p) => {
      const { ward } = splitNamecol(p.namecol);
      const wardName = String(p.wardName ?? "")
        .replace(/\s*ward\s*\d+\s*$/i, "")
        .trim();
      return { ward, wardName: wardName || undefined };
    },
  },
];

function buildCity(cfg) {
  console.log(`${cfg.name}:`);
  const wardsFC = fetchTopo(cfg.src, cfg.wards);
  const zonesFC = cfg.zoneLayer ? fetchTopo(cfg.src, cfg.zoneLayer) : null;
  const corpsFC = cfg.corpLayer ? fetchTopo(cfg.src, cfg.corpLayer) : null;

  const ulb = fc(
    wardsFC.features.filter((f) => f.geometry).map((f) => {
      const parsed = cfg.wardParse
        ? cfg.wardParse(f.properties)
        : splitNamecol(f.properties.namecol);
      const zoneProps = zonesFC ? joinAt(f, zonesFC) : undefined;
      const corpProps = corpsFC ? joinAt(f, corpsFC) : undefined;
      return normFeature(f, {
        corp: corpProps?.namecol ?? cfg.corp,
        city: cfg.city,
        ward: parsed.ward,
        wardName: parsed.wardName,
        zone:
          parsed.zone ??
          (zoneProps && cfg.zoneFmt ? clean(cfg.zoneFmt(zoneProps)) : undefined),
      });
    })
  );

  const mapPolice = (layer) =>
    layer
      ? fc(
          fetchTopo(cfg.src, layer)
            .features.filter((f) => f.geometry)
            .map((f) =>
              normFeature(f, { station: clean(f.properties.namecol) })
            )
        )
      : fc([]);

  return {
    id: cfg.id,
    name: cfg.name,
    attribution: CO_ATTRIBUTION,
    layers: {
      ulb,
      lo: mapPolice(cfg.lo),
      traffic: mapPolice(cfg.traffic),
      stations: fc([]),
    },
  };
}

// ---------------------------------------------------------------------
// assemble packs + index
// ---------------------------------------------------------------------
function packBbox(layers) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const layer of Object.values(layers)) {
    for (const f of layer?.features ?? []) {
      const b = f.bbox ?? bbox(f);
      if (b[0] < minX) minX = b[0];
      if (b[1] < minY) minY = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxY) maxY = b[3];
    }
  }
  return [minX, minY, maxX, maxY].map(round);
}

const [chennaiPack, tamilnaduPack] = buildTamilNadu();
// PRIORITY order: first bbox match wins. Chennai pilot pack outranks the
// statewide Tamil Nadu pack; tamilnadu goes last as the catch-all.
const packs = [chennaiPack, ...CITIES.map(buildCity), tamilnaduPack];

const index = { version: "", packs: [] };
const hashes = [];
for (const p of packs) {
  const box = packBbox(p.layers);
  const body = {
    id: p.id,
    name: p.name,
    attribution: p.attribution,
    version: "",
    bbox: box,
    layers: p.layers,
  };
  let json = JSON.stringify(body);
  const sha = createHash("sha256").update(json).digest("hex").slice(0, 12);
  body.version = sha;
  json = JSON.stringify(body);
  writeFileSync(join(OUT, `${p.id}.json`), json);
  hashes.push(sha);
  index.packs.push({
    id: p.id,
    name: p.name,
    file: `${p.id}.json`,
    bbox: box,
    version: sha,
    bytes: Buffer.byteLength(json),
    attribution: p.attribution,
  });
  const counts = Object.entries(p.layers)
    .map(([k, v]) => `${k}:${v.features.length}`)
    .join(" ");
  console.log(
    `pack ${p.id}: ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB (${counts})`
  );
}
index.version = createHash("sha256").update(hashes.join("")).digest("hex").slice(0, 12);
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
console.log(`index version ${index.version}, ${packs.length} packs`);
