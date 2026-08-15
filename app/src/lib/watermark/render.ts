/**
 * The single watermark renderer (§5.3).
 *
 * One implementation drives all three surfaces — the live viewfinder
 * overlay, the full-resolution capture composite, and the settings
 * preview — so what you see is exactly what gets burned.
 *
 * Everything scales from the target canvas width, so the same code
 * paints a 360 px preview and a 4000 px photo identically.
 */
import type {
  Profile,
  WatermarkConfig,
  WatermarkData,
} from "../../types";
import {
  fmtAltAccuracy,
  fmtBearing,
  fmtCoordsLine,
  fmtDateLine,
  fmtWard,
  fmtZone,
} from "../geo/format";
import { renderSocialStrip } from "./socialStrip";
import { latLngToDigipin } from "../geo/digipin";
import { localStation } from "../geo/local-names";
import { stringsFor, fontFor, type CardStrings } from "./signboard";
import { renderChennaiSign, signAuthority } from "./chennaiSign";
import {
  ANY_BACKDROP,
  minPanelAlpha,
  relativeLuminance,
  sampleBackdrop,
  type Backdrop,
  type Rgb,
} from "./contrast";

export interface WatermarkAssets {
  miniMap?: CanvasImageSource | null;
  /** location QR, drawn in the same right-hand column as the map */
  qr?: CanvasImageSource | null;
  /** Chennai street-sign emblems. Passed in like every other image the
   *  renderer draws, rather than read from a module singleton — the
   *  renderer must stay a pure function of (data, config, assets). */
  gccEmblem?: CanvasImageSource | null;
  singaraLogo?: CanvasImageSource | null;
  /** roundel for whichever city corporation covers this spot */
  corpLogo?: CanvasImageSource | null;
  /** true only when the thumb is genuine Google imagery (§5.4 attribution) */
  miniMapIsGoogle?: boolean;
  profilePhoto?: CanvasImageSource | null;
}

/** Where the panel was painted, in canvas pixels — lets the live
 *  viewfinder anchor UI (e.g. the edit button) to the card. */
export interface WatermarkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a row is FOR, not what colour it is. The palette is chosen after
 *  the card has been measured and the photo beneath it read, so rows
 *  cannot carry a colour with them. */
type Role = "text" | "dim" | "accent" | "warn";

interface Line {
  text: string;
  font: string;
  role: Role;
  gapBefore?: number;
}

interface Theme {
  /** panel base, opaque — the alpha is solved for, not chosen */
  panelRgb: Rgb;
  text: string;
  dim: string;
  accent: string;
  /** mock-location disclosure; amber reads on a dark panel and vanishes
   *  on a light one, so it is per-theme like everything else */
  warn: string;
  /** hairline edge, so a card tuned to blend into its photo still reads
   *  as a card rather than a smudge */
  edge: string;
}

/**
 * Palettes picked by contrast arithmetic, not by eye (see contrast.ts).
 *
 * Every ink here clears 4.5:1 against its own panel over ANY photo once
 * the panel reaches the opacity `minPanelAlpha` works out — roughly 0.70
 * worst-case, far less when the photo underneath is actually measured.
 *
 * The previous palette did not: light/accent — the ward, zone and police
 * rows, the most load-bearing text on a civic complaint — sat at 1.77:1
 * over a dark scene, which is why they photographed as faint blue ghosts.
 */
const THEMES: Record<Exclude<WatermarkConfig["theme"], "auto">, Theme> = {
  dark: {
    panelRgb: { r: 10, g: 14, b: 20 },
    text: "#ffffff",
    dim: "#e8eef6",
    accent: "#8fd7ff",
    warn: "#ffd54a",
    edge: "rgba(255,255,255,0.28)",
  },
  light: {
    panelRgb: { r: 255, g: 255, b: 255 },
    text: "#0b0f14",
    dim: "#2b333c",
    accent: "#0a4a70",
    warn: "#8a5200",
    edge: "rgba(11,15,20,0.22)",
  },
  brand: {
    panelRgb: { r: 30, g: 27, b: 75 },
    text: "#ffffff",
    dim: "#e5eaff",
    accent: "#b9c6ff",
    warn: "#ffd54a",
    edge: "rgba(229,234,255,0.30)",
  },
};

