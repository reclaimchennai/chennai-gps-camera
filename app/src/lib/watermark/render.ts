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

export interface WatermarkAssets {
  miniMap?: CanvasImageSource | null;
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

interface Line {
  text: string;
  font: string;
  color: string;
  gapBefore?: number;
}

interface Theme {
  panel: (opacity: number) => string;
  text: string;
  dim: string;
  accent: string;
}

const THEMES: Record<WatermarkConfig["theme"], Theme> = {
  dark: {
    panel: (o) => `rgba(10, 14, 20, ${o})`,
    text: "#ffffff",
    dim: "rgba(255,255,255,0.82)",
    accent: "#7dd3fc",
  },
  light: {
    panel: (o) => `rgba(255, 255, 255, ${o})`,
    text: "#101418",
    dim: "rgba(16,20,24,0.8)",
    accent: "#0369a1",
  },
  brand: {
    panel: (o) => `rgba(30, 27, 75, ${o})`,
    text: "#ffffff",
    dim: "rgba(224,231,255,0.85)",
    accent: "#a5b4fc",
  },
};

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
  theme: Theme,
  bodyPx: number,
  maxWidth: number,
  detailed: boolean
): Line[] {
  const f = config.fields;
  const j = data.jurisdiction;
  const lines: Line[] = [];
  const body = `${bodyPx}px ${FONT_STACK}`;
  const bold = `600 ${Math.round(bodyPx * 1.15)}px ${FONT_STACK}`;
  const small = `${Math.round(bodyPx * 0.9)}px ${FONT_STACK}`;

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
    if (title) lines.push({ text: title, font: bold, color: theme.text });
  }

  if (f.address && data.address) {
    for (const seg of wrapText(ctx, data.address, body, maxWidth, detailed ? 3 : 1)) {
      lines.push({ text: seg, font: body, color: theme.dim });
    }
  }

  if (f.coords) {
    lines.push({
      text: data.fix
        ? fmtCoordsLine(data.fix.lat, data.fix.lng)
        : "GPS: acquiring…",
      font: body,
      color: theme.dim,
    });
  }

  if (f.digipin && data.fix) {
    const code =
      data.digipin ?? latLngToDigipin(data.fix.lat, data.fix.lng);
    if (code) {
      lines.push({ text: `DIGIPIN: ${code}`, font: body, color: theme.dim });
    }
  }

  if (f.altitudeAccuracy && data.fix) {
    const t = fmtAltAccuracy(data.fix.altitude, data.fix.accuracy);
    if (t) lines.push({ text: t, font: small, color: theme.dim });
  }

  if (f.datetime) {
    lines.push({
      text: fmtDateLine(data.timestamp, data.tzOffsetMinutes),
      font: body,
      color: theme.dim,
    });
  }

  if (f.compass && data.bearing != null) {
    lines.push({
      text: `Facing ${fmtBearing(data.bearing)}`,
      font: small,
      color: theme.dim,
    });
  }

  // ---- jurisdiction rows (honesty rules baked in) -------------------
  if (j && j.scope !== "out") {
    const wardPending = j.wardPending || j.scope === "avadi";
    const corpParts: string[] = [];
    if ((f.ward || f.zone) && j.corporation) corpParts.push(j.corporation);
    if (f.ward) {
      if (wardPending) corpParts.push("Ward: not yet available");
      else if (j.ward)
        corpParts.push(
          `Ward ${fmtWard(j.ward)}${j.wardName ? ` (${j.wardName})` : ""}`
        );
    }
    if (f.zone && j.zone && !wardPending) corpParts.push(fmtZone(j.zone));
    if (corpParts.length) {
      wrapText(ctx, corpParts.join(" · "), body, maxWidth, 2).forEach(
        (seg, i) => {
          lines.push({
            text: seg,
            font: body,
            color: theme.accent,
            gapBefore: i === 0 ? 0.35 : undefined,
          });
        }
      );
    }
    if (f.loStation && j.loStation) {
      for (const seg of wrapText(ctx, `Police (L&O): ${j.loStation}`, body, maxWidth, 2)) {
        lines.push({ text: seg, font: body, color: theme.accent });
      }
    }
    if (f.trafficStation && j.trafficStation) {
      for (const seg of wrapText(ctx, `Traffic: ${j.trafficStation}`, body, maxWidth, 2)) {
        lines.push({ text: seg, font: body, color: theme.accent });
      }
    }
  }

  if (f.customLabel && config.customLabelText.trim()) {
    lines.push({
      text: config.customLabelText.trim(),
      font: `italic ${body}`,
      color: theme.text,
      gapBefore: 0.35,
    });
  }

  // social handles render as a separate vertical logo strip on the
  // photo's right edge (socialStrip.ts), not as card text lines

  return lines;
}

