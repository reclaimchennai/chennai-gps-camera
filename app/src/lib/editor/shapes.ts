/** Shared shape model for the photo & video annotation/blur editor (§5.6). */

export type Shape =
  | {
      id: string;
      type: "arrow";
      points: number[]; // [x1,y1,x2,y2]
      stroke: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "ellipse";
      x: number;
      y: number;
      radiusX: number;
      radiusY: number;
      rotation: number;
      stroke: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "pen"; // opaque freehand; consecutive strokes group into one shape
      strokes: number[][];
      stroke: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "highlight"; // translucent marker, same multi-stroke grouping
      strokes: number[][];
      stroke: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: "text";
      x: number;
      y: number;
      text: string;
      fontSize: number;
      fill: string;
      rotation: number;
      fontFamily?: string; // one of TEXT_FONTS, default Roboto
      bgStyle?: "none" | "chip"; // Telegram-style colored chip behind text
      align?: "left" | "center" | "right";
    }
  | {
      id: string;
      type: "blur-rect";
      x: number;
      y: number;
      width: number;
      height: number;
      auto?: boolean; // came from auto-detect (still fully editable)
      intensity?: number; // 0..1, see blocksFor()
    }
  | {
      id: string;
      type: "blur-lasso";
      points: number[]; // closed freehand region
      intensity?: number;
    };

export const DEFAULT_BLUR_INTENSITY = 0.7;

/**
 * Map blur intensity (0..1) to mosaic block count across the longest
 * image edge — fewer blocks = chunkier pixels = stronger redaction.
 */
export function blocksFor(intensity: number = DEFAULT_BLUR_INTENSITY): number {
  const v = Math.min(1, Math.max(0, intensity));
  return Math.round(64 - v * 52); // 1.0 → 12 blocks, 0 → 64
}

export type Tool =
  | "pen"
  | "arrow"
  | "ellipse"
  | "highlight"
  | "text"
  | "blur-rect"
  | "blur-lasso";

export const MARK_COLORS = ["#f43f5e", "#fbbf24", "#38bdf8", "#34d399", "#ffffff"];

/** Self-hosted open-source fonts available for text annotations. */
export const TEXT_FONTS = [
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Oswald",
  "Caveat",
];

/** Black or white, whichever reads on the given hex/rgb color. */
export function contrastOn(color: string): string {
  let r = 255, g = 255, b = 255;
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    r = parseInt(hex[1].slice(0, 2), 16);
    g = parseInt(hex[1].slice(2, 4), 16);
    b = parseInt(hex[1].slice(4, 6), 16);
  } else {
    const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (rgb) {
      r = Number(rgb[1]);
      g = Number(rgb[2]);
      b = Number(rgb[3]);
    }
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
}

/**
 * Build a pixelated (mosaic) copy of an image — blur regions render
 * slices of this. Block size scales with resolution so the mosaic reads
 * the same at any output size.
 */
export function makeMosaic(
  source: CanvasImageSource,
  width: number,
  height: number,
  blocks = 42
): HTMLCanvasElement {
  const small = document.createElement("canvas");
  const factor = Math.max(1, Math.round(Math.max(width, height) / blocks));
  small.width = Math.max(1, Math.round(width / factor));
  small.height = Math.max(1, Math.round(height / factor));
  const sctx = small.getContext("2d")!;
  sctx.drawImage(source, 0, 0, small.width, small.height);

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, width, height);
  return out;
}

/**
 * Draw markup shapes (everything except blur regions) onto a plain 2D
 * context — used to pre-render the static overlay for video export.
 */
export function drawMarkupShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[]
): void {
  for (const s of shapes) {
    if (s.type === "arrow") {
      const [x1, y1, x2, y2] = s.points;
      ctx.strokeStyle = s.stroke;
      ctx.fillStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = s.strokeWidth * 3;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(
        x2 - head * Math.cos(angle - Math.PI / 6),
        y2 - head * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        x2 - head * Math.cos(angle + Math.PI / 6),
        y2 - head * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
    } else if (s.type === "ellipse") {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((s.rotation * Math.PI) / 180);
      ctx.beginPath();
      ctx.ellipse(0, 0, s.radiusX, s.radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else if (s.type === "highlight" || s.type === "pen") {
      ctx.save();
      ctx.globalAlpha = s.type === "highlight" ? 0.45 : 1;
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const pts of s.strokes) {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) {
          if (i === 0) ctx.moveTo(pts[i], pts[i + 1]);
          else ctx.lineTo(pts[i], pts[i + 1]);
        }
        ctx.stroke();
      }
      ctx.restore();
    } else if (s.type === "text") {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate((s.rotation * Math.PI) / 180);
      const family = s.fontFamily ?? "Roboto";
      ctx.font = `500 ${s.fontSize}px "${family}", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      const lines = s.text.split("\n");
      const lineH = s.fontSize * 1.2;
      const align = s.align ?? "center";
      const widths = lines.map((ln) => ctx.measureText(ln).width);
      const blockW = Math.max(...widths, 0);
      const lineX = (i: number) =>
        align === "center"
          ? (blockW - widths[i]) / 2
          : align === "right"
            ? blockW - widths[i]
            : 0;
      if (s.bgStyle === "chip") {
        const pad = s.fontSize * 0.35;
        const r = s.fontSize * 0.35;
        const bw = blockW + pad * 2;
        const bh = lines.length * lineH + pad * 2;
        ctx.beginPath();
        ctx.moveTo(-pad + r, -pad);
        ctx.arcTo(-pad + bw, -pad, -pad + bw, -pad + bh, r);
        ctx.arcTo(-pad + bw, -pad + bh, -pad, -pad + bh, r);
        ctx.arcTo(-pad, -pad + bh, -pad, -pad, r);
        ctx.arcTo(-pad, -pad, -pad + bw, -pad, r);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
        ctx.fillStyle = contrastOn(s.fill);
      } else {
        ctx.fillStyle = s.fill;
        ctx.shadowColor = "rgba(0,0,0,0.7)";
        ctx.shadowBlur = s.fontSize / 6;
      }
      lines.forEach((ln, i) => ctx.fillText(ln, lineX(i), i * lineH));
      ctx.restore();
    }
  }
}

/**
 * Paint every blur region from `shapes` onto ctx using per-intensity
 * mosaic copies. `getMosaic(blocks)` supplies (and may cache) a mosaic
 * of the current output frame. Shape coordinates are source space,
 * shifted by (offsetX, offsetY) — e.g. a crop origin.
 */
export function paintBlurRegions(
  ctx: CanvasRenderingContext2D,
  getMosaic: (blocks: number) => HTMLCanvasElement,
  shapes: Shape[],
  offsetX = 0,
  offsetY = 0
): void {
  for (const s of shapes) {
    if (s.type !== "blur-rect" && s.type !== "blur-lasso") continue;
    const mosaic = getMosaic(blocksFor(s.intensity));
    if (s.type === "blur-rect") {
      const x = s.x - offsetX;
      const y = s.y - offsetY;
      ctx.drawImage(
        mosaic,
        x, y, s.width, s.height,
        x, y, s.width, s.height
      );
    } else if (s.type === "blur-lasso") {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < s.points.length; i += 2) {
        const x = s.points[i] - offsetX;
        const y = s.points[i + 1] - offsetY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(mosaic, 0, 0);
      ctx.restore();
    }
  }
}