const inksOf = (t: Theme): string[] => [t.text, t.dim, t.accent, t.warn];

const rgbaOf = (c: Rgb, a: number): string =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;

/**
 * Resolve the palette and the panel opacity together.
 *
 * "auto" picks whichever palette needs the LEAST opacity to stay legible
 * over this particular photo — a light card on a bright street, a dark one
 * at night — so the card covers as little of the evidence as it can while
 * still being readable. With no backdrop to read (the live viewfinder, a
 * video whose scene moves) it solves for the worst case instead, which is
 * the only honest answer when the photo is unknown.
 */
function resolveStyle(
  config: WatermarkConfig,
  bd: Backdrop | null
): { theme: Theme; alpha: number } {
  const backdrop = bd ?? ANY_BACKDROP;
  const solve = (t: Theme) => ({
    theme: t,
    alpha: minPanelAlpha(t.panelRgb, inksOf(t), backdrop, undefined, config.opacity),
  });
  if (config.theme !== "auto") return solve(THEMES[config.theme]);
  if (!bd) return solve(THEMES.dark);
  const options = [THEMES.dark, THEMES.light].map(solve);
  // ties go to whichever palette sits further from the scene's own
  // brightness, so the card does not melt into it
  const mid =
    (relativeLuminance(bd.darkest) + relativeLuminance(bd.brightest)) / 2;
  options.sort(
    (a, b) =>
      a.alpha - b.alpha ||
      Math.abs(relativeLuminance(b.theme.panelRgb) - mid) -
        Math.abs(relativeLuminance(a.theme.panelRgb) - mid)
  );
  return options[0];
}

/**
 * Beyond this, a fix cannot be trusted to name a ward, and the card says
 * so. Matches ATTRIBUTABLE_M in location.ts, which is what decides
 * whether the viewfinder badge goes green.
 */
const APPROX_FIX_M = 100;