/**
 * Paint the watermark onto `ctx`. The canvas is assumed to already hold
 * the photo/video frame. Coordinates cover the full canvas size.
 * Returns the painted panel's rect (canvas px), or null if nothing drew.
 */
export function renderWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WatermarkData,
  config: WatermarkConfig,
  profile: Profile,
  assets: WatermarkAssets = {}
): WatermarkRect | null {
  const theme = THEMES[config.theme];
  const s = (width / 1080) * config.fontScale;
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
    return finish(renderMinimal(ctx, width, height, data, config, theme, s));
  }

  const detailed = preset === "detailed";
  const margin = Math.round(width * 0.025);
  const pad = Math.round(18 * s);
  const panelW = width - margin * 2;
  const bodyPx = Math.max(10, Math.round((detailed ? 26 : 24) * s));
  const lineGap = Math.round(bodyPx * 0.45);

  const mapSize = detailed && config.fields.miniMap && assets.miniMap
    ? Math.round(Math.min(220 * s, panelW * 0.3))
    : 0;
  const mapGap = mapSize ? pad : 0;
  const textW = panelW - pad * 2 - mapSize - mapGap;

  const lines = buildLines(
    ctx, data, config, theme, bodyPx, textW, detailed
  );
  if (!lines.length && !mapSize) return finish(null);

  // ---- measure ------------------------------------------------------
  let textH = 0;
  for (const ln of lines) {
    ctx.font = ln.font;
    const m = ctx.measureText("Mg");
    const lh =
      (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || bodyPx) +
      lineGap;
    textH += lh + (ln.gapBefore ? ln.gapBefore * bodyPx : 0);
  }

  // Branding-free card: no app badge, just the clean address panel.
  const contentH = Math.max(textH, mapSize);
  const panelH = pad * 2 + contentH;
  const panelX = margin;
  const panelY =
    config.position === "top" ? margin : height - margin - panelH;

  // ---- panel ---------------------------------------------------------
  ctx.save();
  roundRect(ctx, panelX, panelY, panelW, panelH, Math.round(16 * s));
  ctx.fillStyle = theme.panel(config.opacity);
  ctx.fill();

  // ---- mini-map ---------------------------------------------------------
  const contentY = panelY + pad;
  if (mapSize && assets.miniMap) {
    const mx = panelX + pad;
    const my = contentY + (contentH - mapSize) / 2;
    ctx.save();
    roundRect(ctx, mx, my, mapSize, mapSize, Math.round(10 * s));
    ctx.clip();
    ctx.drawImage(assets.miniMap, mx, my, mapSize, mapSize);
    // Attribution only for genuine Google imagery (§5.4)
    if (assets.miniMapIsGoogle) {
      ctx.font = `600 ${Math.round(bodyPx * 0.55)}px ${FONT_STACK}`;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textBaseline = "bottom";
      ctx.fillText("Google", mx + 6 * s, my + mapSize - 4 * s);
    }
    ctx.restore();
  }

  // ---- text lines ----------------------------------------------------------
  const tx = panelX + pad + mapSize + mapGap;
  let ty = contentY + (contentH - textH) / 2;
  ctx.textBaseline = "top";
  for (const ln of lines) {
    if (ln.gapBefore) ty += ln.gapBefore * bodyPx;
    ctx.font = ln.font;
    const m = ctx.measureText("Mg");
    const asc = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || bodyPx;
    ctx.fillStyle = ln.color;
    ctx.fillText(ln.text, tx, ty);
    ty += asc + lineGap;
  }
  ctx.restore();
  return finish({ x: panelX, y: panelY, width: panelW, height: panelH });
}

function renderMinimal(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  data: WatermarkData,
  config: WatermarkConfig,
  theme: Theme,
  s: number
): WatermarkRect | null {
  const bodyPx = Math.max(9, Math.round(22 * s));
  const pad = Math.round(12 * s);
  const margin = Math.round(width * 0.025);
  const rows: string[] = [];
  if (config.fields.coords) {
    rows.push(
      data.fix ? fmtCoordsLine(data.fix.lat, data.fix.lng) : "GPS: acquiring…"
    );
  }
  if (config.fields.datetime) {
    rows.push(fmtDateLine(data.timestamp, data.tzOffsetMinutes));
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
  const x = margin;
  const y = config.position === "top" ? margin : height - margin - panelH;

  ctx.save();
  roundRect(ctx, x, y, panelW, panelH, Math.round(10 * s));
  ctx.fillStyle = theme.panel(config.opacity);
  ctx.fill();
  ctx.textBaseline = "top";
  ctx.fillStyle = theme.text;
  rows.forEach((r, i) => {
    ctx.fillText(r, x + pad, y + pad + i * lineH);
  });
  ctx.restore();
  return { x, y, width: panelW, height: panelH };
}
