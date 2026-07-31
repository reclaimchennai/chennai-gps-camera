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

// 512 so the thumb stays crisp when the card stretches it vertically —
// at 256 the upscale was visibly soft on a full-resolution photo
export const MINIMAP_SIZE = 512;

/**
 * Light paper map with a lit ward.
 *
 * The first version was dark slate with a flat cyan outline and a rose
 * dot — stock dashboard colours that made a real boundary dataset look
 * like filler. This reads as a printed map instead: warm paper, parcels
 * in soft ink, and the ward you are standing in genuinely lit, its glow
 * painted as a blurred pass under a crisp edge rather than a translucent
 * fill pretending to be one.
 */
const INK = {
  paper0: "#fbfcfe",
  paper1: "#e9eff6",
  neighborLine: "rgba(96, 120, 150, 0.32)",
  neighborFill: "rgba(255, 255, 255, 0.55)",
  glow: "rgba(14, 165, 233, 0.55)",
  focusLine: "#0369a1",
  focusA: "rgba(56, 189, 248, 0.42)",
  focusB: "rgba(125, 211, 252, 0.10)",
  pin: "#e11d48",
  pinGlow: "rgba(225, 29, 72, 0.45)",
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

  // unit scale so every stroke and radius tracks MINIMAP_SIZE
  const u = size / 256;

  // paper: soft radial lift towards the middle, so the tile has depth
  // without a border or a drop shadow doing the work
  const paper = ctx.createRadialGradient(
    size / 2, size * 0.42, size * 0.08,
    size / 2, size / 2, size * 0.78
  );
  paper.addColorStop(0, INK.paper0);
  paper.addColorStop(1, INK.paper1);
  ctx.fillStyle = paper;
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
    ctx.lineWidth = (fill ? 2 : 1) * u;
    ctx.stroke();
  };

  // Neighbour context: ward boundaries whose bbox overlaps the window.
  const layer = lookupResult?.wardFeature ? pack.layers.ulb : pack.layers.lo;
  let drawn = 0;
  for (const f of layer.features as Feature[]) {
    if (!f.bbox) continue;
    if (f.bbox[0] > maxX || f.bbox[2] < minX || f.bbox[1] > maxY || f.bbox[3] < minY) continue;
    if (f === focus) continue;
    drawFeature(f, INK.neighborLine, INK.neighborFill);
    if (++drawn > 40) break; // thumbnails don't need more context than this
  }

  if (focus) {
    // the lit ward: a blurred pass lays the halo down, then a clean edge
    // is drawn over it. Faking the glow with one translucent stroke is
    // what made the old tile look flat.
    ctx.save();
    ctx.shadowColor = INK.glow;
    ctx.shadowBlur = 16 * u;
    ctx.lineJoin = "round";
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, INK.focusA);
    grad.addColorStop(1, INK.focusB);
    drawFeature(focus, INK.focusLine, grad as unknown as string);
    ctx.shadowBlur = 8 * u;
    drawFeature(focus, INK.focusLine);
    ctx.restore();
    drawFeature(focus, INK.focusLine);
  }

  // Pin: halo, white collar, core — reads at thumbnail size where a flat
  // dot just disappears into the boundary lines
  const cx = px(lng);
  const cy = py(lat);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 15 * u);
  halo.addColorStop(0, INK.pinGlow);
  halo.addColorStop(1, "rgba(225, 29, 72, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, 15 * u, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 7 * u, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 4.6 * u, 0, Math.PI * 2);
  ctx.fillStyle = INK.pin;
  ctx.fill();

  cacheKey = key;
  cacheCanvas = canvas;
  return canvas;
}
