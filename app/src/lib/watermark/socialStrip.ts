/**
 * Small vertical social strip along the photo's right edge: profile
 * photo (if enabled) on top, then one chip per visible handle with the
 * platform's logo (simple-icons paths, drawn as Path2D) — unobtrusive,
 * separate from the main info card.
 */
import {
  siInstagram,
  siX,
  siFacebook,
  siYoutube,
  siReddit,
  siTelegram,
} from "simple-icons";
import type { Profile, WatermarkConfig } from "../../types";
import type { WatermarkRect } from "./render";

const ICON_PATHS: Record<string, string> = {
  instagram: siInstagram.path,
  x: siX.path,
  facebook: siFacebook.path,
  youtube: siYoutube.path,
  reddit: siReddit.path,
  telegram: siTelegram.path,
};

/** Per-platform username domains, for stripping a pasted profile URL. */
const URL_HINT = /https?:\/\/|(?:^|\.)(?:instagram|twitter|x|youtube|youtu\.be|reddit|facebook|fb|linkedin|telegram|t\.me)\.[a-z]/i;

/** Pull the username out of a pasted profile URL, per platform. */
function fromUrl(key: string, raw: string): string {
  const clean = raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "") // drop query (?igsh=…) and hash
    .replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  const path = parts.slice(1); // drop the domain
  if (!path.length) return "";
  const seg = (s?: string) => (s ?? "").replace(/^@/, "");
  switch (key) {
    case "linkedin": {
      const i = path.findIndex((p) => p === "in" || p === "company");
      return seg(i >= 0 ? path[i + 1] : path[path.length - 1]);
    }
    case "reddit": {
      const i = path.findIndex((p) => p === "u" || p === "user");
      return seg(i >= 0 ? path[i + 1] : path[path.length - 1]);
    }
    case "youtube": {
      const at = path.find((p) => p.startsWith("@"));
      if (at) return seg(at);
      const i = path.findIndex((p) => p === "c" || p === "user" || p === "channel");
      return seg(i >= 0 ? path[i + 1] : path[0]);
    }
    case "facebook":
      return path[0] === "profile.php" ? "" : seg(path[0]);
    default: // instagram, x/twitter, other
      return seg(path[0]);
  }
}

/**
 * Format a stored handle for display: strip a pasted URL down to the bare
 * username, drop any prefix the user typed, then apply the platform's
 * canonical prefix.
 *   Instagram / X / YouTube → @user
 *   Reddit                  → /u/user
 *   Facebook / LinkedIn     → user (URL stripped to the handle)
 *   Other                   → the text exactly as entered
 */
