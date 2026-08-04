/**
 * Before/after poster (§ gallery).
 *
 * Civic bodies answer complaints in a format that has become a genre of
 * its own: the grievance on the left, the fixed site on the right, both
 * dated, the body's crest in the corner and its handles along the top.
 * This draws that card from two photos the app already holds, so a
 * resident can post the result the same way the corporation would.
 *
 * Everything is measured from the canvas's short side, so the poster is
 * identical at preview size and at export size — the QR sizing bug taught
 * that a renderer which infers intent from canvas dimensions will get it
 * wrong on somebody's phone. Nothing here reads the DOM or the viewport.
 *
 * The output carries the USER's identity — their handles, their photo —
 * and never the app's. A poster that looked like it came from the
 * corporation would be a forgery, so there is no civic branding beyond
 * the crest of the body the photo was actually taken in, which is a fact
 * about the location rather than a claim about who is speaking.
 */
import { drawIcon, hasGlyph, type HandleGroup } from "./watermark/socialStrip";

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** One side of the poster. */
export interface PosterPhoto {
  img: CanvasImageSource;
  /** intrinsic pixel size, for the cover-fit crop */
  w: number;
  h: number;
  /** ribbon caption — "Before" / "After" */
  label: string;
  /** date ribbon text, already formatted */
  date: string;
  /** location line under the card */
  place: string;
}

export interface PosterOptions {
  headline: string;
  name: string;
  groups: HandleGroup[];
  profilePhoto?: CanvasImageSource | null;
  crest?: CanvasImageSource | null;
  before: PosterPhoto;
  after: PosterPhoto;
}

/** The two ribbon colours: a complaint, and a resolution. */
const BEFORE = "#9c1b2b";
const AFTER = "#1c6b41";
const INK = "#16202b";

/** Tilt, in degrees, so the pair reads as two prints dropped on a page. */
const TILT = 2.2;

/** Word-wrap to at most `maxLines`, ellipsizing the last. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !line) {
      line = next;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    if (ctx.measureText(last).width > maxW) {
      while (last && ctx.measureText(`${last}…`).width > maxW) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines;
}

/** Shrink a single line until it fits, never below `floor` of the ask. */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  weight: string,
  maxW: number,
  floor = 0.6
): number {
  let size = px;
  for (;;) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW || size <= px * floor) return size;
    size -= Math.max(1, px * 0.03);
  }
}

/** A ribbon: a rectangle with a notched tail, the way a banner folds. */
function ribbon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  notchLeft: boolean
): void {
  const n = h * 0.34;
  ctx.beginPath();
  if (notchLeft) {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + n, y + h / 2);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w - n, y + h / 2);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Draw an image cover-fit into a rect, centred. */
function cover(
  ctx: CanvasRenderingContext2D,
  p: { img: CanvasImageSource; w: number; h: number },
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const scale = Math.max(w / p.w, h / p.h);
  const cw = w / scale;
  const ch = h / scale;
  ctx.drawImage(p.img, (p.w - cw) / 2, (p.h - ch) / 2, cw, ch, x, y, w, h);
}

/**
 * One tilted print: white mount, photo, ribbon caption across the top
 * corner, and the date + place beneath it.
 */
