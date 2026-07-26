/**
 * Thumbnail blob URLs that survive navigation.
 *
 * The gallery unmounts whenever a photo is opened, and it used to revoke
 * every thumbnail URL on the way out. Coming back therefore meant: paint an
 * empty grid, re-read every record from IndexedDB, rebuild and re-decode
 * every thumbnail — a visible flash on each round trip, and much worse in
 * the Android WebView than in Chrome, which keeps decoded images warm.
 *
 * Keeping the URLs here instead means returning to the gallery paints the
 * previous grid immediately and only updates what actually changed.
 * Thumbnails are small (a few KB each), so holding them is cheap; entries
 * are released when their record disappears.
 */

const urls = new Map<string, string>();

/** Last painted grid, so a remount has something to show at once. */
let lastCells: unknown = null;

export function getThumbUrl(id: string): string | null {
  return urls.get(id) ?? null;
}

export function setThumbUrl(id: string, url: string): void {
  const old = urls.get(id);
  if (old && old !== url) URL.revokeObjectURL(old);
  urls.set(id, url);
}

/** Release anything whose record no longer exists. */
export function pruneThumbs(keepIds: Iterable<string>): void {
  const keep = new Set(keepIds);
  for (const [id, url] of urls) {
    if (!keep.has(id)) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
  }
}

export function dropThumb(id: string): void {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

export function rememberCells<T>(cells: T): void {
  lastCells = cells;
}

export function recallCells<T>(): T | null {
  return (lastCells as T) ?? null;
}
