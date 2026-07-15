/**
 * Versioned geodata bundle loader (§6 "data freshness").
 *
 * Boot: serve from IndexedDB if a bundle was previously stored, else
 * fetch the copy shipped with the app (service-worker cached, so this
 * works offline from the second visit onward).
 *
 * Background: when online, check /data/version.json; if the server has
 * a newer bundle, download and store it in IndexedDB so data fixes
 * (e.g. Avadi ward polygons landing) reach users without an app release.
 */
import { kvGet, kvSet } from "../db";
import type { FeatureCollection } from "geojson";

export interface GeoBundle {
  version: string;
  lo: FeatureCollection;
  traffic: FeatureCollection;
  ulb: FeatureCollection;
  stations: FeatureCollection;
}

const FILES = ["lo", "traffic", "ulb", "stations"] as const;
const KV_KEY = "geodata-bundle";

let bundle: GeoBundle | null = null;
let loading: Promise<GeoBundle> | null = null;

async function fetchBundle(version: string): Promise<GeoBundle> {
  const [lo, traffic, ulb, stations] = await Promise.all(
    FILES.map(async (f) => {
      const r = await fetch(`/data/${f}.geojson?v=${version}`);
      if (!r.ok) throw new Error(`geodata fetch failed: ${f}`);
      return (await r.json()) as FeatureCollection;
    })
  );
  return { version, lo, traffic, ulb, stations };
}

async function fetchVersion(): Promise<string | null> {
  try {
    const r = await fetch("/data/version.json", { cache: "no-cache" });
    if (!r.ok) return null;
    const m = (await r.json()) as { version?: string };
    return m.version ?? null;
  } catch {
    return null;
  }
}

export async function loadGeodata(): Promise<GeoBundle> {
  if (bundle) return bundle;
  if (loading) return loading;
  loading = (async () => {
    const stored = await kvGet<GeoBundle>(KV_KEY);
    if (stored?.lo) {
      bundle = stored;
    } else {
      const version = (await fetchVersion()) ?? "bundled";
      bundle = await fetchBundle(version);
      kvSet(KV_KEY, bundle).catch(() => {});
    }
    return bundle;
  })();
  return loading;
}

/** Fire-and-forget freshness check; resolves true if data was updated. */
export async function refreshGeodata(): Promise<boolean> {
  if (!navigator.onLine) return false;
  const current = bundle ?? (await kvGet<GeoBundle>(KV_KEY)) ?? null;
  const latest = await fetchVersion();
  if (!latest || latest === current?.version) return false;
  try {
    const fresh = await fetchBundle(latest);
    bundle = fresh;
    await kvSet(KV_KEY, fresh);
    return true;
  } catch {
    return false;
  }
}
