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

/** Holding every thumbnail alive is memory the OS counts against us, and
 *  a heavier process is a process Android kills sooner in the background —
 *  which is what turns "switch back to the app" into a cold start. Keep a
 *  generous working set, not the whole library. */
const MAX_THUMBS = 400;

/**
 * Told when a URL is revoked, so whatever is displaying it can stop.
 *
 * Eviction used to be silent, which was a bug with teeth: a gallery over
 * MAX_THUMBS revoked the URLs it had just created, and the holder went on
 * rendering <img src="blob:…"> pointing at nothing. A revoked URL is still
 * a non-empty string, so every "do we have a thumbnail?" check passed and
 * the grid filled with broken-image icons instead of falling back to its
 * placeholder. Anything that keeps a URL from here must subscribe.
 */
const evictionListeners = new Set<(id: string) => void>();

export function onThumbEvicted(fn: (id: string) => void): () => void {
  evictionListeners.add(fn);
  return () => evictionListeners.delete(fn);
}

function release(id: string): void {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  for (const fn of evictionListeners) fn(id);
}

export function setThumbUrl(id: string, url: string): void {
  const old = urls.get(id);
  if (old && old !== url) URL.revokeObjectURL(old);
  urls.delete(id); // re-insert so Map order tracks recency
  urls.set(id, url);
  while (urls.size > MAX_THUMBS) {
    const oldest = urls.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    release(oldest);
  }
}

/** Release anything whose record no longer exists. */
export function pruneThumbs(keepIds: Iterable<string>): void {
  const keep = new Set(keepIds);
  for (const id of [...urls.keys()]) {
    if (!keep.has(id)) release(id);
  }
}

export function dropThumb(id: string): void {
  release(id);
}

export function rememberCells<T>(cells: T): void {
  lastCells = cells;
}

export function recallCells<T>(): T | null {
  return (lastCells as T) ?? null;
}

/** Gallery scroll offset, so returning from a photo lands where you were. */
let galleryScroll = 0;

export function rememberScroll(px: number): void {
  galleryScroll = px;
}

export function recallScroll(): number {
  return galleryScroll;
}
