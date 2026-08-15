/**
 * Remembered addresses, by place.
 *
 * People photograph the same places over and over — the street outside
 * their house, the corner that always floods, the stretch of road they
 * walk every morning. Re-asking a geocoder for an address we already
 * hold is a wait the user pays for and a request the provider counts,
 * both for an answer that has not changed.
 *
 * Keyed by a ~110 m grid cell AND the language, because the same cell in
 * Tamil and in English are different answers. Kept in IndexedDB so it
 * survives a restart, which is the whole point: the second morning is
 * faster than the first.
 */
import { kvGet, kvSet } from "./db";

interface Entry {
  address?: string;
  locality?: string;
  at: number;
}

/**
 * v2: entries written before the corroboration check could hold an answer
 * our own data contradicts ("Velachery" for a point in Maraimalainagar),
 * and a cache hit returns before any provider is consulted — so a bad
 * entry outlived the fix by up to its TTL. A new key retires them all.
 */
const KEY = "geocache-v2";
/**
 * ~11 m at 4 decimal places.
 *
 * It was 3, about 110 m, on the reasoning that an address is only
 * accurate to a block anyway. That is true of the address and false of
 * the cell: the FIRST point to land in a cell answers for the whole of
 * it, for a month, so a lookup made outside a station could be served to
 * someone standing on a different road — the two are the same cell. In a
 * city, ward and police boundaries turn over in as little as 50 m
 * (scripts/check-location.mjs measures it), so a block is not a rounding
 * error here, it is the whole distance that matters.
 */
const PRECISION = 4;
/** Addresses change when a road is renamed, which is rare; a month keeps
 *  the cache useful without pinning a stale name forever. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Bounded so a long drive cannot grow this without limit. Least
 *  recently written is dropped first. Raised with the precision above:
 *  finer cells mean more of them for the same ground covered. */
const MAX_ENTRIES = 4000;

let mem: Record<string, Entry> | null = null;
let writeTimer: number | null = null;

function cell(lat: number, lng: number, lang: string): string {
  return `${lat.toFixed(PRECISION)},${lng.toFixed(PRECISION)}|${lang}`;
}

async function load(): Promise<Record<string, Entry>> {
  if (mem) return mem;
  mem = (await kvGet<Record<string, Entry>>(KEY)) ?? {};
  return mem;
}

/** Batched: a drive would otherwise write the whole map on every fix. */
function scheduleFlush(): void {
  if (writeTimer != null) return;
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    void kvSet(KEY, mem ?? {});
  }, 4000);
}

export async function cachedAddress(
  lat: number,
  lng: number,
  lang: string
): Promise<{ address?: string; locality?: string } | null> {
  try {
    const all = await load();
    const hit = all[cell(lat, lng, lang)];
    if (!hit) return null;
    if (Date.now() - hit.at > TTL_MS) return null;
    return { address: hit.address, locality: hit.locality };
  } catch {
    return null; // a cache miss is never worth failing a capture over
  }
}

export async function rememberAddress(
  lat: number,
  lng: number,
  lang: string,
  value: { address?: string; locality?: string }
): Promise<void> {
  if (!value.address && !value.locality) return;
  try {
    const all = await load();
    all[cell(lat, lng, lang)] = { ...value, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => delete all[k]);
    }
    scheduleFlush();
  } catch {
    // storage full or unavailable — the app works, just without the cache
  }
}

/** Settings → clear cached data. */
export async function clearAddressCache(): Promise<void> {
  mem = {};
  await kvSet(KEY, {});
}