export function bareHandle(platform: string, rawHandle: string): string {
  const key = platform.trim().toLowerCase();
  let h = rawHandle.trim();
  if (URL_HINT.test(h)) h = fromUrl(key, h);
  // strip prefixes the user may have typed (@, /u/, u/, /in/, in/)
  return h
    .replace(/^\/+/, "")
    .replace(/^(?:u|user|in)\//i, "")
    .replace(/^@+/, "")
    .replace(/\/+$/, "")
    .trim();
}

export function formatHandle(platform: string, rawHandle: string): string {
  const key = platform.trim().toLowerCase();
  const h = bareHandle(platform, rawHandle);
  if (!h) return "";
  switch (key) {
    case "instagram":
    case "x":
    case "twitter":
    case "youtube":
    case "telegram":
      return `@${h}`;
    case "reddit":
      return `/u/${h}`;
    default: // facebook, linkedin, other — no prefix
      return h;
  }
}

/** One row of the strip: the logos that share a handle, and the handle. */
export interface HandleGroup {
  /** platforms sharing this handle, in the order the user added them */
  platforms: string[];
  /** the formatted handle, drawn once for the whole group */
  text: string;
}

/**
 * Collapse handles that are the same username on different platforms into
 * one row of logos.
 *
 * Most people who post civic complaints use one name everywhere, so the
 * strip used to repeat "@reclaimchennai" four times down the edge. Showing
 * the four logos once and the name once says the same thing in a quarter
 * of the space — and it is how organisations print it on their own posters.
 *
 * Grouping is on the BARE username, not the formatted text, so the same
 * name lands in one row even where platforms print it differently —
 * Instagram shows "@name" and Facebook shows "name", and splitting those
 * apart was exactly the repetition this removes. The row is then labelled
 * with the first platform's formatting.
 *
 * Platforms without a glyph never group: "Other" draws text alone, so
 * merging it under someone else's logo would attribute it to the wrong
 * place.
 */
export function groupHandles(
  handles: { platform: string; handle: string; show: boolean }[]
): HandleGroup[] {
  const out: HandleGroup[] = [];
  const byName = new Map<string, HandleGroup>();
  for (const h of handles) {
    if (!h.show) continue;
    const bare = bareHandle(h.platform, h.handle);
    const text = formatHandle(h.platform, h.handle);
    if (!bare || !text) continue;
    const key = bare.toLowerCase();
    const existing = hasGlyph(h.platform) ? byName.get(key) : undefined;
    if (existing) {
      if (!existing.platforms.includes(h.platform)) {
        existing.platforms.push(h.platform);
      }
      continue;
    }
    const group: HandleGroup = { platforms: [h.platform], text };
    out.push(group);
    if (hasGlyph(h.platform)) byName.set(key, group);
  }
  return out;
}

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

export function drawIcon(
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
  }
  // unknown ("Other") platforms draw NO glyph — the text stands alone,
  // exactly as the user typed it (hasGlyph() keeps spacing consistent)
  ctx.restore();
}

/**
 * The logos of a group side by side from (x, y) along +x, then nothing
 * else — returns the run's length. Shared by the tower (drawn rotated)
 * and the landscape row.
 */
function drawLogos(
  ctx: CanvasRenderingContext2D,
  platforms: string[],
  x: number,
  y: number,
  iconPx: number,
  gap: number
): number {
  let at = x;
  for (const p of platforms) {
    if (!hasGlyph(p)) continue;
    drawIcon(ctx, p, at, y, iconPx, "rgba(255,255,255,0.95)");
    at += iconPx + gap;
  }
  return at > x ? at - x - gap : 0;
}

/** Length of a group's logo run (see drawLogos). */
function logosLength(platforms: string[], iconPx: number, gap: number): number {
  const n = platforms.filter(hasGlyph).length;
  return n ? n * iconPx + (n - 1) * gap : 0;
}

/** Platforms with a drawable logo; "Other" renders text-only. */
export function hasGlyph(platform: string): boolean {
  const key = platform.trim().toLowerCase();
  return key === "linkedin" || Boolean(ICON_PATHS[key]);
}

/**
 * PORTRAIT: handles stack as ONE vertical tower up the photo's right edge
 * (Timemark-style) — every handle keeps the same orientation as the first
 * and they run end-to-end with clear spacing; the profile photo sits at
 * the tower's base. LANDSCAPE: profile photo + handles sit side by side
 * as a horizontal row instead. Both pin to the screen border OPPOSITE the
 * card (bottom card → strip hugging the top edge, and vice versa), so the
 * strip tracks the user's card choice while staying off the subject.
 * Plain white with a soft shadow, no chip backgrounds.
 */