function print(
  ctx: CanvasRenderingContext2D,
  S: number,
  p: PosterPhoto,
  cx: number,
  cy: number,
  cardW: number,
  cardH: number,
  tilt: number,
  accent: string
): void {
  const pad = cardW * 0.045;
  const photoW = cardW - pad * 2;
  const photoH = cardH - pad * 2;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((tilt * Math.PI) / 180);

  // white mount with a soft drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(12,20,30,0.28)";
  ctx.shadowBlur = S * 0.022;
  ctx.shadowOffsetY = S * 0.008;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, S * 0.008);
  ctx.fill();
  ctx.restore();

  // the photo itself, clipped to the mount's inner rect
  ctx.save();
  ctx.beginPath();
  ctx.rect(-photoW / 2, -photoH / 2, photoW, photoH);
  ctx.clip();
  cover(ctx, p, -photoW / 2, -photoH / 2, photoW, photoH);
  ctx.restore();

  // caption ribbon, straddling the mount's top edge
  const rh = S * 0.052;
  const capPx = rh * 0.52;
  ctx.font = `800 ${capPx}px ${FONT}`;
  const rw = Math.min(
    cardW * 0.86,
    ctx.measureText(p.label).width + rh * 1.5
  );
  const rx = -cardW / 2 + cardW * 0.06;
  const ry = -cardH / 2 - rh * 0.55;
  ctx.save();
  ctx.shadowColor = "rgba(12,20,30,0.25)";
  ctx.shadowBlur = S * 0.012;
  ctx.shadowOffsetY = S * 0.004;
  ribbon(ctx, rx, ry, rw, rh, accent, false);
  ctx.restore();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.label, rx + rw / 2 - rh * 0.17, ry + rh * 0.54);

  ctx.restore();

  // ---- date + place, drawn UPRIGHT under the tilted print --------------
  // the card leans; its caption must not, or the poster reads as crooked
  // rather than casual
  const belowY = cy + cardH / 2 + S * 0.028;
  const dh = S * 0.05;
  const dpx = dh * 0.56;
  ctx.font = `800 ${dpx}px ${FONT}`;
  const dw = ctx.measureText(p.date).width + dh * 1.4;
  ctx.save();
  ctx.shadowColor = "rgba(12,20,30,0.22)";
  ctx.shadowBlur = S * 0.01;
  ctx.shadowOffsetY = S * 0.003;
  ribbon(ctx, cx - dw / 2, belowY, dw, dh, accent, false);
  ctx.restore();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(p.date, cx - dh * 0.17, belowY + dh * 0.54);

  if (p.place) {
    const ppx = S * 0.026;
    ctx.font = `600 ${ppx}px ${FONT}`;
    ctx.fillStyle = "rgba(22,32,43,0.78)";
    const lines = wrap(ctx, p.place, cardW * 1.06, 2);
    lines.forEach((ln, i) => {
      ctx.fillText(ln, cx, belowY + dh + S * 0.03 + i * ppx * 1.28);
    });
  }
}

/**
 * The arrow from the complaint to the fix.
 *
 * It crosses the gap between the two prints and laps onto both, so it is
 * drawn over photographs whose colours are unknown: hence the white halo
 * under the stroke. Without it the arrow disappears into anything dark,
 * which is most of what a drainage complaint looks like.
 */
