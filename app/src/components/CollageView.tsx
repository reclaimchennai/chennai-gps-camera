/**
 * Photo collage builder (§ gallery).
 *
 * PICK: every photo — video-frame folders arrive pre-expanded so frames
 * are individually pickable — with long-press peek. ARRANGE: a balanced
 * grid chosen purely by count (near-square, incomplete rows stretch, so
 * every photo gets maximum visibility), drag a tile onto another to
 * swap, drag it onto the shelf to set it aside, tap a shelf photo to
 * bring it back. Each tile gets a FRESH mini location label drawn at
 * full collage resolution (the burned-in cards shrink into illegibility;
 * the label keeps every photo's place readable). The tick composes and
 * saves through the normal photo pipeline.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ArrowRight, ImagePlus } from "lucide-react";
import { listMedia, getBlob, putBlob, putMedia, newId } from "../lib/db";
import type { PhotoRecord } from "../types";
import { navigate, goBack } from "../nav";
import { canvasToBlob, makeThumbnail, loadImage } from "../lib/img";
import { writeExif } from "../lib/exif";
import { scheduleDownloads } from "../lib/downloadQueue";
import { isNativeApp } from "../lib/native";
import { useSettingsStore } from "../store";
import { fmtWard } from "../lib/geo/format";
import { usePeek } from "./peek";

interface Cell {
  rec: PhotoRecord;
  url: string | null; // thumb URL
}

/** Balanced row layout: near-square, remainder rows stretch full width. */
export function layoutRows(n: number): number[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  return Array.from({ length: rows }, (_, i) => (i < extra ? base + 1 : base));
}

function tileLabel(rec: PhotoRecord): string {
  const d = rec.data;
  const place = d.locality
    ? d.locality.split(",")[0].trim()
    : d.jurisdiction && d.jurisdiction.scope !== "out" && d.jurisdiction.ward
      ? `Ward ${fmtWard(d.jurisdiction.ward)}`
      : d.fix
        ? `${d.fix.lat.toFixed(4)}°, ${d.fix.lng.toFixed(4)}°`
        : "";
  const when = new Date(rec.createdAt).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return place ? `${place} · ${when}` : when;
}

