/**
 * Report an issue → Telegram. A description plus an optional screenshot
 * the user can annotate with the same kinds of tools as the gallery
 * editor (pen, arrow, box, highlight, blur-to-redact), then send.
 */
import { useEffect, useRef, useState } from "react";
import {
  Pen,
  ArrowUpRight,
  Square,
  Highlighter,
  Trash2,
  ImagePlus,
  Undo2,
  Send,
} from "lucide-react";
import { Screen } from "./ui";
import { goBack } from "../nav";
import { sendReport, reportingEnabled } from "../lib/report";
import PixelateIcon from "./editor/PixelateIcon";
import { MARK_COLORS } from "../lib/editor/shapes";
import { loadImage } from "../lib/img";

type Tool = "pen" | "arrow" | "box" | "highlight" | "blur";

interface Shape {
  tool: Tool;
  color: string;
  pts: number[]; // pen/highlight: x0,y0,x1,y1…; others: x0,y0,x1,y1
}

const TOOLS: { key: Tool; icon: React.ReactNode; label: string }[] = [
  { key: "pen", icon: <Pen size={18} />, label: "Pen" },
  { key: "highlight", icon: <Highlighter size={18} />, label: "Highlight" },
  { key: "arrow", icon: <ArrowUpRight size={18} />, label: "Arrow" },
  { key: "box", icon: <Square size={18} />, label: "Box" },
  { key: "blur", icon: <PixelateIcon size={18} />, label: "Blur" },
];

