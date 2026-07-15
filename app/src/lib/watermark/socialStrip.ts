/**
 * Small vertical social strip along the photo's right edge: profile
 * photo (if enabled) on top, then one chip per visible handle with the
 * platform's logo (simple-icons paths, drawn as Path2D) — unobtrusive,
 * separate from the main info card.
 */
import { siInstagram, siX, siFacebook, siYoutube } from "simple-icons";
import type { Profile } from "../../types";
import type { WatermarkRect } from "./render";

const ICON_PATHS: Record<string, string> = {
  instagram: siInstagram.path,
  x: siX.path,
  facebook: siFacebook.path,
  youtube: siYoutube.path,
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
 * Draw the strip: handle text rotated 90° so it runs UP the photo's
 * right edge (Timemark-style) — plain white with a soft shadow, no chip
 * backgrounds. Multiple handles form parallel vertical columns; the
 * profile photo (when enabled) sits as an unrotated circle at the base.
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
  const gap = Math.round(8 * s);
  const colW = Math.round(fontPx * 1.6);
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

  // cursor moves away from the card: up for bottom cards, down for top
  let cursor = baseY;

  if (wantPhoto) {
    const d = Math.round(fontPx * 2.2);
    const cx = width - margin - d / 2;
    const cy = top ? cursor + d / 2 : cursor - d / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(photo, cx - d / 2, cy - d / 2, d, d);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1.5, 2 * s);
    ctx.stroke();
    cursor = top ? cursor + d + gap : cursor - d - gap;
  }

  ctx.font = `500 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  let colRight = width - margin;
  for (const h of handles) {
    const text = `@${h.handle.replace(/^@/, "")}`;
    // rotated column length, to anchor its top edge for top-positioned cards
    const colLen =
      iconPx + Math.round(6 * s) + ctx.measureText(text).width;
    const originY = top ? cursor + colLen : cursor;
    ctx.save();
    // rotate -90°: +x now points up the screen, so the line reads
    // bottom-to-top along the right edge
    ctx.translate(colRight - colW / 2, originY);
    ctx.rotate(-Math.PI / 2);
    drawIcon(ctx, h.platform, 0, -iconPx / 2, iconPx, "rgba(255,255,255,0.95)");
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `500 ${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(text, iconPx + Math.round(6 * s), 0);
    ctx.restore();
    colRight -= colW;
  }

  ctx.restore();
}