export default function CollageView() {
  const [phase, setPhase] = useState<"pick" | "arrange">("pick");
  const [all, setAll] = useState<Cell[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // ordered ids
  const [shelf, setShelf] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | "shelf" | null>(null);
  const dragPosRef = useRef({ x: 0, y: 0 });
  const dragOriginRef = useRef({ x: 0, y: 0 }); // tile centre at drag start
  const [dragTick, setDragTick] = useState(0);
  const { bind: bindPeek, layer: peekLayer } = usePeek();

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      // groups expanded: EVERY photo, frames included, newest first
      const items = (await listMedia()).filter(
        (m): m is PhotoRecord => m.kind === "photo"
      );
      const cells = await Promise.all(
        items.map(async (rec) => {
          const t = await getBlob(rec.id, "thumb");
          const url = t ? URL.createObjectURL(t) : null;
          if (url) urls.push(url);
          return { rec, url };
        })
      );
      if (!cancelled) setAll(cells);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const byId = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of all ?? []) m.set(c.rec.id, c);
    return m;
  }, [all]);

  const rows = layoutRows(picked.length);

  // ---- drag to swap / shelve -----------------------------------------
  const onTileDown = (idx: number) => (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOriginRef.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setDragIdx(idx);
    dragPosRef.current = { x: e.clientX, y: e.clientY };
    setDragTick((t) => t + 1);
  };
  const onTileMove = (e: React.PointerEvent) => {
    if (dragIdx == null) return;
    dragPosRef.current = { x: e.clientX, y: e.clientY };
    setDragTick((t) => t + 1);
    const el = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((n) => n instanceof HTMLElement && (n.dataset.tile || n.dataset.shelfzone)) as
      | HTMLElement
      | undefined;
    if (!el) setOverIdx(null);
    else if (el.dataset.shelfzone) setOverIdx("shelf");
    else setOverIdx(Number(el.dataset.tile));
  };
  const onTileUp = () => {
    if (dragIdx != null && overIdx != null) {
      if (overIdx === "shelf") {
        const id = picked[dragIdx];
        setPicked((p) => p.filter((_, i) => i !== dragIdx));
        setShelf((s) => [...s, id]);
      } else if (overIdx !== dragIdx) {
        setPicked((p) => {
          const n = [...p];
          [n[dragIdx], n[overIdx as number]] = [n[overIdx as number], n[dragIdx]];
          return n;
        });
      }
    }
    setDragIdx(null);
    setOverIdx(null);
  };

  // ---- compose + save -------------------------------------------------
  const save = async () => {
    if (busy || picked.length < 2) return;
    setBusy(true);
    try {
      const OUT_W = 2048;
      const rowsArr = layoutRows(picked.length);
      const cols = Math.max(...rowsArr);
      const gap = Math.round(OUT_W * 0.004);
      const cellH = Math.round(OUT_W / cols);
      const outH = rowsArr.length * cellH + gap * (rowsArr.length + 1);
      const canvas = document.createElement("canvas");
      canvas.width = OUT_W;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#0b0f14";
      ctx.fillRect(0, 0, OUT_W, outH);

      let i = 0;
      let y = gap;
      for (const count of rowsArr) {
        const tileW = Math.round((OUT_W - gap * (count + 1)) / count);
        let x = gap;
        for (let k = 0; k < count; k++, i++) {
          const cell = byId.get(picked[i]);
          if (!cell) continue;
          // decode ONE photo at a time — peak memory stays a single
          // full-res image + the collage canvas, low-RAM-phone safe
          const blob = await getBlob(cell.rec.id, "final");
          if (blob) {
            const img = await loadImage(blob);
            const sw = img.naturalWidth;
            const sh = img.naturalHeight;
            const scale = Math.max(tileW / sw, cellH / sh);
            const cw = tileW / scale;
            const ch = cellH / scale;
            ctx.drawImage(
              img,
              (sw - cw) / 2,
              (sh - ch) / 2,
              cw,
              ch,
              x,
              y,
              tileW,
              cellH
            );
          }
          // fresh, crisp location label — readable where the burned
          // card has shrunk away
          const label = tileLabel(cell.rec);
          if (label) {
            const fpx = Math.max(18, Math.round(cellH * 0.045));
            ctx.font = `500 ${fpx}px system-ui, sans-serif`;
            const tw = ctx.measureText(label).width;
            const pad = Math.round(fpx * 0.5);
            const bx = x + pad;
            const by = y + cellH - pad - fpx * 1.5;
            ctx.fillStyle = "rgba(10,14,20,0.6)";
            ctx.beginPath();
            ctx.roundRect(bx, by, tw + pad * 2, fpx * 1.5, fpx * 0.4);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.textBaseline = "middle";
            ctx.fillText(label, bx + pad, by + fpx * 0.78);
          }
          x += tileW + gap;
        }
        y += cellH + gap;
      }

      const first = byId.get(picked[0])!.rec;
      const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const withExif = await writeExif(jpeg, first.data);
      const thumb = await makeThumbnail(canvas, canvas.width, canvas.height);
      const { settings } = useSettingsStore.getState();
      const rec: PhotoRecord = {
        id: newId(),
        kind: "photo",
        createdAt: Date.now(),
        width: canvas.width,
        height: canvas.height,
        data: first.data,
        config: first.config,
        backfill: "not-needed",
        hasRaw: false,
        tags: ["collage"],
        download:
          settings.autoSaveToDevice || isNativeApp() ? "queued" : undefined,
      };
      await putBlob(rec.id, "final", withExif);
      await putBlob(rec.id, "thumb", thumb);
      await putMedia(rec);
      scheduleDownloads();
      navigate(`/media/${rec.id}`, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  // ---- UI -------------------------------------------------------------
  return (
    <div className="screen" style={{ position: "fixed", inset: 0, zIndex: 10, background: "var(--bg)" }}>
      <header className="screen-header">
        <button
          className="icon-btn"
          onClick={() => (phase === "arrange" ? setPhase("pick") : goBack())}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <h1>{phase === "pick" ? `Collage — pick photos (${picked.length})` : "Arrange"}</h1>
        {phase === "pick" ? (
          <button
            className="icon-btn"
            style={{ marginLeft: "auto" }}
            disabled={picked.length < 2}
            onClick={() => setPhase("arrange")}
            aria-label="Arrange collage"
          >
            <ArrowRight size={20} />
          </button>
        ) : (
          <button
            className="icon-btn"
            style={{ marginLeft: "auto" }}
            disabled={busy || picked.length < 2}
            onClick={() => void save()}
            aria-label="Save collage"
          >
            <Check size={20} />
          </button>
        )}
      </header>

      <div className="screen-body" style={{ display: "flex", flexDirection: "column" }}>
        {phase === "pick" && (
          <>
            <div className="hint" style={{ padding: "0 2px 8px" }}>
              Tap to select — the order you pick is the starting order. Hold
              a photo to preview it. Frames from videos are listed too.
            </div>
            <div className="gallery-grid">
              {all?.map(({ rec, url }) => {
                const sel = picked.indexOf(rec.id);
                return (
                  <button
                    key={rec.id}
                    className={`gallery-cell${sel >= 0 ? " selected" : ""}`}
                    {...bindPeek(rec)}
                    onClick={() =>
                      setPicked((p) =>
                        sel >= 0 ? p.filter((x) => x !== rec.id) : [...p, rec.id]
                      )
                    }
                  >
                    {url && <img src={url} alt="" loading="lazy" />}
                    {sel >= 0 && <span className="pick-badge">{sel + 1}</span>}
                    {rec.sourceVideoId && (
                      <span className="badge">frame</span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {phase === "arrange" && (
          <>
            <div className="hint" style={{ padding: "0 2px 8px" }}>
              Drag a photo onto another to swap. Drag it to the shelf below
              to set it aside; tap a shelf photo to bring it back.
            </div>
            <div className="collage-board" onPointerMove={onTileMove} onPointerUp={onTileUp}>
              {(() => {
                let i = -1;
                return rows.map((count, r) => (
                  <div className="collage-row" key={r} style={{ flex: 1 }}>
                    {Array.from({ length: count }).map(() => {
                      i++;
                      const idx = i;
                      const cell = byId.get(picked[idx]);
                      if (!cell) return null;
                      const dragging = dragIdx === idx;
                      return (
                        <div
                          key={cell.rec.id}
                          data-tile={idx}
                          className={`collage-tile${dragging ? " dragging" : ""}${overIdx === idx && dragIdx !== null && dragIdx !== idx ? " target" : ""}`}
                          style={
                            dragging && dragTick
                              ? {
                                  transform: `translate(${dragPosRef.current.x - dragOriginRef.current.x}px, ${dragPosRef.current.y - dragOriginRef.current.y}px) scale(0.92)`,
                                }
                              : undefined
                          }
                          onPointerDown={onTileDown(idx)}
                        >
                          {cell.url && <img src={cell.url} alt="" draggable={false} />}
                          <span className="tile-label">{tileLabel(cell.rec)}</span>
                        </div>
                      );
                    })}
                  </div>
                ));
              })()}
            </div>
            <div
              className={`collage-shelf${overIdx === "shelf" && dragIdx !== null ? " target" : ""}`}
              data-shelfzone="1"
            >
              {shelf.length === 0 && (
                <span className="hint" style={{ pointerEvents: "none" }}>
                  <ImagePlus size={13} style={{ verticalAlign: "-2px" }} /> Shelf — drag photos here
                </span>
              )}
              {shelf.map((id) => {
                const cell = byId.get(id);
                return cell ? (
                  <button
                    key={id}
                    className="shelf-item"
                    onClick={() => {
                      setShelf((s) => s.filter((x) => x !== id));
                      setPicked((p) => [...p, id]);
                    }}
                  >
                    {cell.url && <img src={cell.url} alt="" />}
                  </button>
                ) : null;
              })}
            </div>
          </>
        )}
      </div>
      {peekLayer}
    </div>
  );
}
