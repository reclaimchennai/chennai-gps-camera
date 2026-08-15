/**
 * Legibility arithmetic for the card.
 *
 * A watermark that cannot be read is not evidence, so the card's colours
 * are not a matter of taste — they have to clear a contrast ratio against
 * whatever photo happens to be behind them. Panel opacity is what made
 * that fail: a 55%-opaque panel is half photo, so the ink is really being
 * read against a blend of the panel and a street scene nobody chose.
 *
 * Everything here is WCAG 2.x relative luminance, which is the only
 * contrast measure with a defensible threshold behind it (4.5:1 for body
 * text). The renderer uses it two ways:
 *
 *   1. `sampleBackdrop` reads the pixels the card is about to cover, so
 *      the panel can be exactly as opaque as that photo requires and no
 *      more — airy over a plain wall, solid over a bright, busy street.
 *   2. `minPanelAlpha` solves for that opacity. When the backdrop cannot
 *      be read (a transparent overlay canvas, or a video whose scene
 *      moves), it is handed `ANY_BACKDROP` and solves for the worst case
 *      instead, which is the honest answer when the scene is unknown.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The darkest and brightest patches under the card. */
export interface Backdrop {
  darkest: Rgb;
  brightest: Rgb;
}

/** Stand-in for "the photo could be anything" — solves for worst case. */
export const ANY_BACKDROP: Backdrop = {
  darkest: { r: 0, g: 0, b: 0 },
  brightest: { r: 255, g: 255, b: 255 },
};

/** WCAG AA for body text. Small print gets no discount here: the ward and
 *  police rows are the smallest text on the card and the most load-bearing. */
export const AA = 4.5;

/**
 * What the solver actually aims for.
 *
 * Above AA on purpose. These ratios are computed from pure ink on a pure
 * plate, but nothing is painted that way: anti-aliasing blends the edge of
 * every glyph toward the plate, and at the size the ward and police rows
 * are set, a measurable slice of each stroke is edge. Cards solved to land
 * exactly on 4.5 measured 3.8–4.3 once rendered. The margin is what makes
 * the guarantee survive the rasteriser — scripts/check-contrast.mjs reads
 * painted pixels and holds it to AA.
 */
export const TARGET = 5.2;

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `fg` painted at `alpha` over `bg`. */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const a = Math.min(1, Math.max(0, alpha));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

const HEX = /^#([0-9a-f]{3,8})$/i;

/** Accepts the forms the palettes actually use: #rgb, #rrggbb, #rrggbbaa
 *  and rgb()/rgba(). Anything unrecognised comes back opaque black, which
 *  fails contrast loudly rather than silently passing. */
export function parseColor(css: string): { rgb: Rgb; a: number } {
  const s = css.trim();
  const hex = HEX.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return {
      rgb: { r: n(0), g: n(2), b: n(4) },
      a: h.length >= 8 ? n(6) / 255 : 1,
    };
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every((v) => Number.isFinite(v))) {
      return {
        rgb: { r: p[0], g: p[1], b: p[2] },
        a: p.length > 3 ? p[3] : 1,
      };
    }
  }
  return { rgb: { r: 0, g: 0, b: 0 }, a: 1 };
}

/** Worst contrast `ink` achieves on `panel` at `alpha`, over this backdrop. */
export function worstContrast(
  panel: Rgb,
  alpha: number,
  ink: string,
  bd: Backdrop
): number {
  const { rgb, a } = parseColor(ink);
  let worst = Infinity;
  for (const back of [bd.darkest, bd.brightest]) {
    const plate = composite(panel, alpha, back);
    // ink with its own alpha lands on the composited plate, not the panel
    const text = a >= 1 ? rgb : composite(rgb, a, plate);
    worst = Math.min(worst, contrastRatio(text, plate));
  }
  return worst;
}

/**
 * The least opaque this panel may be and still carry every one of `inks`
 * at `target` contrast over `bd`.
 *
 * Scanned rather than solved: contrast against a *composited* plate is not
 * guaranteed monotonic in alpha for an ink sitting between the panel and
 * the backdrop in luminance, and a scan cannot be fooled by that. 1 %
 * steps over at most 100 iterations is nothing next to drawing the card.
 *
 * `floor` is what the user asked for — their choice is honoured whenever
 * it is already legible, and only ever raised, never lowered.
 */
