/**
 * Small vertical social strip along the photo's right edge: profile
 * photo (if enabled) on top, then one chip per visible handle with the
 * platform's logo (simple-icons paths, drawn as Path2D) — unobtrusive,
 * separate from the main info card.
 */
import { siInstagram, siX, siFacebook, siYoutube, siReddit } from "simple-icons";
import type { Profile } from "../../types";
import type { WatermarkRect } from "./render";

const ICON_PATHS: Record<string, string> = {
  instagram: siInstagram.path,
  x: siX.path,
  facebook: siFacebook.path,
  youtube: siYoutube.path,
  reddit: siReddit.path,
};

/** LinkedIn withdrew from simple-icons — draw its rounded-square "in". */
function drawLinkedIn(ctx: CanvasRenderingContext2D, size: number): void {
  const r = size * 0.22;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(size, 0, size, size, r);
  ctx.arcTo(size, size, 0, size, r);
  ctx.arcTo(0, size, 0, 0, r);
  ctx.arcTo(0, 0, size, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.font = `700 ${size * 0.62}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("in", size / 2, size * 0.58);
  ctx.restore();
}

function drawIcon(
  ctx: CanvasRenderingContext2D,
  platform: string,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  const key = platform.trim().toLowerCase();
  if (key === "linkedin") {
    drawLinkedIn(ctx, size);
  } else if (ICON_PATHS[key]) {
    ctx.scale(size / 24, size / 24); // simple-icons use a 24×24 viewBox
    ctx.fill(new Path2D(ICON_PATHS[key]));
  } else {
    // unknown platform — generic @ badge
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText("@", 0, 0);
  }
  ctx.restore();
}

/**
 * Draw the handles as vertical "towers" up the photo's right edge
 * (Timemark-style): each handle is its own column — logo at the base,
 * @handle text rotated 90° running UP. Multiple handles sit SIDE BY SIDE
 * as separate parallel towers marching in from the right edge, never
 * stacked on top of one another and clear of the info card. Plain white
 * with a soft shadow, no chip backgrounds. The profile photo (when
 * enabled) is an unrotated circle at the base of the first tower.
 */
export function renderSocialStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number, // global scale (width/1080 * fontScale)
  profile: Profile,
  showHandles: boolean,
  showPhoto: boolean,
  photo: CanvasImageSource | null | undefined,
  panel: WatermarkRect | null,
  position: "bottom" | "top" = "bottom"
): void {
  const handles = showHandles
    ? profile.handles.filter((h) => h.show && h.handle.trim())
    : [];
  const wantPhoto = showPhoto && photo;
  if (!handles.length && !wantPhoto) return;

  const margin = Math.round(width * 0.025);
  const fontPx = Math.max(10, Math.round(20 * s));
  const iconPx = Math.round(fontPx * 1.0);
  const iconTextGap = Math.round(6 * s); // logo → its own handle text
  const stackGap = Math.round(fontPx * 1.4); // clear space between handles
  const top = position === "top";

  // hug the card when it spans the width: above a bottom card, below a
  // top card; else start from the photo margin
  const cardSpans = panel && panel.x + panel.width > width * 0.7;
  const baseY = top
    ? (cardSpans ? panel.y + panel.height : margin) + Math.round(12 * s)
    : (cardSpans ? panel.y : height - margin) - Math.round(12 * s);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = fontPx * 0.35;
  ctx.font = `500 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  // ONE column up the right edge. Every handle keeps the same vertical
  // orientation as the first and is stacked end-to-end along that single
  // line — the strip grows like a tower (never parallel side-by-side
  // columns, never overlapping). The profile photo sits at the base.
  const photoD = wantPhoto ? Math.round(fontPx * 2.2) : 0;
  const colHalf = Math.max(iconPx, photoD) / 2;
  const colCenter = width - margin - colHalf;

  // cursor is the near-card end of the next tower segment; it moves away
  // from the card (up for a bottom card, down for a top card)
  let cursor = baseY;

  if (wantPhoto) {
    const cy = top ? cursor + photoD / 2 : cursor - photoD / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(colCenter, cy, photoD / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(photo, colCenter - photoD / 2, cy - photoD / 2, photoD, photoD);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(colCenter, cy, photoD / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1.5, 2 * s);
    ctx.stroke();
    cursor = top ? cursor + photoD + stackGap : cursor - photoD - stackGap;
  }

  for (const h of handles) {
    const text = `@${h.handle.replace(/^@/, "")}`;
    const colLen = iconPx + iconTextGap + ctx.measureText(text).width;
    // rotate -90°: local +x points UP the screen, so the line reads
    // bottom-to-top; anchor the segment's near-card end at `cursor`
    const originY = top ? cursor + colLen : cursor;
    ctx.save();
    ctx.translate(colCenter, originY);
    ctx.rotate(-Math.PI / 2);
    drawIcon(ctx, h.platform, 0, -iconPx / 2, iconPx, "rgba(255,255,255,0.95)");
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(text, iconPx + iconTextGap, 0);
    ctx.restore();
    // advance along the SAME column to stack the next handle end-to-end
    cursor = top ? cursor + colLen + stackGap : cursor - colLen - stackGap;
  }

  ctx.restore();
}