function arrow(
  ctx: CanvasRenderingContext2D,
  S: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): void {
  const lw = S * 0.028;
  const ctrlY = Math.min(y0, y1) - S * 0.055;
  const hl = lw * 2.2;
  // stop the stroke short of the head so it does not poke out of the tip
  const tx = x1 - (x0 + x1) / 2;
  const ty = y1 - ctrlY;
  const a = Math.atan2(ty, tx);
  const sx = x1 - Math.cos(a) * hl * 0.45;
  const sy = y1 - Math.sin(a) * hl * 0.45;

  const path = new Path2D();
  path.moveTo(x0, y0);
  path.quadraticCurveTo((x0 + x1) / 2, ctrlY, sx, sy);

  const head = new Path2D();
  head.moveTo(hl * 0.6, 0);
  head.lineTo(-hl * 0.5, -hl * 0.62);
  head.lineTo(-hl * 0.5, hl * 0.62);
  head.closePath();

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // halo first, then the arrow itself on top
  for (const pass of ["halo", "ink"] as const) {
    ctx.save();
    if (pass === "halo") {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = lw * 1.85;
      ctx.shadowColor = "rgba(12,20,30,0.28)";
      ctx.shadowBlur = S * 0.012;
      ctx.shadowOffsetY = S * 0.004;
    } else {
      ctx.strokeStyle = BEFORE;
      ctx.lineWidth = lw;
    }
    ctx.stroke(path);
    ctx.translate(x1, y1);
    ctx.rotate(a);
    if (pass === "halo") {
      ctx.lineWidth = lw * 0.9;
      ctx.stroke(head);
    } else {
      ctx.fillStyle = BEFORE;
      ctx.fill(head);
    }
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Draw the poster into `ctx`, which must be `size` × `size`.
 *
 * Square because that is what survives a WhatsApp forward and an X post
 * without either cropping the "after" away.
 */
export function renderPoster(
  ctx: CanvasRenderingContext2D,
  size: number,
  o: PosterOptions
): void {
  const S = size;
  const margin = S * 0.05;

  // ---- background -----------------------------------------------------
  const bg = ctx.createLinearGradient(0, 0, S, S);
  bg.addColorStop(0, "#f6f7f2");
  bg.addColorStop(0.55, "#eef3e6");
  bg.addColorStop(1, "#e4eddd");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, S, S);

  // ---- header: handles left, crest right ------------------------------
  const iconPx = S * 0.045;
  const gap = iconPx * 0.32;
  let hx = margin;
  const hy = margin;

  // profile photo leads the row when there is one
  if (o.profilePhoto) {
    const d = iconPx * 1.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(hx + d / 2, hy + iconPx / 2, d / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(o.profilePhoto, hx, hy + iconPx / 2 - d / 2, d, d);
    ctx.restore();
    hx += d + gap * 1.6;
  }

  // every platform's logo, then the shared handle once
  const firstGroup = o.groups[0];
  if (firstGroup) {
    for (const p of firstGroup.platforms) {
      if (!hasGlyph(p)) continue;
      drawIcon(ctx, p, hx, hy, iconPx, INK);
      hx += iconPx + gap;
    }
    hx += gap;
  }

  const nameText = o.name || firstGroup?.text || "";
  if (nameText) {
    const px = fit(ctx, nameText, S * 0.045, "800", S - hx - margin - S * 0.16);
    ctx.font = `800 ${px}px ${FONT}`;
    ctx.fillStyle = INK;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(nameText, hx, hy + iconPx * 0.52);
  }

  // any further handles sit as a quiet second line
  const rest = o.groups.slice(1);
  if (rest.length) {
    const px = S * 0.024;
    ctx.font = `600 ${px}px ${FONT}`;
    ctx.fillStyle = "rgba(22,32,43,0.62)";
    let rx = margin;
    const ry = hy + iconPx * 1.5;
    for (const g of rest) {
      for (const p of g.platforms) {
        if (!hasGlyph(p)) continue;
        drawIcon(ctx, p, rx, ry - px * 0.5, px, "rgba(22,32,43,0.62)");
        rx += px * 1.25;
      }
      ctx.fillStyle = "rgba(22,32,43,0.62)";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(g.text, rx + px * 0.2, ry);
      rx += ctx.measureText(g.text).width + px * 1.1;
      if (rx > S - margin * 2) break;
    }
  }

  if (o.crest) {
    const d = S * 0.125;
    const cx = S - margin - d / 2;
    const cy = hy + d / 2 - S * 0.012;
    ctx.save();
    ctx.shadowColor = "rgba(12,20,30,0.18)";
    ctx.shadowBlur = S * 0.014;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2 - S * 0.006, 0, Math.PI * 2);
    ctx.clip();
    const cs = d * 0.86;
    ctx.drawImage(o.crest, cx - cs / 2, cy - cs / 2, cs, cs);
    ctx.restore();
  }

  // ---- headline pill --------------------------------------------------
  const headline = o.headline.trim();
  let bodyTop = margin + S * 0.115;
  if (headline) {
    const ph = S * 0.072;
    const px = fit(ctx, headline, ph * 0.46, "800", S * 0.72);
    ctx.font = `800 ${px}px ${FONT}`;
    const pw = ctx.measureText(headline).width + ph * 1.3;
    const pxx = (S - pw) / 2;
    const pyy = bodyTop;
    ctx.save();
    ctx.shadowColor = "rgba(12,20,30,0.25)";
    ctx.shadowBlur = S * 0.016;
    ctx.shadowOffsetY = S * 0.005;
    ctx.fillStyle = "#3d1420";
    ctx.beginPath();
    ctx.roundRect(pxx, pyy, pw, ph, ph * 0.28);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(headline, S / 2, pyy + ph * 0.54);
    bodyTop = pyy + ph;
  }

  // ---- the pair -------------------------------------------------------
  const cardW = S * 0.385;
  const cardH = S * 0.455;
  const cy = bodyTop + S * 0.075 + cardH / 2;
  const leftX = margin + cardW / 2;
  const rightX = S - margin - cardW / 2;

  print(ctx, S, o.before, leftX, cy, cardW, cardH, -TILT, BEFORE);
  print(ctx, S, o.after, rightX, cy, cardW, cardH, TILT, AFTER);

  // laps a little onto both prints, the way the printed ones do
  arrow(
    ctx,
    S,
    leftX + cardW * 0.34,
    cy + cardH * 0.14,
    rightX - cardW * 0.34,
    cy + cardH * 0.04
  );
}