const FONT_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  font: string,
  maxWidth: number,
  maxLines: number
): string[] {
  ctx.font = font;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const attempt = current ? `${current} ${w}` : w;
    if (ctx.measureText(attempt).width <= maxWidth || !current) {
      current = attempt;
    } else if (lines.length < maxLines - 1) {
      lines.push(current);
      current = w;
    } else {
      // final allowed line — keep collecting; overflow is ellipsized below
      current = attempt;
    }
  }
  if (current) lines.push(current);
  let last = lines[lines.length - 1];
  if (last && ctx.measureText(last).width > maxWidth) {
    last += "…";
    while (ctx.measureText(last).width > maxWidth && last.length > 2) {
      last = last.slice(0, -2) + "…";
    }
    lines[lines.length - 1] = last;
  }
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Build the stacked text rows for the current data + toggles. */
function buildLines(
  ctx: CanvasRenderingContext2D,
  data: WatermarkData,
  config: WatermarkConfig,
  bodyPx: number,
  maxWidth: number,
  _detailed: boolean,
  t: CardStrings,
  signShown: boolean
): Line[] {
  const f = config.fields;
  const j = data.jurisdiction;
  const lines: Line[] = [];
  // the card follows the chosen language, so it needs that script's stack
  const stack = fontFor(config.language);
  const body = `${bodyPx}px ${stack}`;
  const bold = `600 ${Math.round(bodyPx * 1.15)}px ${stack}`;
  const small = `${Math.round(bodyPx * 0.9)}px ${stack}`;

  if (f.titleLine) {
    // City-level only — no state/country/flag. `locality` arrives
    // display-ready from the geocoder ("Kodambakkam, Chennai"); offline
    // fall back to the matched jurisdiction's city (legacy photos carry
    // scope names instead of a city field).
    const legacyCity =
      j?.scope === "gcc"
        ? "Chennai"
        : j?.scope === "tambaram"
          ? "Tambaram"
          : j?.scope === "avadi"
            ? "Avadi"
            : undefined;
    const title = data.locality ?? j?.city ?? legacyCity;
    if (title) lines.push({ text: title, font: bold, role: "text" });
  }

  if (f.address && data.address) {
    // A single long address must not balloon the shrink-wrapped card far
    // wider than every other row (ugly on landscape shots): cap its wrap
    // width near the widest standard line (a full date row), so long
    // addresses wrap earlier and still ellipsize at their line cap.
    ctx.font = body;
    const addrCap = Math.min(
      maxWidth,
      Math.max(
        ctx.measureText("Sunday, 00 September 2026 00:00:00 PM UTC+00:00")
          .width,
        maxWidth * 0.5
      )
    );
    // up to 2 lines at the capped width, then ellipsize (wrapText trims
    // the last line with "…" when it still overflows)
    for (const seg of wrapText(ctx, data.address, body, addrCap, 2)) {
      lines.push({ text: seg, font: body, role: "dim" });
    }
  }

  if (f.coords) {
    lines.push({
      text: data.fix
        ? fmtCoordsLine(data.fix.lat, data.fix.lng, config.language)
        : t.acquiring,
      font: body,
      role: "dim",
    });
  }

  if (f.digipin && data.fix) {
    const code =
      data.digipin ?? latLngToDigipin(data.fix.lat, data.fix.lng);
    if (code) {
      lines.push({ text: `${t.digipin}: ${code}`, font: body, role: "dim" });
    }
  }

  if (f.altitudeAccuracy && data.fix) {
    const t = fmtAltAccuracy(data.fix.altitude, data.fix.accuracy, config.language);
    if (t) lines.push({ text: t, font: small, role: "dim" });
  }

  if (f.datetime) {
    lines.push({
      text: fmtDateLine(data.timestamp, data.tzOffsetMinutes, config.language),
      font: body,
      role: "dim",
    });
  }

  if (f.compass && data.bearing != null) {
    lines.push({
      text: `${t.facing} ${fmtBearing(data.bearing)}`,
      font: small,
      role: "dim",
    });
  }

  if (f.soundLevel && (data.dbStats || data.db != null)) {
    // session statistics: average since the app opened, with the range
    const s = data.dbStats;
    lines.push({
      text: s
        ? `${t.noise}: ${t.avg} ${s.avg} dB · ${t.min} ${s.min} dB · ${t.max} ${s.max} dB`
        : `${t.noise}: ${Math.round(data.db!)} dB`,
      font: small,
      role: "dim",
    });
  }

  // ---- jurisdiction rows (honesty rules baked in) -------------------
  // Layout: corporation on its own line; "Zone · Ward" together on the
  // next; police as one line, clubbing L&O + Traffic when they are the
  // same station.
  if (j && j.scope !== "out") {
    // declared before the ward/zone rows below use it — the police block
    // further down is not the first caller
    const tr = (v: string | undefined) => localStation(config.language, v);
    const wardPending = j.wardPending || j.scope === "avadi";
    let firstJurLine = true;
    const pushJur = (text: string, wrapMax = 2) => {
      wrapText(ctx, text, body, maxWidth, wrapMax).forEach((seg) => {
        lines.push({
          text: seg,
          font: body,
          role: "accent",
          gapBefore: firstJurLine ? 0.35 : undefined,
        });
        firstJurLine = false;
      });
    };

    // the street-sign tab already names the corporation in two scripts —
    // repeating it in the body is just clutter on a card that fights for
    // every line
    if ((f.ward || f.zone) && j.corporation && !signShown) {
      pushJur(j.corporation);
    }
    if (wardPending && f.ward) {
      pushJur(t.wardPending);
    } else {
      const zw: string[] = [];
      if (f.zone && j.zone) zw.push(fmtZone(j.zone, config.language));
      if (f.ward && j.ward)
        zw.push(`${t.ward} ${fmtWard(j.ward)}${j.wardName ? ` (${j.wardName})` : ""}`);
      if (zw.length) pushJur(zw.join(" · "));
      // village panchayats & cantonments: no ward/zone — their locating
      // line is "Block · District" (or the cantonment's board name),
      // occupying the same slot in the same style
      if (!zw.length && (f.ward || f.zone) && (j.block || j.district)) {
        const bd: string[] = [];
        if (j.block) bd.push(`${j.block} ${t.block}`);
        if (j.district) {
          bd.push(/board$/i.test(j.district) ? j.district : `${j.district} ${t.district}`);
        }
        pushJur(bd.join(" · "));
      }
    }

    const lo = tr(f.loStation ? j.loStation : undefined);
    const traffic = tr(f.trafficStation ? j.trafficStation : undefined);
    if (lo && traffic) {
      if (lo === traffic) pushJur(`${t.policeBoth}: ${lo}`);
      else pushJur(`${t.policeLo} – ${lo} · ${t.traffic} – ${traffic}`, 3);
    } else if (lo) {
      pushJur(`${t.policeLo}: ${lo}`);
    } else if (traffic) {
      pushJur(`${t.traffic}: ${traffic}`);
    }
  }

  /**
   * Accuracy disclosure — shown whenever the fix is too coarse to place
   * the point inside a ward, whatever fields are enabled.
   *
   * The ward, zone and police rows above are computed from the fix by our
   * own polygons, so they are only ever as right as it is. A network or
   * cell-tower fix half a kilometre wide lands in the next ward and names
   * the next station, and every row still agrees with every other row —
   * there is nothing in the card itself to give it away. This row is the
   * only thing that can.
   */
  if (data.fix?.accuracy != null && data.fix.accuracy > APPROX_FIX_M) {
    lines.push({
      text: `${t.approx} (±${Math.round(data.fix.accuracy)} m)`,
      font: `600 ${Math.round(bodyPx * 0.92)}px ${stack}`,
      role: "warn",
      gapBefore: 0.35,
    });
  }

  // Mock-location disclosure — always shown when detected, regardless of
  // which fields are enabled: a spoofed capture must not look genuine.
  // Amber, in the same style as the jurisdiction rows.
  if (data.mockLocation) {
    lines.push({
      text: t.mock,
      font: `600 ${Math.round(bodyPx * 0.92)}px ${FONT_STACK}`,
      role: "warn",
      gapBefore: 0.35,
    });
  }

  if (f.customLabel && config.customLabelText.trim()) {
    lines.push({
      text: config.customLabelText.trim(),
      font: `italic ${body}`,
      role: "text",
      gapBefore: 0.35,
    });
  }

  // social handles render as separate vertical logo towers up the photo's
  // right edge (socialStrip.ts), side by side, not as card text lines

  return lines;
}

