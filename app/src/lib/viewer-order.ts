/**
 * Custom carousel order for the media viewer.
 *
 * Opened from the photo map, swiping should walk PLACES, not the clock:
 * everything shot at the same spot first (oldest to newest), then the
 * nearest other spot, and so on outward — a nearest-neighbour chain. The
 * map sets that order here before navigating; the gallery clears it so its
 * own chronological order still applies when browsing normally.
 */

let order: string[] | null = null;

export function setViewerOrder(ids: string[]): void {
  order = ids.length > 1 ? ids : null;
}

export function clearViewerOrder(): void {
  order = null;
}

/** The custom order, if one is active and contains this item. */
export function viewerOrderFor(id: string): string[] | null {
  return order && order.includes(id) ? order : null;
}

/**
 * Nearest-neighbour chain over capture locations, starting from `startId`.
 * Photos within ~120 m count as the same place and stay chronological
 * inside it; places are visited greedily by distance from the current one.
 */
export function neighbourhoodOrder(
  items: { id: string; lat: number; lng: number; createdAt: number }[],
  startId: string
): string[] {
  const start = items.find((i) => i.id === startId);
  if (!start) return items.map((i) => i.id);
  const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    // equirectangular approximation — fine at city scale
    const kx = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111320;
    const dx = (a.lng - b.lng) * kx;
    const dy = (a.lat - b.lat) * 110540;
    return Math.hypot(dx, dy);
  };
  const SAME_PLACE_M = 120;
  // group into places
  const places: { lat: number; lng: number; members: typeof items }[] = [];
  for (const it of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    const hit = places.find((p) => dist(p, it) < SAME_PLACE_M);
    if (hit) hit.members.push(it);
    else places.push({ lat: it.lat, lng: it.lng, members: [it] });
  }
  // walk places greedily from the one holding the start photo
  let cur = places.find((p) => p.members.some((m) => m.id === startId))!;
  const left = new Set(places);
  const out: string[] = [];
  while (cur) {
    left.delete(cur);
    out.push(...cur.members.map((m) => m.id));
    let best: typeof cur | null = null;
    let bestD = Infinity;
    for (const p of left) {
      const d = dist(cur, p);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    cur = best!;
    if (!best) break;
  }
  return out;
}

/**
 * Where the viewer was opened from, so back returns there in one step.
 *
 * The viewer replaces its own history entry on every swipe, so the browser
 * history is not a reliable description of "where I came from" — going back
 * could land on a replaced entry and appear to do nothing. Whoever opens
 * the viewer records the route to return to.
 */
let origin = "/gallery";

export function setViewerOrigin(path: string): void {
  origin = path;
}

export function viewerOrigin(): string {
  return origin;
}
