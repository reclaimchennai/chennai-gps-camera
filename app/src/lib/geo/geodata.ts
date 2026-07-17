/**
 * Region-pack loader (multi-city coverage).
 *
 * Boundary data ships as bbox-indexed packs (data/packs/index.json).
 * The pack covering the current GPS fix is fetched lazily, cached in
 * IndexedDB, and refreshed when the server publishes a new version —
 * so coverage fixes reach installed users without an app release.
 * The Chennai pilot pack is precached with the app shell, keeping the
 * original fully-offline behavior there.
 *
 * Index order is PRIORITY order: the first bbox containing the fix
 * wins (the Chennai pack outranks the statewide Tamil Nadu pack).
 */
import { kvGet, kvSet } from "../db";
import type { FeatureCollection } from "geojson";

export interface PackLayers {
  ulb: FeatureCollection;
  lo: FeatureCollection;
  traffic: FeatureCollection;
  stations: FeatureCollection;
}

export interface GeoPack {
  id: string;
  name: string;
  attribution: string;
  version: string;
  bbox: number[];
  layers: PackLayers;
}

interface PackIndexEntry {
  id: string;
  name: string;
  file: string;
  bbox: number[];
  version: string;
  attribution: string;
}

interface PackIndex {
  version: string;
  packs: PackIndexEntry[];
}

let indexCache: PackIndex | null = null;
let indexPromise: Promise<PackIndex | null> | null = null;
let current: GeoPack | null = null;

async function loadIndex(): Promise<PackIndex | null> {
  if (indexCache) return indexCache;
  indexPromise ??= (async () => {
    try {
      const r = await fetch("/data/packs/index.json", { cache: "no-cache" });
      if (r.ok) {
        const idx = (await r.json()) as PackIndex;
        indexCache = idx;
        void kvSet("packs-index", idx);
        return idx;
      }
    } catch {
      // offline — fall through to the stored copy
    }
    const stored = await kvGet<PackIndex>("packs-index");
    if (stored) indexCache = stored;
    return stored ?? null;
  })();
  const result = await indexPromise;
  indexPromise = null;
  return result;
}

function containsPoint(box: number[], lng: number, lat: number): boolean {
  return lng >= box[0] && lng <= box[2] && lat >= box[1] && lat <= box[3];
}

/**
 * Return the geodata pack covering this location: memory → IndexedDB →
 * network, with a stale-cache fallback when offline. Null when the fix
 * is outside every pack (GPS-only mode).
 */
export async function loadGeodataFor(
  lat: number,
  lng: number
): Promise<GeoPack | null> {
  const idx = await loadIndex();
  if (!idx) return null;
  const entry = idx.packs.find((p) => containsPoint(p.bbox, lng, lat));
  if (!entry) return null;

  if (current?.id === entry.id && current.version === entry.version) {
    return current;
  }

  const cached = await kvGet<GeoPack>(`pack:${entry.id}`);
  if (cached?.version === entry.version) {
    current = cached;
    return cached;
  }

  try {
    const r = await fetch(`/data/packs/${entry.file}?v=${entry.version}`);
    if (!r.ok) throw new Error(`pack fetch ${r.status}`);
    const pack = (await r.json()) as GeoPack;
    current = pack;
    void kvSet(`pack:${entry.id}`, pack);
    return pack;
  } catch {
    // offline / fetch failed — a stale pack beats no pack
    if (cached) {
      current = cached;
      return cached;
    }
    return null;
  }
}

/** Warm the index (and IDB fallback copy) at boot. */
export function warmGeodata(): void {
  void loadIndex();
}
