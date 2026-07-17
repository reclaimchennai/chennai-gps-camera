/**
 * Offline vector mini-map (§5.4 default path).
 *
 * Draws the matched ward (or L&O jurisdiction) outline plus neighbouring
 * boundaries and a pin, from the bundled polygon data, onto a small
 * canvas. Zero network, zero API cost, and deliberately does NOT mimic
 * Google branding — this is our own rendering of our own boundary data.
 *
 * The online Google Static Maps upgrade (backfill path) replaces this
 * canvas with a fetched image and only then shows Google attribution.
 */
import type { Feature, Position } from "geojson";
import { loadGeodataFor } from "../geo/geodata";
import type { LookupResult } from "../geo/lookup";

export const MINIMAP_SIZE = 256; // square, drawn at capture scale by renderer

interface MapStyle {
  bg: string;
  neighbor: string;
  focus: string;
  focusFill: string;
  pin: string;
}

const STYLE: MapStyle = {
  bg: "#17212b",
  neighbor: "rgba(148, 163, 184, 0.45)",
  focus: "#38bdf8",
  focusFill: "rgba(56, 189, 248, 0.14)",
  pin: "#f43f5e",
};

function eachRing(f: Feature, cb: (ring: Position[]) => void): void {
  const g = f.geometry;
  if (g.type === "Polygon") for (const r of g.coordinates) cb(r);
  else if (g.type === "MultiPolygon")
    for (const poly of g.coordinates) for (const r of poly) cb(r);
}

let cacheKey = "";
let cacheCanvas: HTMLCanvasElement | null = null;

/**
 * Render the offline mini-map for a location. Cached by focus feature +
 * ~30 m position cell, so live-preview calls are nearly free.
 */
export async function renderMiniMap(
  lat: number,
  lng: number,
  lookupResult: LookupResult | null
): Promise<HTMLCanvasElement | null> {
  const focus =
    lookupResult?.wardFeature ?? lookupResult?.loFeature ?? null;

  const key = `${focus ? JSON.stringify(focus.bbox) : "none"}|${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (key === cacheKey && cacheCanvas) return cacheCanvas;

  const pack = await loadGeodataFor(lat, lng).catch(() => null);
  if (!pack) return null;

  const size = MINIMAP_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // View window: the focus polygon's bbox padded 25%, or ~600 m around
  // the point when nothing matched.
  let [minX, minY, maxX, maxY] = focus?.bbox ?? [
    lng - 0.006,
    lat - 0.006,
    lng + 0.006,
    lat + 0.006,
  ];
  // keep the pin inside the window
  minX = Math.min(minX, lng);
  maxX = Math.max(maxX, lng);
  minY = Math.min(minY, lat);
  maxY = Math.max(maxY, lat);
  const padX = (maxX - minX) * 0.25 || 0.002;
  const padY = (maxY - minY) * 0.25 || 0.002;
  minX -= padX; maxX += padX; minY -= padY; maxY += padY;

  // Square aspect: expand the shorter axis (lat degrees ≈ lng degrees
  // near the equator is close enough at Chennai's latitude for a thumb).
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX > spanY) {
    const grow = (spanX - spanY) / 2;
    minY -= grow; maxY += grow;
  } else {
    const grow = (spanY - spanX) / 2;
    minX -= grow; maxX += grow;
  }

  const px = (x: number) => ((x - minX) / (maxX - minX)) * size;
  const py = (y: number) => size - ((y - minY) / (maxY - minY)) * size;

  ctx.fillStyle = STYLE.bg;
  ctx.fillRect(0, 0, size, size);

  const drawFeature = (f: Feature, stroke: string, fill?: string): void => {
    ctx.beginPath();
    eachRing(f, (ring) => {
      ring.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(px(x), py(y));
        else ctx.lineTo(px(x), py(y));
      });
      ctx.closePath();
    });
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = fill ? 2 : 1;
    ctx.stroke();
  };

  // Neighbour context: ward boundaries whose bbox overlaps the window.
  const layer = lookupResult?.wardFeature ? pack.layers.ulb : pack.layers.lo;
  let drawn = 0;
  for (const f of layer.features as Feature[]) {
    if (!f.bbox) continue;
    if (f.bbox[0] > maxX || f.bbox[2] < minX || f.bbox[1] > maxY || f.bbox[3] < minY) continue;
    if (f === focus) continue;
    drawFeature(f, STYLE.neighbor);
    if (++drawn > 40) break; // thumbnails don't need more context than this
  }
  if (focus) drawFeature(focus, STYLE.focus, STYLE.focusFill);

  // Pin
  const cx = px(lng);
  const cy = py(lat);
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = STYLE.pin;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();

  cacheKey = key;
  cacheCanvas = canvas;
  return canvas;
}