export function minPanelAlpha(
  panel: Rgb,
  inks: string[],
  bd: Backdrop,
  target = TARGET,
  floor = 0
): number {
  const start = Math.min(1, Math.max(0, floor));
  for (let a = start; a <= 1.0005; a += 0.01) {
    const alpha = Math.min(1, a);
    if (inks.every((ink) => worstContrast(panel, alpha, ink, bd) >= target)) {
      return alpha;
    }
  }
  return 1;
}

// --- reading the photo under the card ------------------------------------

const GRID_W = 24;
const GRID_H = 12;
let probe: HTMLCanvasElement | null = null;
let probeCtx: CanvasRenderingContext2D | null = null;

/**
 * Canvases already known to hold nothing readable.
 *
 * `getImageData` forces a GPU-to-CPU readback, and the live viewfinder
 * redraws its card every frame onto a canvas that is transparent by
 * design — so without this, every frame would pay for a reading that can
 * only ever come back null. That is exactly the kind of per-frame cost
 * that makes an older phone stutter.
 *
 * Safe because the canvases in question never change character: the
 * viewfinder overlay and the video burn-in layer are always transparent,
 * while a canvas holding a photo is opaque from the moment the frame is
 * drawn, which is before any card is laid out.
 */
const barren = new WeakSet<HTMLCanvasElement>();

/** Cell luminance at a percentile, so one blown highlight or one deep
 *  shadow cell does not drag the whole card to opaque. */
function pick(cells: { rgb: Rgb; lum: number }[], q: number): Rgb {
  const i = Math.min(cells.length - 1, Math.max(0, Math.round(q * (cells.length - 1))));
  return cells[i].rgb;
}

/**
 * Read what the card is about to cover.
 *
 * Returns null when there is nothing to read — a transparent overlay
 * canvas (the live viewfinder, the video burn-in layer) or a context that
 * refuses `getImageData`. Callers treat null as `ANY_BACKDROP`.
 *
 * `rect` is in the context's CURRENT drawing space; the active transform
 * is applied here, because the camera rotates the whole space to lay the
 * card out for a phone held sideways.
 */
export function sampleBackdrop(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number }
): Backdrop | null {
  const canvas = ctx.canvas;
  if (!canvas.width || !canvas.height) return null;
  if (barren.has(canvas)) return null;
  try {
    // corners through the transform, then the axis-aligned box they span
    let x0 = rect.x;
    let y0 = rect.y;
    let x1 = rect.x + rect.width;
    let y1 = rect.y + rect.height;
    const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
    if (m) {
      const pts = [
        [rect.x, rect.y],
        [rect.x + rect.width, rect.y],
        [rect.x, rect.y + rect.height],
        [rect.x + rect.width, rect.y + rect.height],
      ].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
      x0 = Math.min(...pts.map((p) => p.x));
      y0 = Math.min(...pts.map((p) => p.y));
      x1 = Math.max(...pts.map((p) => p.x));
      y1 = Math.max(...pts.map((p) => p.y));
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(canvas.width, Math.ceil(x1));
    y1 = Math.min(canvas.height, Math.ceil(y1));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return null;

    if (!probe || !probeCtx) {
      probe = document.createElement("canvas");
      probe.width = GRID_W;
      probe.height = GRID_H;
      probeCtx = probe.getContext("2d", { willReadFrequently: true });
      if (!probeCtx) return null;
    }
    // the downscale averages, so a single specular pixel cannot decide the
    // opacity of the whole card
    probeCtx.clearRect(0, 0, GRID_W, GRID_H);
    probeCtx.imageSmoothingEnabled = true;
    probeCtx.imageSmoothingQuality = "high";
    probeCtx.drawImage(canvas, x0, y0, w, h, 0, 0, GRID_W, GRID_H);
    const { data } = probeCtx.getImageData(0, 0, GRID_W, GRID_H);

    const cells: { rgb: Rgb; lum: number }[] = [];
    let alphaSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      alphaSum += data[i + 3];
      const rgb = { r: data[i], g: data[i + 1], b: data[i + 2] };
      cells.push({ rgb, lum: relativeLuminance(rgb) });
    }
    // A see-through region tells us nothing about what will end up behind
    // the card, so refuse to guess: the caller falls back to worst case.
    if (alphaSum / cells.length < 250) {
      barren.add(canvas);
      return null;
    }

    cells.sort((a, b) => a.lum - b.lum);
    return { darkest: pick(cells, 0.02), brightest: pick(cells, 0.98) };
  } catch {
    barren.add(canvas); // tainted, or getImageData blocked — never retry
    return null;
  }
}