/**
 * Paint the watermark onto `ctx`. The canvas is assumed to already hold
 * the photo/video frame. Coordinates cover the full canvas size.
 * Returns the painted panel's rect (canvas px), or null if nothing drew.
 */
/** Vertical anchor for a card position value. */
export function positionIsTop(p: WatermarkConfig["position"]): boolean {
  return p.startsWith("top");
}

/** Horizontal anchor: corners pin to their side; the centre values centre
 *  the shrink-wrapped card in BOTH orientations — as content grows the
 *  card fills toward both sides evenly, like the old full-width look. */
function panelXFor(
  p: WatermarkConfig["position"],
  width: number,
  panelW: number,
  margin: number
): number {
  if (p.endsWith("left")) return margin;
  if (p.endsWith("right")) return width - margin - panelW;
  return Math.max(margin, Math.round((width - panelW) / 2));
}

export function renderWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WatermarkData,
  config: WatermarkConfig,
  profile: Profile,
  assets: WatermarkAssets = {},
  /** Drawing the on-screen preview rather than a file. The QR's absolute
   *  scannability floor is skipped, because nothing scans a viewfinder —
   *  and applying it made the preview QR far bigger than the saved one.
   *  Canvas size cannot stand in for this: a phone's overlay is around
   *  1080 px wide, the same order as a small capture. */
  opts: { preview?: boolean } = {}
): WatermarkRect | null {
  // scale from the SHORT side so a landscape shot gets the same absolute
  // card size as a portrait one (a width-based scale ballooned the card
  // across landscape photos and buried the subject)
  const base = Math.min(width, height);
  const landscape = width > height;
  const s = (base / 1080) * config.fontScale;
  const preset = config.preset;

  const finish = (panel: WatermarkRect | null): WatermarkRect | null => {
    if (config.fields.socialHandles || config.fields.profilePhoto) {
      renderSocialStrip(
        ctx,
        width,
        height,
        s,
        profile,
        config.fields.socialHandles,
        config.fields.profilePhoto,
        assets.profilePhoto,
        panel,
        config.position
      );
    }
    return panel;
  };

  if (preset === "minimal") {
    return finish(renderMinimal(ctx, width, height, data, config, s));
  }

  // The Chennai template IS the detailed card, wearing a street-sign tab.
  // Keeping one layout means every field toggle, the map, the QR and the
  // width rules keep working identically under it — nothing forked.
  const detailed = preset === "detailed" || preset === "chennai";
  const t = stringsFor(ctx, config.language);
  // The Chennai template is a whole plate, not a header on the normal
  // card — it carries its own place name, data rows and ward strip.
  // any resolved local body, not only GCC — the board names whoever
  // actually covers the spot
  const signOn = preset === "chennai" && signAuthority(data) !== null;
  const margin = Math.round(base * 0.025);
  const pad = Math.round(18 * s);
  // landscape: compact card (portrait-like width) instead of a full-bleed
  // strip across the wide edge that hides the photo's subject
  const panelW = landscape
    ? Math.min(width - margin * 2, Math.round(height * 1.25))
    : width - margin * 2;
  if (signOn) {
    // measure first: the plate shrink-wraps to its content, so its width
    // is not known until the rows have been built
    // The measure pass must see EXACTLY what the draw pass will draw. It
    // was passed a null QR while the draw pass got the real one, so the
    // plate was positioned using a height that did not include the code
    // and hung past the bottom margin.
    const signQr = config.fields.qrCode ? (assets.qr ?? null) : null;
    const m = renderChennaiSign(
      ctx, 0, 0, panelW, s, data, config, signQr,
      assets.gccEmblem ?? null,
      assets.singaraLogo ?? null,
      assets.corpLogo ?? null,
      !!opts.preview,
      true
    );
    const signW = m.width;
    const sx = panelXFor(config.position, width, signW, margin);
    const sy = positionIsTop(config.position)
      ? margin
      : height - margin - m.height;
    // now that the plate's rect is known, read the photo it will cover so
    // the sign can be exactly as opaque as this scene demands
    const signBackdrop = sampleBackdrop(ctx, {
      x: sx, y: sy, width: signW, height: m.height,
    });
    // pass the same AVAILABLE width both times — handing the draw pass
    // the shrunken width would make it re-shrink against a smaller budget
    // and lay out differently from what was measured
    renderChennaiSign(
      ctx, sx, sy, panelW, s, data, config, signQr,
      assets.gccEmblem ?? null,
      assets.singaraLogo ?? null,
      assets.corpLogo ?? null,
      !!opts.preview,
      false,
      signBackdrop
    );
    return finish({ x: sx, y: sy, width: signW, height: m.height });
  }

  const bodyPx = Math.max(10, Math.round((detailed ? 26 : 24) * s));
  const lineGap = Math.round(bodyPx * 0.45);

  const mapSize = detailed && config.fields.miniMap && assets.miniMap
    ? Math.round(Math.min(220 * s, panelW * 0.3))
    : 0;
  // The QR shares the map's column. With the map off it takes the column
  // on its own, so turning the map off widens nothing and turning the QR
  // off gives the text its full width back — the layout adjusts itself.
  const qrSize = config.fields.qrCode && assets.qr
    ? Math.round(Math.min(200 * s, panelW * 0.28))
    : 0;
  const colW = Math.max(mapSize, qrSize);
  const mapGap = colW ? pad : 0;
  // Height the right-hand column needs. With BOTH the map and the QR on,
  // the QR sits under the map, and that stack was not counted in the
  // panel height — so the code hung out below the card. The column is
  // now measured before the panel is sized.
  const colH = mapSize && qrSize ? mapSize + pad + qrSize : Math.max(mapSize, qrSize);
  const textW = panelW - pad * 2 - colW - mapGap;

  const lines = buildLines(
    ctx, data, config, bodyPx, textW, detailed, t, false
  );
  if (!lines.length && !mapSize) return finish(null);

  // ---- measure ------------------------------------------------------
  let textH = 0;
  let maxLineW = 0;
  for (const ln of lines) {
    ctx.font = ln.font;
    const m = ctx.measureText("Mg");
    const lh =
      (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || bodyPx) +
      lineGap;
    textH += lh + (ln.gapBefore ? ln.gapBefore * bodyPx : 0);
    maxLineW = Math.max(maxLineW, ctx.measureText(ln.text).width);
  }

  // Shrink-wrap the card to its content: panelW above is only the WRAP
  // limit — the painted card hugs the longest actual line, so it covers
  // as little of the photo as the enabled fields allow (no dead space).
  const usedTextW = lines.length ? Math.min(textW, Math.ceil(maxLineW)) : 0;
  // colW, NOT mapSize: with the mini-map off and the QR on, the column is
  // still occupied. Measuring from mapSize made the card too narrow and
  // started the text at the column's left edge — straight over the QR.
  const fitW = pad * 2 + colW + mapGap + usedTextW;

  // Branding-free card: no app badge, just the clean address panel.
  const contentH = Math.max(textH, colH);
  const panelH = pad * 2 + contentH;
  const panelX = panelXFor(config.position, width, fitW, margin);
  // the tab is drawn upward from the card's top edge, so a top-anchored
  // card moves down by the tab's height to keep the whole thing on-photo
  const panelY = positionIsTop(config.position)
    ? margin
    : height - margin - panelH;

  // ---- palette + opacity ---------------------------------------------
  // Only now is the card's rect known, so only now can the photo beneath
  // it be read. The chosen opacity is the LEAST that keeps every ink at
  // 4.5:1 over this scene, never below what the user asked for.
  const { theme, alpha } = resolveStyle(
    config,
    sampleBackdrop(ctx, { x: panelX, y: panelY, width: fitW, height: panelH })
  );
  const colorFor = (role: Role): string => theme[role];

  // ---- panel ---------------------------------------------------------
  ctx.save();
  const radius = Math.round(16 * s);
  roundRect(ctx, panelX, panelY, fitW, panelH, radius);
  ctx.fillStyle = rgbaOf(theme.panelRgb, alpha);
  ctx.fill();
  // a hairline so the card still reads as a card when its palette is
  // close to the scene behind it
  ctx.strokeStyle = theme.edge;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * s));
  ctx.stroke();

  // ---- right column: mini-map and/or QR ---------------------------------
  const contentY = panelY + pad;
  if (mapSize && assets.miniMap) {
    const mx = panelX + pad;
    // stretch with the card: when the text stack is taller than the
    // square map, the map grows vertically to fill (cover-cropped from
    // the square source so nothing distorts), capped at ~2.4× so a very
    // long card doesn't produce a sliver-thin map view
    const mapH = qrSize
      ? mapSize // square: the QR below it owns the rest of the column
      : Math.round(Math.min(Math.max(contentH, mapSize), mapSize * 2.4));
    const my = contentY + (contentH - (qrSize ? colH : mapH)) / 2;
    ctx.save();
    roundRect(ctx, mx, my, mapSize, mapH, Math.round(10 * s));
    ctx.clip();
    const src = assets.miniMap;
    const srcW = (src as HTMLCanvasElement).width ?? mapSize;
    const srcH = (src as HTMLCanvasElement).height ?? mapSize;
    // cover-crop: keep the aspect of the destination
    const destRatio = mapSize / mapH;
    let cw = srcW;
    let chh = srcH;
    if (srcW / srcH > destRatio) cw = srcH * destRatio;
    else chh = srcW / destRatio;
    ctx.drawImage(
      src,
      (srcW - cw) / 2,
      (srcH - chh) / 2,
      cw,
      chh,
      mx,
      my,
      mapSize,
      mapH
    );
    // Attribution only for genuine Google imagery (§5.4)
    if (assets.miniMapIsGoogle) {
      ctx.font = `600 ${Math.round(bodyPx * 0.55)}px ${FONT_STACK}`;
      // sits on map imagery, not on the panel, so it carries its own
      // shadow rather than relying on the card's contrast guarantee
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = Math.max(1, Math.round(2 * s));
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "bottom";
      ctx.fillText("Google", mx + 6 * s, my + mapH - 4 * s);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // ---- location QR -------------------------------------------------------
  // Shares the column with the map: stacked underneath when both are on,
  // centred on its own when the map is off. White plate behind it so it
  // stays scannable whatever the card theme is.
  if (qrSize && assets.qr) {
    const qx = panelX + pad + Math.round((colW - qrSize) / 2);
    const qy = mapSize
      ? contentY + Math.round((contentH - colH) / 2) + mapSize + pad
      : contentY + Math.max(0, Math.round((contentH - qrSize) / 2));
    ctx.save();
    roundRect(ctx, qx, qy, qrSize, qrSize, Math.round(6 * s));
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    const inset = Math.round(qrSize * 0.06);
    ctx.drawImage(
      assets.qr,
      qx + inset,
      qy + inset,
      qrSize - inset * 2,
      qrSize - inset * 2
    );
    ctx.restore();
  }

  // ---- text lines ----------------------------------------------------------
  const tx = panelX + pad + colW + mapGap;
  let ty = contentY + (contentH - textH) / 2;
  ctx.textBaseline = "top";
  for (const ln of lines) {
    if (ln.gapBefore) ty += ln.gapBefore * bodyPx;
    ctx.font = ln.font;
    const m = ctx.measureText("Mg");
    const asc = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || bodyPx;
    ctx.fillStyle = colorFor(ln.role);
    ctx.fillText(ln.text, tx, ty);
    ty += asc + lineGap;
  }
  ctx.restore();
  return finish({ x: panelX, y: panelY, width: fitW, height: panelH });
}

function renderMinimal(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WatermarkData,
  config: WatermarkConfig,
  s: number
): WatermarkRect | null {
  const bodyPx = Math.max(9, Math.round(22 * s));
  const pad = Math.round(12 * s);
  const margin = Math.round(Math.min(width, height) * 0.025);
  const rows: string[] = [];
  if (config.fields.coords) {
    rows.push(
      data.fix ? fmtCoordsLine(data.fix.lat, data.fix.lng, config.language) : "GPS: acquiring…"
    );
  }
  if (config.fields.datetime) {
    rows.push(fmtDateLine(data.timestamp, data.tzOffsetMinutes, config.language));
  }
  if (config.fields.soundLevel && data.db != null) {
    rows.push(`Noise ≈ ${Math.round(data.db)} dB`);
  }
  const j = data.jurisdiction;
  if (
    config.fields.ward &&
    j &&
    j.scope !== "out" &&
    j.ward &&
    !j.wardPending &&
    j.corporation
  ) {
    rows.push(`${j.corporation} · Ward ${fmtWard(j.ward)}`);
  }
  if (!rows.length) return null;

  ctx.font = `${bodyPx}px ${FONT_STACK}`;
  let w = 0;
  for (const r of rows) w = Math.max(w, ctx.measureText(r).width);
  const lineH = Math.round(bodyPx * 1.35);
  const panelW = w + pad * 2;
  const panelH = rows.length * lineH + pad * 2 - (lineH - bodyPx);
  // the minimal chip honours corners in any orientation; centre centres
  const x = panelXFor(config.position, width, panelW, margin);
  const y = positionIsTop(config.position)
    ? margin
    : height - margin - panelH;

  // the badge is small and sits over unknown photo, so it gets the same
  // measured treatment as the full card
  const { theme, alpha } = resolveStyle(
    config,
    sampleBackdrop(ctx, { x, y, width: panelW, height: panelH })
  );

  ctx.save();
  roundRect(ctx, x, y, panelW, panelH, Math.round(10 * s));
  ctx.fillStyle = rgbaOf(theme.panelRgb, alpha);
  ctx.fill();
  ctx.strokeStyle = theme.edge;
  ctx.lineWidth = Math.max(1, Math.round(1.5 * s));
  ctx.stroke();
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.text;
  rows.forEach((r, i) => {
    ctx.fillText(r, x + pad, y + pad + i * lineH);
  });
  ctx.restore();
  return { x, y, width: panelW, height: panelH };
}