export default function ReportView() {
  const [text, setText] = useState("");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drawing = useRef<Shape | null>(null);
  const mosaicRef = useRef<HTMLCanvasElement | null>(null);

  // ---- render the screenshot + annotations ---------------------------
  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const scale = canvas.width / img.naturalWidth;
    const all = drawing.current ? [...shapes, drawing.current] : shapes;
    for (const s of all) paint(ctx, s, scale);
  };

  const paint = (ctx: CanvasRenderingContext2D, s: Shape, scale: number) => {
    const p = s.pts;
    ctx.save();
    if (s.tool === "blur") {
      const mos = mosaicRef.current;
      if (mos && p.length >= 4) {
        const x = Math.min(p[0], p[2]);
        const y = Math.min(p[1], p[3]);
        const w = Math.abs(p[2] - p[0]);
        const h = Math.abs(p[3] - p[1]);
        ctx.drawImage(mos, x, y, w, h, x, y, w, h);
      }
      ctx.restore();
      return;
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(2, 3 * scale) * (s.tool === "highlight" ? 4 : 1);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.tool === "highlight") ctx.globalAlpha = 0.35;
    if (s.tool === "pen" || s.tool === "highlight") {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.stroke();
    } else if (s.tool === "box") {
      ctx.strokeRect(p[0], p[1], p[2] - p[0], p[3] - p[1]);
    } else if (s.tool === "arrow") {
      const [x0, y0, x1, y1] = p;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(10, 16 * scale);
      ctx.lineTo(x1 - head * Math.cos(ang - 0.4), y1 - head * Math.sin(ang - 0.4));
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - head * Math.cos(ang + 0.4), y1 - head * Math.sin(ang + 0.4));
      ctx.stroke();
    }
    ctx.restore();
  };

  useEffect(redraw, [img, shapes]);

  // ---- load an image, size the canvas, precompute the mosaic ---------
  const onPick = async (file: File) => {
    const el = await loadImage(file);
    setImg(el);
    setShapes([]);
    // canvas is displayed at the fit width; drawing coords are in canvas px
    requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const wrapW = canvas.parentElement?.clientWidth ?? 340;
      const cw = Math.min(wrapW, el.naturalWidth);
      const ch = (cw * el.naturalHeight) / el.naturalWidth;
      canvas.width = cw;
      canvas.height = ch;
      // pixelated copy for the blur/redact tool
      const blocks = Math.max(12, Math.round(cw / 14));
      const tiny = document.createElement("canvas");
      tiny.width = blocks;
      tiny.height = Math.round((blocks * ch) / cw);
      const tctx = tiny.getContext("2d");
      const mos = document.createElement("canvas");
      mos.width = cw;
      mos.height = ch;
      const mctx = mos.getContext("2d");
      if (tctx && mctx) {
        tctx.drawImage(el, 0, 0, tiny.width, tiny.height);
        mctx.imageSmoothingEnabled = false;
        mctx.drawImage(tiny, 0, 0, tiny.width, tiny.height, 0, 0, cw, ch);
      }
      mosaicRef.current = mos;
      redraw();
    });
  };

  const pos = (e: React.PointerEvent) => {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!img) return;
    const { x, y } = pos(e);
    drawing.current = { tool, color, pts: [x, y, x, y] };
    redraw();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const { x, y } = pos(e);
    const d = drawing.current;
    if (d.tool === "pen" || d.tool === "highlight") d.pts.push(x, y);
    else {
      d.pts[2] = x;
      d.pts[3] = y;
    }
    redraw();
  };
  const onUp = () => {
    if (drawing.current) {
      setShapes((s) => [...s, drawing.current!]);
      drawing.current = null;
    }
  };

  const flatten = (): Promise<Blob | null> => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return Promise.resolve(null);
    return new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.85));
  };

  const onSend = async () => {
    if (!text.trim() && !img) return;
    setStatus("sending");
    const shot = img ? await flatten() : null;
    const ok = await sendReport(text, shot);
    setStatus(ok ? "sent" : "error");
    if (ok) window.setTimeout(() => goBack(), 1200);
  };

  if (!reportingEnabled()) {
    return (
      <Screen title="Report an issue">
        <div className="empty-note">
          Issue reporting isn't configured in this build.
        </div>
      </Screen>
    );
  }

  return (
    <Screen title="Report an issue">
      <div className="card" style={{ padding: 14 }}>
        <div className="label" style={{ marginBottom: 6 }}>What went wrong?</div>
        <textarea
          className="report-text"
          rows={5}
          placeholder="Describe the issue — what you did, what you expected, what happened…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        {!img ? (
          <button className="ghost-btn" style={{ width: "100%", marginTop: 10 }} onClick={() => fileRef.current?.click()}>
            <ImagePlus size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
            Attach a screenshot (optional)
          </button>
        ) : (
          <>
            <div className="report-canvas-wrap">
              <canvas
                ref={canvasRef}
                className="report-canvas"
                onPointerDown={onDown}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={onUp}
              />
            </div>
            <div className="report-tools">
              {TOOLS.map((t) => (
                <button
                  key={t.key}
                  className="tool-ic"
                  data-active={tool === t.key}
                  aria-label={t.label}
                  onClick={() => setTool(t.key)}
                >
                  {t.icon}
                </button>
              ))}
              <button
                className="tool-ic"
                aria-label="Undo"
                disabled={!shapes.length}
                onClick={() => setShapes((s) => s.slice(0, -1))}
              >
                <Undo2 size={18} />
              </button>
              <button
                className="tool-ic"
                aria-label="Remove screenshot"
                onClick={() => {
                  setImg(null);
                  setShapes([]);
                }}
              >
                <Trash2 size={18} />
              </button>
            </div>
            <div className="report-colors">
              {MARK_COLORS.map((c) => (
                <button
                  key={c}
                  className="color-dot"
                  data-active={color === c}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                />
              ))}
            </div>
          </>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPick(f);
            e.target.value = "";
          }}
        />

        <button
          className="primary-btn"
          style={{ width: "100%", marginTop: 14 }}
          disabled={status === "sending" || (!text.trim() && !img)}
          onClick={() => void onSend()}
        >
          <Send size={16} style={{ verticalAlign: "-3px", marginRight: 6 }} />
          {status === "sending" ? "Sending…" : status === "sent" ? "Sent — thank you!" : "Send report"}
        </button>
        {status === "error" && (
          <div className="hint" style={{ color: "var(--danger)", marginTop: 8, textAlign: "center" }}>
            Couldn't send — check your connection and try again.
          </div>
        )}
        <p className="hint" style={{ marginTop: 10, lineHeight: 1.5 }}>
          Your report and screenshot go to the project's issue channel on
          Telegram. Device and build details are attached automatically. No
          photos from your gallery are included unless you attach them here.
        </p>
      </div>
    </Screen>
  );
}