export function renderSocialStrip(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number, // global scale (short-side/1080 * fontScale)
  profile: Profile,
  showHandles: boolean,
  showPhoto: boolean,
  photo: CanvasImageSource | null | undefined,
  panel: WatermarkRect | null,
  position: WatermarkConfig["position"] = "bottom"
): void {
  // one entry per USERNAME, its platforms' logos side by side: the same
  // name on four platforms used to be printed four times up the edge
  const groups = showHandles
    ? groupHandles(profile.handles.filter((h) => h.show && h.handle.trim()))
    : [];
  const wantPhoto = showPhoto && photo;
  if (!groups.length && !wantPhoto) return;

  if (width > height) {
    renderRow(
      ctx, width, height, s, groups, wantPhoto ? photo : null, panel, position
    );
    return;
  }

  const margin = Math.round(width * 0.025);
  const fontPx = Math.max(10, Math.round(20 * s));
  const iconPx = Math.round(fontPx * 1.0);
  const iconTextGap = Math.round(6 * s); // logo → its own handle text
  const logoGap = Math.round(iconPx * 0.35); // between logos sharing a handle
  const stackGap = Math.round(fontPx * 1.4); // clear space between handles
  // the strip pins to the screen border OPPOSITE the card: a bottom card
  // puts the strip hugging the top edge and vice versa — always clear of
  // the card and off the photo's centre
  const top = !position.startsWith("top"); // true = strip along the top border
  const baseY = top
    ? margin + Math.round(4 * s)
    : height - margin - Math.round(4 * s);

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

  for (const g of groups) {
    const logos = logosLength(g.platforms, iconPx, logoGap);
    const iconW = logos ? logos + iconTextGap : 0;
    const colLen = iconW + ctx.measureText(g.text).width;
    // rotate -90°: local +x points UP the screen, so the line reads
    // bottom-to-top; anchor the segment's near-card end at `cursor`
    const originY = top ? cursor + colLen : cursor;
    ctx.save();
    ctx.translate(colCenter, originY);
    ctx.rotate(-Math.PI / 2);
    drawLogos(ctx, g.platforms, 0, -iconPx / 2, iconPx, logoGap);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(g.text, iconW, 0);
    ctx.restore();
    // advance along the SAME column to stack the next handle end-to-end
    cursor = top ? cursor + colLen + stackGap : cursor - colLen - stackGap;
  }

  ctx.restore();
}

/** LANDSCAPE strip: profile photo + handles side by side in one horizontal
 *  row, right-aligned, pinned to the screen border opposite the card. */
function renderRow(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  s: number,
  groups: HandleGroup[],
  photo: CanvasImageSource | null | undefined,
  _panel: WatermarkRect | null, // kept for signature parity; strip pins to the border now
  position: WatermarkConfig["position"]
): void {
  const margin = Math.round(height * 0.025);
  const fontPx = Math.max(10, Math.round(20 * s));
  const iconPx = Math.round(fontPx * 1.0);
  const iconTextGap = Math.round(5 * s); // logo → its own handle text
  const logoGap = Math.round(iconPx * 0.35); // between logos sharing a handle
  const itemGap = Math.round(fontPx * 0.9); // between handles
  const top = position.startsWith("top");

  ctx.save();
  ctx.font = `500 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  const items = groups.map((g) => {
    const logos = logosLength(g.platforms, iconPx, logoGap);
    const iconW = logos ? logos + iconTextGap : 0;
    return { g, text: g.text, iconW, w: iconW + ctx.measureText(g.text).width };
  });
  const photoD = photo ? Math.round(fontPx * 2) : 0;
  const photoGap = photo && items.length ? itemGap : 0;
  const totalW =
    items.reduce((a, it) => a + it.w, 0) +
    itemGap * Math.max(0, items.length - 1) +
    photoD +
    photoGap;

  const rowH = Math.max(fontPx, photoD);
  // pin to the screen border OPPOSITE the card (bottom card → row hugging
  // the top edge, and vice versa) — never mid-frame over the subject
  const stripTop = !top; // `top` here is the CARD's side
  const centerY = stripTop
    ? margin + rowH / 2
    : height - margin - rowH / 2;

  ctx.shadowColor = "rgba(0,0,0,0.65)";
  ctx.shadowBlur = fontPx * 0.35;

  // right-aligned; never run off the left edge
  let x = Math.max(margin, width - margin - totalW);

  if (photo) {
    const cx = x + photoD / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, centerY, photoD / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(photo, cx - photoD / 2, centerY - photoD / 2, photoD, photoD);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, centerY, photoD / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = Math.max(1.5, 2 * s);
    ctx.stroke();
    x += photoD + photoGap;
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    drawLogos(ctx, it.g.platforms, x, centerY - iconPx / 2, iconPx, logoGap);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `500 ${fontPx}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText(it.text, x + it.iconW, centerY);
    x += it.w + (i < items.length - 1 ? itemGap : 0);
  }

  ctx.restore();
}
