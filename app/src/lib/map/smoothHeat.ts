/**
 * A heatmap that follows the fingers.
 *
 * leaflet.heat repaints the whole heatmap on `moveend` and ignores the
 * `zoom` events a pinch is made of, so during a pinch the heat sat still
 * while the map moved under it, then jumped and repainted once the
 * gesture ended — the stutter and delay on the photo map.
 *
 * Here the heat is painted once into a canvas pinned to the map like an
 * image (an ImageOverlay whose image is that canvas). A pinch only moves
 * and scales it — one cheap transform per frame, done by the map itself.
 * It is repainted only when the gesture is over and the view has really
 * changed: a different zoom, or a pan past the margin painted around the
 * screen. The paint runs in idle time, so it never lands on a frame the
 * user is watching move.
 */
import L from "leaflet";

export interface SmoothHeatOptions {
  /** point radius and blur, in screen pixels at the painted zoom */
  radius?: number;
  blur?: number;
  /** floor on a single point's strength, 0..1 */
  minOpacity?: number;
}

/** simpleheat's palette — the same colours the map had */
const GRADIENT: [number, string][] = [
  [0.4, "blue"],
  [0.6, "cyan"],
  [0.7, "lime"],
  [0.8, "yellow"],
  [1.0, "red"],
];

/** Screen area painted beyond each edge, as a fraction of the screen: a
 *  pan within it needs no repaint. */
const MARGIN = 0.5;

function palette(): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  for (const [stop, colour] of GRADIENT) grad.addColorStop(stop, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 256);
  return g.getImageData(0, 0, 1, 256).data;
}

function stamp(r: number, blur: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const r2 = r + blur;
  c.width = c.height = r2 * 2;
  const g = c.getContext("2d")!;
  // the circle is drawn off-canvas and only its blurred shadow lands —
  // simpleheat's trick for a soft round stamp
  g.shadowOffsetX = g.shadowOffsetY = r2 * 2;
  g.shadowBlur = blur;
  g.shadowColor = "black";
  g.beginPath();
  g.arc(-r2, -r2, r, 0, Math.PI * 2, true);
  g.closePath();
  g.fill();
  return c;
}

type Overlay = L.ImageOverlay & { _image?: HTMLElement };

/** An ImageOverlay whose image is a canvas we paint ourselves. */
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage(this: Overlay & { _url: HTMLCanvasElement; _zoomAnimated: boolean }) {
    const c = this._url;
    this._image = c;
    L.DomUtil.addClass(c, "leaflet-image-layer");
    if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
    c.style.pointerEvents = "none";
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
  },
}) as unknown as new (canvas: HTMLCanvasElement, bounds: L.LatLngBounds, opts?: L.ImageOverlayOptions) => L.ImageOverlay;

export function smoothHeat(points: [number, number][], opts: SmoothHeatOptions = {}): L.Layer {
  const radius = opts.radius ?? 28;
  const blur = opts.blur ?? 22;
  const minOpacity = opts.minOpacity ?? 0.35;
  const pal = palette();
  const dot = stamp(radius, blur);
  const r2 = radius + blur;

  const group = L.layerGroup();
  let map: L.Map | null = null;
  let overlay: L.ImageOverlay | null = null;
  let painted: { zoom: number; bounds: L.LatLngBounds } | null = null;
  let idle = 0;

  const paint = () => {
    if (!map) return;
    const zoom = map.getZoom();
    const size = map.getSize();
    const mx = Math.round(size.x * MARGIN);
    const my = Math.round(size.y * MARGIN);
    const topLeft = map.containerPointToLayerPoint([-mx, -my]);
    const w = size.x + mx * 2;
    const h = size.y + my * 2;
    const bounds = L.latLngBounds(
      map.layerPointToLatLng(topLeft),
      map.layerPointToLatLng(topLeft.add([w, h]))
    );

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    const origin = map.project(map.layerPointToLatLng(topLeft), zoom);
    // leaflet.heat's weighting, so it looks as it did: points are summed
    // into cells half a radius wide, a point counts less the further out
    // the map is, and a cell is never fainter than minOpacity
    const k = 1 / 2 ** Math.max(0, Math.min(map.getMaxZoom() - zoom, 12));
    const cell = Math.max(1, radius / 2);
    const cells = new Map<string, { x: number; y: number; v: number; n: number }>();
    for (const [lat, lng] of points) {
      const p = map.project([lat, lng], zoom).subtract(origin);
      if (p.x < -r2 || p.y < -r2 || p.x > w + r2 || p.y > h + r2) continue;
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      const c = cells.get(key);
      if (c) {
        // weighted centre, as leaflet.heat does
        c.x = (c.x * c.n + p.x) / (c.n + 1);
        c.y = (c.y * c.n + p.y) / (c.n + 1);
        c.v += k;
        c.n++;
      } else cells.set(key, { x: p.x, y: p.y, v: k, n: 1 });
    }
    for (const c of cells.values()) {
      g.globalAlpha = Math.min(Math.max(c.v, minOpacity), 1);
      g.drawImage(dot, c.x - r2, c.y - r2);
    }
    // colourise: the stacked alpha picks the colour, and stays the alpha
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 3; i < d.length; i += 4) {
      const a = d[i];
      if (!a) continue;
      const j = a * 4;
      d[i - 3] = pal[j];
      d[i - 2] = pal[j + 1];
      d[i - 1] = pal[j + 2];
    }
    g.putImageData(img, 0, 0);

    // swap in one step: the new canvas replaces the old with no frame
    // where neither shows
    const next = new CanvasOverlay(canvas, bounds, { interactive: false, opacity: 1 });
    group.addLayer(next);
    if (overlay) group.removeLayer(overlay);
    overlay = next;
    painted = { zoom, bounds };
  };

  const schedule = () => {
    if (!map) return;
    const view = map.getBounds();
    const fresh =
      painted &&
      Math.abs(painted.zoom - map.getZoom()) < 0.25 &&
      painted.bounds.contains(view);
    if (fresh) return;
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    const cic = (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
    if (idle) (cic ?? window.clearTimeout)(idle);
    idle = ric ? ric(paint, { timeout: 200 }) : window.setTimeout(paint, 30);
  };

  group.on("add", (e) => {
    map = (e.target as L.LayerGroup & { _map: L.Map })._map;
    painted = null;
    paint();
    map.on("moveend", schedule);
  });
  group.on("remove", () => {
    map?.off("moveend", schedule);
    map = null;
    painted = null;
    if (overlay) group.removeLayer(overlay);
    overlay = null;
  });
  return group;
}
