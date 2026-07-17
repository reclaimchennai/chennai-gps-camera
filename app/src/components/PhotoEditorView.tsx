import { useCallback, useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Group as KGroup,
  Image as KImage,
  Arrow as KArrow,
  Ellipse as KEllipse,
  Line as KLine,
  Text as KText,
  Label as KLabel,
  Tag as KTag,
  Transformer,
} from "react-konva";
import type Konva from "konva";
import {
  Pen,
  Highlighter,
  ArrowUpRight,
  Circle,
  Type,
  Square,
  Lasso,
  ScanFace,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Plus,
  ChevronUp,
  ZoomIn,
} from "lucide-react";
import {
  EditorTopBar,
  ToolRow,
  PopMenu,
  IntensitySlider,
  ColorSlider,
  CoachOverlay,
  type ToolDef,
} from "./editor/EditorChrome";
import PixelateIcon from "./editor/PixelateIcon";
import { getMedia, getBlob, putBlob, putMedia, newId, kvGet, kvSet } from "../lib/db";
import { loadImage, canvasToBlob, makeThumbnail } from "../lib/img";
import { writeExif } from "../lib/exif";
import { detectFaces } from "../lib/detect/faces";
import {
  makeMosaic,
  blocksFor,
  contrastOn,
  MARK_COLORS,
  TEXT_FONTS,
  DEFAULT_BLUR_INTENSITY,
  type Shape,
  type Tool,
} from "../lib/editor/shapes";
import type { PhotoRecord } from "../types";
import { navigate, goBack } from "../nav";
import { useSettingsStore } from "../store";
import { downloadBlob, suggestedName } from "../lib/share";

/** slider value ↔ shape parameter mapping (relative to image width) */
const strokeFor = (imgW: number, v: number) => imgW * (0.002 + 0.028 * v);
const strokeVal = (imgW: number, sw: number) =>
  Math.min(1, Math.max(0, (sw / imgW - 0.002) / 0.028));
const fontFor = (imgW: number, v: number) => imgW * (0.015 + 0.085 * v);
const fontVal = (imgW: number, fs: number) =>
  Math.min(1, Math.max(0, (fs / imgW - 0.015) / 0.085));

const DEFAULT_SLIDER: Record<string, number> = {
  pen: 0.3,
  arrow: 0.25,
  ellipse: 0.25,
  highlight: 0.55,
  text: 0.35,
  "blur-rect": DEFAULT_BLUR_INTENSITY,
  "blur-lasso": DEFAULT_BLUR_INTENSITY,
};

const COLORABLE = new Set(["pen", "arrow", "ellipse", "highlight", "text"]);

/** Strokes drawn within this window merge into one selectable shape. */
const STROKE_GROUP_MS = 2000;

const ALIGN_ORDER = ["left", "center", "right"] as const;

export default function PhotoEditorView({ id }: { id: string }) {
  const [rec, setRec] = useState<PhotoRecord | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fit, setFit] = useState(1);
  // No default tool: with nothing selected one finger pans the (zoomed)
  // photo — users pick a tool deliberately before drawing.
  const [tool, setTool] = useState<Tool | null>(null);
  // pinch/wheel zoom viewport: stage scale = fit * zoom, position = x/y
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Shape[][]>([[]]);
  const [histIdx, setHistIdx] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sliderVals, setSliderVals] = useState({ ...DEFAULT_SLIDER });
  const [blurMenuOpen, setBlurMenuOpen] = useState(false);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textFont, setTextFont] = useState(TEXT_FONTS[0]);
  const [textBg, setTextBg] = useState<"none" | "chip">("none");
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  // pen/highlight stroke group currently accepting more strokes
  const [openStrokeId, setOpenStrokeId] = useState<string | null>(null);
  const [showCoach, setShowCoach] = useState(false);

  useEffect(() => {
    void kvGet<boolean>("coach-photo-editor").then((seen) => {
      if (!seen) setShowCoach(true);
    });
  }, []);

  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const drawingRef = useRef<Shape | null>(null);
  const strokeDrawRef = useRef<string | null>(null); // shape id being stroked
  const strokeTimerRef = useRef<number>(0);
  const openStrokeIdRef = useRef<string | null>(null);
  const openStrokeToolRef = useRef<"pen" | "highlight" | null>(null);
  const histIdxRef = useRef(0);
  const shapesRef = useRef<Shape[]>([]);
  const mosaicsRef = useRef(new Map<number, HTMLCanvasElement>());
  const viewRef = useRef(view);
  viewRef.current = view;
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);

  const showNote = useCallback((msg: string, ms = 3200) => {
    setNote(msg);
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), ms);
  }, []);

  const getMosaic = useCallback(
    (blocks: number): HTMLCanvasElement | null => {
      if (!img) return null;
      let m = mosaicsRef.current.get(blocks);
      if (!m) {
        m = makeMosaic(img, img.naturalWidth, img.naturalHeight, blocks);
        mosaicsRef.current.set(blocks, m);
      }
      return m;
    },
    [img]
  );

  // ---- load photo -----------------------------------------------------
  useEffect(() => {
    void (async () => {
      const r = await getMedia(id);
      if (!r || r.kind !== "photo") {
        navigate("/gallery");
        return;
      }
      setRec(r);
      const blob = await getBlob(id, "final");
      if (!blob) return;
      const el = await loadImage(blob);
      mosaicsRef.current.clear();
      setImg(el);
    })();
  }, [id]);

  // ---- fit-to-screen scale -------------------------------------------
  useEffect(() => {
    if (!img) return;
    const compute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const f = Math.min(
        wrap.clientWidth / img.naturalWidth,
        wrap.clientHeight / img.naturalHeight
      );
      setFit(f > 0 ? f : 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [img]);

  // ---- history ----------------------------------------------------------
  histIdxRef.current = histIdx;
  shapesRef.current = shapes;

  const commit = useCallback(
    (next: Shape[]) => {
      setShapes(next);
      setHistory((h) => [...h.slice(0, histIdx + 1), next]);
      setHistIdx((i) => i + 1);
    },
    [histIdx]
  );

  /** Seal the open pen/highlight stroke group: it becomes a single
   *  selectable shape and one history entry. */
  const closeOpenStroke = useCallback(() => {
    window.clearTimeout(strokeTimerRef.current);
    if (!openStrokeIdRef.current) return;
    openStrokeIdRef.current = null;
    openStrokeToolRef.current = null;
    setOpenStrokeId(null);
    setHistory((h) => [...h.slice(0, histIdxRef.current + 1), shapesRef.current]);
    setHistIdx((i) => i + 1);
  }, []);

  useEffect(() => () => window.clearTimeout(strokeTimerRef.current), []);

  const undo = useCallback(() => {
    closeOpenStroke();
    if (histIdxRef.current === 0) return;
    setHistIdx(histIdxRef.current - 1);
    setShapes(history[histIdxRef.current - 1]);
    setSelectedId(null);
    setEditingTextId(null);
  }, [history, closeOpenStroke]);

  const redo = useCallback(() => {
    if (histIdx >= history.length - 1) return;
    setHistIdx(histIdx + 1);
    setShapes(history[histIdx + 1]);
    setSelectedId(null);
  }, [histIdx, history]);

  // ---- transformer attachment -------------------------------------------
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    if (!selectedId || editingTextId) {
      tr.nodes([]);
      return;
    }
    const node = stage.findOne(`#${selectedId}`);
    tr.nodes(node ? [node] : []);
    // corner handles only, except blur boxes where edge-resize is useful
    const shape = shapes.find((s) => s.id === selectedId);
    tr.enabledAnchors(
      shape?.type === "blur-rect"
        ? [
            "top-left", "top-right", "bottom-left", "bottom-right",
            "middle-left", "middle-right", "top-center", "bottom-center",
          ]
        : ["top-left", "top-right", "bottom-left", "bottom-right"]
    );
  }, [selectedId, shapes, editingTextId]);

  // ---- sliders -----------------------------------------------------------
  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null;

  const sliderValue = ((): number | null => {
    if (!img) return null;
    if (selectedShape) {
      if (selectedShape.type === "text")
        return fontVal(img.naturalWidth, selectedShape.fontSize);
      if (selectedShape.type === "blur-rect" || selectedShape.type === "blur-lasso")
        return selectedShape.intensity ?? DEFAULT_BLUR_INTENSITY;
      return strokeVal(img.naturalWidth, selectedShape.strokeWidth);
    }
    return tool ? (sliderVals[tool] ?? null) : null;
  })();

  const onSlider = useCallback(
    (v: number) => {
      if (!img) return;
      if (selectedShape) {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== selectedShape.id) return s;
            if (s.type === "text")
              return { ...s, fontSize: fontFor(img.naturalWidth, v) };
            if (s.type === "blur-rect" || s.type === "blur-lasso")
              return { ...s, intensity: v };
            return { ...s, strokeWidth: strokeFor(img.naturalWidth, v) };
          })
        );
      } else if (tool) {
        setSliderVals((sv) => ({ ...sv, [tool]: v }));
      }
    },
    [img, selectedShape, tool]
  );

  const onSliderCommit = useCallback(() => {
    if (selectedShape) commit(shapes);
  }, [selectedShape, shapes, commit]);

  const colorableContext =
    (selectedShape && COLORABLE.has(selectedShape.type)) ||
    (!selectedShape && tool != null && COLORABLE.has(tool));

  const onColor = useCallback(
    (c: string) => {
      setColor(c);
      if (selectedShape) {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== selectedShape.id) return s;
            if (s.type === "text") return { ...s, fill: c };
            if ("stroke" in s) return { ...s, stroke: c };
            return s;
          })
        );
      }
    },
    [selectedShape]
  );

  // ---- pointer drawing (empty-canvas only; shapes handle their own taps) --
  const stagePos = useCallback((): { x: number; y: number } | null => {
    // relative position honours the pinch-zoom/pan stage transform
    return stageRef.current?.getRelativePointerPosition() ?? null;
  }, []);

  // clamp so the photo always covers the viewport (no rubber void)
  const clampView = useCallback(
    (zoom: number, x: number, y: number) => {
      const w = img ? img.naturalWidth * fit : 0;
      const h = img ? img.naturalHeight * fit : 0;
      return {
        zoom,
        x: Math.min(0, Math.max(w - w * zoom, x)),
        y: Math.min(0, Math.max(h - h * zoom, y)),
      };
    },
    [img, fit]
  );

  const readPinch = useCallback((te: TouchEvent) => {
    const rect = stageRef.current?.container().getBoundingClientRect();
    if (!rect || te.touches.length < 2) return null;
    const a = te.touches[0];
    const b = te.touches[1];
    return {
      mid: {
        x: (a.clientX + b.clientX) / 2 - rect.left,
        y: (a.clientY + b.clientY) / 2 - rect.top,
      },
      dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    };
  }, []);

  // a second finger landing mid-draw aborts the draft cleanly
  const cancelActiveDraft = useCallback(() => {
    const draft = drawingRef.current;
    if (draft) {
      drawingRef.current = null;
      setShapes((prev) => prev.filter((s) => s.id !== draft.id));
    }
    const sid = strokeDrawRef.current;
    if (sid) {
      strokeDrawRef.current = null;
      setShapes((prev) =>
        prev
          .map((s) =>
            s.id === sid && (s.type === "pen" || s.type === "highlight")
              ? { ...s, strokes: s.strokes.slice(0, -1) }
              : s
          )
          .filter(
            (s) =>
              !(
                s.id === sid &&
                (s.type === "pen" || s.type === "highlight") &&
                s.strokes.length === 0
              )
          )
      );
    }
  }, []);

  const onStageWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const p = stageRef.current?.getPointerPosition();
      if (!p) return;
      setView((v) => {
        const nz = Math.min(
          8,
          Math.max(1, v.zoom * (e.evt.deltaY < 0 ? 1.12 : 1 / 1.12))
        );
        const qx = (p.x - v.x) / v.zoom;
        const qy = (p.y - v.y) / v.zoom;
        return clampView(nz, p.x - qx * nz, p.y - qy * nz);
      });
    },
    [clampView]
  );

  const onStagePointerDown = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      if (editingTextId) return;
      const te = e.evt as TouchEvent;
      if (te.touches && te.touches.length >= 2) {
        cancelActiveDraft();
        pinchRef.current = readPinch(te);
        return;
      }
      const pos = stagePos();
      if (!pos || !img) return;
      const onEmpty =
        e.target === e.target.getStage() || e.target.name() === "bg";
      if (!onEmpty) return; // tap/drag on a shape → selection & drag
      setSelectedId(null);
      if (tool == null) return; // no tool armed — gesture pans instead
      if (tool === "text") return; // text is placed via the toolbar button
      const w = img.naturalWidth;
      const strokeWidth = Math.max(2, strokeFor(w, sliderVals[tool] ?? 0.25));
      const intensity = sliderVals[tool] ?? DEFAULT_BLUR_INTENSITY;

      if (tool === "pen" || tool === "highlight") {
        // Strokes drawn in quick succession join one shape, so multi-
        // stroke marks ("T", arrows drawn by hand) move/resize as one.
        window.clearTimeout(strokeTimerRef.current);
        const openId = openStrokeIdRef.current;
        if (openId && openStrokeToolRef.current === tool) {
          strokeDrawRef.current = openId;
          setShapes((prev) =>
            prev.map((s) =>
              s.id === openId && (s.type === "pen" || s.type === "highlight")
                ? { ...s, strokes: [...s.strokes, [pos.x, pos.y]] }
                : s
            )
          );
        } else {
          if (openId) closeOpenStroke();
          const id = newId();
          const shape: Shape = {
            id,
            type: tool,
            strokes: [[pos.x, pos.y]],
            stroke: color,
            strokeWidth,
          };
          openStrokeIdRef.current = id;
          openStrokeToolRef.current = tool;
          setOpenStrokeId(id);
          strokeDrawRef.current = id;
          setShapes((s) => [...s, shape]);
        }
        return;
      }

      const base = { id: newId() };
      let draft: Shape | null = null;
      if (tool === "arrow")
        draft = { ...base, type: "arrow", points: [pos.x, pos.y, pos.x, pos.y], stroke: color, strokeWidth };
      else if (tool === "ellipse")
        draft = { ...base, type: "ellipse", x: pos.x, y: pos.y, radiusX: 1, radiusY: 1, rotation: 0, stroke: color, strokeWidth };
      else if (tool === "blur-rect")
        draft = { ...base, type: "blur-rect", x: pos.x, y: pos.y, width: 1, height: 1, intensity };
      else if (tool === "blur-lasso")
        draft = { ...base, type: "blur-lasso", points: [pos.x, pos.y], intensity };
      if (draft) {
        drawingRef.current = draft;
        setShapes((s) => [...s, draft]);
      }
    },
    [tool, color, stagePos, img, editingTextId, sliderVals, closeOpenStroke, cancelActiveDraft, readPinch]
  );

  const onStagePointerMove = useCallback((e?: Konva.KonvaEventObject<Event>) => {
    const te = e?.evt as TouchEvent | undefined;
    if (pinchRef.current && te?.touches && te.touches.length >= 2) {
      const next = readPinch(te);
      const prev = pinchRef.current;
      if (!next) return;
      setView((v) => {
        const nz = Math.min(8, Math.max(1, v.zoom * (next.dist / prev.dist)));
        const qx = (prev.mid.x - v.x) / v.zoom;
        const qy = (prev.mid.y - v.y) / v.zoom;
        return clampView(nz, next.mid.x - qx * nz, next.mid.y - qy * nz);
      });
      pinchRef.current = next;
      return;
    }
    const pos = stagePos();
    if (!pos) return;
    const strokeId = strokeDrawRef.current;
    if (strokeId) {
      setShapes((prev) =>
        prev.map((s) => {
          if (s.id !== strokeId || (s.type !== "pen" && s.type !== "highlight"))
            return s;
          const strokes = [...s.strokes];
          strokes[strokes.length - 1] = [
            ...strokes[strokes.length - 1],
            pos.x,
            pos.y,
          ];
          return { ...s, strokes };
        })
      );
      return;
    }
    const draft = drawingRef.current;
    if (!draft) return;
    setShapes((prev) =>
      prev.map((s) => {
        if (s.id !== draft.id) return s;
        if (s.type === "arrow")
          return { ...s, points: [s.points[0], s.points[1], pos.x, pos.y] };
        if (s.type === "ellipse") {
          return {
            ...s,
            radiusX: Math.abs(pos.x - s.x),
            radiusY: Math.abs(pos.y - s.y),
          };
        }
        if (s.type === "blur-lasso")
          return { ...s, points: [...s.points, pos.x, pos.y] };
        if (s.type === "blur-rect") {
          return { ...s, width: pos.x - s.x, height: pos.y - s.y };
        }
        return s;
      })
    );
  }, [stagePos, clampView, readPinch]);

  const onStagePointerUp = useCallback((e?: Konva.KonvaEventObject<Event>) => {
    const te = e?.evt as TouchEvent | undefined;
    if (pinchRef.current && (!te?.touches || te.touches.length < 2)) {
      pinchRef.current = null;
    }
    const strokeId = strokeDrawRef.current;
    if (strokeId) {
      strokeDrawRef.current = null;
      // drop degenerate strokes; keep the group open for more strokes
      setShapes((prev) =>
        prev
          .map((s) => {
            if (s.id !== strokeId || (s.type !== "pen" && s.type !== "highlight"))
              return s;
            const strokes = s.strokes.filter(
              (pts, i) => i < s.strokes.length - 1 || pts.length >= 6
            );
            return { ...s, strokes };
          })
          .filter((s) => {
            if (s.id !== strokeId) return true;
            if (s.type === "pen" || s.type === "highlight") {
              if (s.strokes.length === 0) {
                openStrokeIdRef.current = null;
                openStrokeToolRef.current = null;
                setOpenStrokeId(null);
                return false;
              }
            }
            return true;
          })
      );
      if (openStrokeIdRef.current) {
        window.clearTimeout(strokeTimerRef.current);
        strokeTimerRef.current = window.setTimeout(
          closeOpenStroke,
          STROKE_GROUP_MS
        );
      }
      return;
    }

    const draft = drawingRef.current;
    if (!draft) return;
    drawingRef.current = null;
    setShapes((prev) => {
      const next = prev
        .map((s) => {
          if (s.id !== draft.id) return s;
          if (s.type === "blur-rect") {
            const x = Math.min(s.x, s.x + s.width);
            const y = Math.min(s.y, s.y + s.height);
            return { ...s, x, y, width: Math.abs(s.width), height: Math.abs(s.height) };
          }
          return s;
        })
        .filter((s) => {
          if (s.id !== draft.id) return true;
          if (s.type === "blur-rect") return s.width > 4 && s.height > 4;
          if (s.type === "ellipse") return s.radiusX > 3 || s.radiusY > 3;
          if (s.type === "arrow") {
            const [x1, y1, x2, y2] = s.points;
            return Math.hypot(x2 - x1, y2 - y1) > 6;
          }
          if (s.type === "blur-lasso") return s.points.length >= 6;
          return true;
        });
      setHistory((h) => [...h.slice(0, histIdx + 1), next]);
      setHistIdx((i) => i + 1);
      return next;
    });
  }, [histIdx, closeOpenStroke]);

  // ---- shape updates from drag/transform ------------------------------------
  const updateShape = useCallback(
    (sid: string, patch: Partial<Shape>) => {
      commit(
        shapes.map((s) => (s.id === sid ? ({ ...s, ...patch } as Shape) : s))
      );
    },
    [shapes, commit]
  );

  const onTransformEnd = useCallback(
    (sid: string, node: Konva.Node) => {
      const sx = node.scaleX();
      const sy = node.scaleY();
      node.scaleX(1);
      node.scaleY(1);
      const s = shapes.find((x) => x.id === sid);
      if (!s) return;
      if (s.type === "ellipse") {
        updateShape(sid, {
          x: node.x(),
          y: node.y(),
          radiusX: Math.max(2, s.radiusX * sx),
          radiusY: Math.max(2, s.radiusY * sy),
          rotation: node.rotation(),
        } as Partial<Shape>);
      } else if (s.type === "blur-rect") {
        updateShape(sid, {
          x: node.x(),
          y: node.y(),
          width: Math.max(4, s.width * sx),
          height: Math.max(4, s.height * sy),
        } as Partial<Shape>);
        node.rotation(0);
      } else if (s.type === "text") {
        updateShape(sid, {
          x: node.x(),
          y: node.y(),
          fontSize: Math.max(8, s.fontSize * sy),
          rotation: node.rotation(),
        } as Partial<Shape>);
      } else if (s.type === "arrow" || s.type === "blur-lasso") {
        const scaled = s.points.map((v, i) =>
          i % 2 === 0 ? v * sx + node.x() : v * sy + node.y()
        );
        node.x(0);
        node.y(0);
        node.rotation(0);
        updateShape(sid, { points: scaled } as Partial<Shape>);
      } else if (s.type === "pen" || s.type === "highlight") {
        const scaled = s.strokes.map((pts) =>
          pts.map((v, i) => (i % 2 === 0 ? v * sx + node.x() : v * sy + node.y()))
        );
        node.x(0);
        node.y(0);
        node.rotation(0);
        updateShape(sid, { strokes: scaled } as Partial<Shape>);
      }
    },
    [shapes, updateShape]
  );

  const onDragEnd = useCallback(
    (sid: string, node: Konva.Node) => {
      const s = shapes.find((x) => x.id === sid);
      if (!s) return;
      if (s.type === "arrow" || s.type === "blur-lasso") {
        const dx = node.x();
        const dy = node.y();
        node.x(0);
        node.y(0);
        const pts = (s.points as number[]).map((v, i) =>
          i % 2 === 0 ? v + dx : v + dy
        );
        updateShape(sid, { points: pts } as Partial<Shape>);
      } else if (s.type === "pen" || s.type === "highlight") {
        const dx = node.x();
        const dy = node.y();
        node.x(0);
        node.y(0);
        updateShape(sid, {
          strokes: s.strokes.map((pts) =>
            pts.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
          ),
        } as Partial<Shape>);
      } else {
        updateShape(sid, { x: node.x(), y: node.y() } as Partial<Shape>);
      }
    },
    [shapes, updateShape]
  );

  // ---- text: Telegram-style inline editing -----------------------------------
  const startNewText = useCallback(() => {
    if (!img) return;
    const wrap = wrapRef.current;
    const cx = img.naturalWidth / 2;
    const cy = wrap
      ? Math.min(img.naturalHeight / 2, (wrap.clientHeight / fit) * 0.4)
      : img.naturalHeight / 2;
    const shape: Shape = {
      id: newId(),
      type: "text",
      x: cx,
      y: cy,
      text: "",
      fontSize: fontFor(img.naturalWidth, sliderVals.text),
      fill: color,
      rotation: 0,
      fontFamily: textFont,
      bgStyle: textBg,
      align: textAlign,
    };
    setShapes((s) => [...s, shape]);
    setSelectedId(shape.id);
    setEditingTextId(shape.id);
  }, [img, fit, color, sliderVals, textFont, textBg, textAlign]);

  const finishTextEdit = useCallback(() => {
    if (!editingTextId) return;
    const shape = shapes.find((s) => s.id === editingTextId);
    setEditingTextId(null);
    if (shape && shape.type === "text") {
      if (!shape.text.trim()) {
        commit(shapes.filter((s) => s.id !== editingTextId));
        setSelectedId(null);
      } else {
        // center the committed text on its anchor for predictable placement
        commit(shapes);
      }
    }
  }, [editingTextId, shapes, commit]);

  const editingShape =
    (editingTextId &&
      (shapes.find((s) => s.id === editingTextId) as Extract<
        Shape,
        { type: "text" }
      > | undefined)) ||
    null;

  // ---- auto-detect faces ---------------------------------------------------
  const autoBlur = useCallback(async () => {
    if (!img || busy) return;
    setBusy(true);
    try {
      const boxes = await detectFaces(img);
      if (boxes === null) {
        showNote("Face detector unavailable on this device");
        return;
      }
      if (!boxes.length) {
        showNote("No faces found — draw blur regions manually");
        return;
      }
      const intensity = sliderVals["blur-rect"] ?? DEFAULT_BLUR_INTENSITY;
      const padded: Shape[] = boxes.map((b) => {
        const padX = b.width * 0.15;
        const padY = b.height * 0.2;
        return {
          id: newId(),
          type: "blur-rect",
          x: Math.max(0, b.x - padX),
          y: Math.max(0, b.y - padY),
          width: b.width + padX * 2,
          height: b.height + padY * 2,
          auto: true,
          intensity,
        };
      });
      commit([...shapes, ...padded]);
      showNote(
        `${boxes.length} face${boxes.length > 1 ? "s" : ""} blurred — review before sharing. Plates: manual blur.`,
        4500
      );
    } finally {
      setBusy(false);
    }
  }, [img, busy, shapes, commit, showNote, sliderVals]);

  // ---- save (flatten onto a copy) ---------------------------------------------
  const save = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || !rec || !img) return;
    closeOpenStroke();
    setBusy(true);
    setSelectedId(null);
    setEditingTextId(null);
    await new Promise((r) => setTimeout(r, 60)); // let transformer detach
    try {
      // flatten at the un-zoomed transform — the export must always be
      // the full photo, whatever the viewport was pinched to
      stage.scale({ x: fit, y: fit });
      stage.position({ x: 0, y: 0 });
      setView({ zoom: 1, x: 0, y: 0 });
      const canvas = stage.toCanvas({ pixelRatio: 1 / fit });
      const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const withExif = await writeExif(jpeg, rec.data);
      const thumb = await makeThumbnail(canvas, canvas.width, canvas.height);
      const copy: PhotoRecord = {
        ...rec,
        id: newId(),
        createdAt: Date.now(),
        backfill: "not-needed",
        hasRaw: false,
        annotatedFrom: rec.id,
      };
      await putBlob(copy.id, "final", withExif);
      await putBlob(copy.id, "thumb", thumb);
      await putMedia(copy);
      if (useSettingsStore.getState().settings.autoSaveToDevice) {
        try {
          downloadBlob(
            withExif,
            suggestedName("photo", copy.createdAt, "image/jpeg")
          );
        } catch {
          // download blocked — in-app copy is already saved
        }
      }
      navigate(`/media/${copy.id}`);
    } finally {
      setBusy(false);
    }
  }, [rec, img, fit, closeOpenStroke]);

  const onTrash = useCallback(() => {
    closeOpenStroke();
    if (selectedId) {
      commit(shapes.filter((s) => s.id !== selectedId));
      setSelectedId(null);
      setEditingTextId(null);
    } else if (shapes.length) {
      commit([]);
    }
  }, [selectedId, shapes, commit, closeOpenStroke]);

  const stageW = img ? img.naturalWidth * fit : 0;
  const stageH = img ? img.naturalHeight * fit : 0;
  const blurActive = tool === "blur-rect" || tool === "blur-lasso";

  const tools: ToolDef[] = [
    { key: "pen", icon: <Pen size={19} />, label: "Pen" },
    { key: "highlight", icon: <Highlighter size={19} />, label: "Highlighter" },
    { key: "arrow", icon: <ArrowUpRight size={19} />, label: "Arrow" },
    { key: "ellipse", icon: <Circle size={19} />, label: "Circle" },
    { key: "text", icon: <Type size={19} />, label: "Text" },
    {
      key: "blur",
      icon: <PixelateIcon size={19} />,
      label: "Blur & redact",
      kind: "toggle",
      active: blurActive || blurMenuOpen,
    },
  ];

  const textContext =
    tool === "text" || (selectedShape && selectedShape.type === "text");

  return (
    <div className="editor-screen">
      <div ref={wrapRef} className="editor-stage-wrap">
        {note && <div className="editor-note">{note}</div>}
        {img && (
          <Stage
            ref={stageRef}
            width={stageW}
            height={stageH}
            scaleX={fit * view.zoom}
            scaleY={fit * view.zoom}
            x={view.x}
            y={view.y}
            draggable={tool == null && !editingTextId}
            dragBoundFunc={(pos) => {
              const z = viewRef.current.zoom;
              return {
                x: Math.min(0, Math.max(stageW - stageW * z, pos.x)),
                y: Math.min(0, Math.max(stageH - stageH * z, pos.y)),
              };
            }}
            onDragEnd={(e) => {
              if (e.target === e.target.getStage()) {
                const st = e.target;
                setView((v) => ({ ...v, x: st.x(), y: st.y() }));
              }
            }}
            onWheel={onStageWheel}
            onMouseDown={onStagePointerDown}
            onTouchStart={onStagePointerDown}
            onMouseMove={onStagePointerMove}
            onTouchMove={onStagePointerMove}
            onMouseUp={onStagePointerUp}
            onTouchEnd={onStagePointerUp}
          >
            <Layer>
              <KImage image={img} name="bg" />
              {shapes.map((s) => {
                // Direct manipulation: every placed shape is always
                // tappable + draggable, whatever tool is active.
                const common = {
                  id: s.id,
                  draggable: true,
                  onClick: () => setSelectedId(s.id),
                  onTap: () => setSelectedId(s.id),
                  onDragStart: () => setSelectedId(s.id),
                  onDragEnd: (e: Konva.KonvaEventObject<Event>) =>
                    onDragEnd(s.id, e.target),
                  onTransformEnd: (e: Konva.KonvaEventObject<Event>) =>
                    onTransformEnd(s.id, e.target),
                };
                if (s.type === "blur-rect") {
                  const mosaic = getMosaic(blocksFor(s.intensity));
                  if (!mosaic) return null;
                  return (
                    <KImage
                      key={s.id}
                      {...common}
                      image={mosaic}
                      x={s.x}
                      y={s.y}
                      width={s.width}
                      height={s.height}
                      crop={{ x: s.x, y: s.y, width: s.width, height: s.height }}
                      stroke={selectedId === s.id ? "#38bdf8" : undefined}
                      strokeWidth={selectedId === s.id ? 2 / fit : 0}
                    />
                  );
                }
                if (s.type === "blur-lasso") {
                  const mosaic = getMosaic(blocksFor(s.intensity));
                  if (!mosaic) return null;
                  return (
                    <KLine
                      key={s.id}
                      {...common}
                      points={s.points}
                      closed
                      // Konva types say HTMLImageElement but a canvas works
                      fillPatternImage={mosaic as unknown as HTMLImageElement}
                      fillPatternRepeat="no-repeat"
                      stroke={selectedId === s.id ? "#38bdf8" : "rgba(255,255,255,0.35)"}
                      strokeWidth={2 / fit}
                    />
                  );
                }
                if (s.type === "arrow") {
                  return (
                    <KArrow
                      key={s.id}
                      {...common}
                      points={s.points}
                      stroke={s.stroke}
                      fill={s.stroke}
                      strokeWidth={s.strokeWidth}
                      pointerLength={s.strokeWidth * 3}
                      pointerWidth={s.strokeWidth * 3}
                      hitStrokeWidth={Math.max(20, s.strokeWidth * 3)}
                    />
                  );
                }
                if (s.type === "ellipse") {
                  return (
                    <KEllipse
                      key={s.id}
                      {...common}
                      x={s.x}
                      y={s.y}
                      radiusX={s.radiusX}
                      radiusY={s.radiusY}
                      rotation={s.rotation}
                      stroke={s.stroke}
                      strokeWidth={s.strokeWidth}
                      hitStrokeWidth={Math.max(20, s.strokeWidth * 3)}
                    />
                  );
                }
                if (s.type === "pen" || s.type === "highlight") {
                  // Open groups don't listen, so the next stroke can start
                  // on top of the previous one instead of selecting it.
                  return (
                    <KGroup
                      key={s.id}
                      {...common}
                      listening={openStrokeId !== s.id}
                      opacity={s.type === "highlight" ? 0.45 : 1}
                    >
                      {s.strokes.map((pts, i) => (
                        <KLine
                          key={i}
                          points={pts}
                          stroke={s.stroke}
                          strokeWidth={s.strokeWidth}
                          lineCap="round"
                          lineJoin="round"
                          hitStrokeWidth={Math.max(24, s.strokeWidth * 2)}
                        />
                      ))}
                    </KGroup>
                  );
                }
                if (s.type === "text") {
                  const family = s.fontFamily ?? "Roboto";
                  const isEditing = editingTextId === s.id;
                  if (s.bgStyle === "chip") {
                    return (
                      <KLabel
                        key={s.id}
                        {...common}
                        x={s.x}
                        y={s.y}
                        rotation={s.rotation}
                        visible={!isEditing}
                        onDblClick={() => setEditingTextId(s.id)}
                        onDblTap={() => setEditingTextId(s.id)}
                      >
                        <KTag fill={s.fill} cornerRadius={s.fontSize * 0.35} />
                        <KText
                          text={s.text}
                          fontSize={s.fontSize}
                          fontFamily={family}
                          fontStyle="500"
                          fill={contrastOn(s.fill)}
                          align={s.align ?? "center"}
                          padding={s.fontSize * 0.35}
                        />
                      </KLabel>
                    );
                  }
                  return (
                    <KText
                      key={s.id}
                      {...common}
                      x={s.x}
                      y={s.y}
                      text={s.text}
                      fontSize={s.fontSize}
                      fontFamily={family}
                      fill={s.fill}
                      rotation={s.rotation}
                      fontStyle="500"
                      align={s.align ?? "center"}
                      visible={!isEditing}
                      shadowColor="rgba(0,0,0,0.7)"
                      shadowBlur={s.fontSize / 6}
                      onDblClick={() => setEditingTextId(s.id)}
                      onDblTap={() => setEditingTextId(s.id)}
                    />
                  );
                }
                return null;
              })}
              {/* Telegram-style selection: round handles pushed OUTSIDE
                  the object on a dashed frame, rotate handle further out */}
              <Transformer
                ref={trRef}
                rotateEnabled
                flipEnabled={false}
                anchorSize={15}
                anchorCornerRadius={8}
                anchorStroke="#38bdf8"
                anchorFill="#ffffff"
                anchorStrokeWidth={2}
                borderStroke="rgba(255,255,255,0.9)"
                borderDash={[5, 4]}
                padding={12}
                rotateAnchorOffset={30}
              />
            </Layer>
          </Stage>
        )}

        {showCoach && (
          <CoachOverlay
            items={[
              { icon: <ZoomIn size={17} />, label: "Pinch to zoom — drag to pan while no tool is active" },
              { icon: <Pen size={17} />, label: "Pen — draw freehand" },
              { icon: <Highlighter size={17} />, label: "Highlighter" },
              { icon: <ArrowUpRight size={17} />, label: "Arrow" },
              { icon: <Circle size={17} />, label: "Circle" },
              { icon: <Type size={17} />, label: "Add text" },
              { icon: <PixelateIcon size={17} />, label: "Blur & redact" },
            ]}
            onDone={() => {
              setShowCoach(false);
              void kvSet("coach-photo-editor", true);
            }}
          />
        )}

        {sliderValue != null && !editingShape && (
          <IntensitySlider
            value={sliderValue}
            onChange={onSlider}
            onCommit={onSliderCommit}
          />
        )}
        {colorableContext && !editingShape && (
          <ColorSlider color={color} onChange={onColor} />
        )}

        {editingShape && (
          <div className="text-edit-scrim" onClick={finishTextEdit}>
            <textarea
              className="text-edit-box"
              autoFocus
              placeholder="Add text"
              value={editingShape.text}
              rows={Math.max(1, editingShape.text.split("\n").length)}
              style={{
                fontFamily: `"${editingShape.fontFamily ?? "Roboto"}", system-ui, sans-serif`,
                textAlign: editingShape.align ?? "center",
                color:
                  editingShape.bgStyle === "chip"
                    ? contrastOn(editingShape.fill)
                    : editingShape.fill,
                background:
                  editingShape.bgStyle === "chip" ? editingShape.fill : "transparent",
              }}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                setShapes((prev) =>
                  prev.map((s) =>
                    s.id === editingShape.id ? { ...s, text: e.target.value } : s
                  )
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  finishTextEdit();
                }
              }}
            />
            <button className="primary-btn text-edit-done" onClick={finishTextEdit}>
              Done
            </button>
          </div>
        )}

        <EditorTopBar
          onCancel={goBack}
          onUndo={undo}
          canUndo={histIdx > 0}
          onRedo={redo}
          canRedo={histIdx < history.length - 1}
          onTrash={onTrash}
          trashDisabled={!selectedId && shapes.length === 0}
          onSave={() => void save()}
          saving={busy}
        />
      </div>

      <div className="editor-bottom" style={{ position: "relative" }}>
        {blurMenuOpen && (
          <PopMenu
            items={[
              { key: "blur-rect", icon: <Square size={17} />, label: "Blur box", active: tool === "blur-rect" },
              { key: "blur-lasso", icon: <Lasso size={17} />, label: "Freehand blur", active: tool === "blur-lasso" },
              { key: "face", icon: <ScanFace size={17} />, label: "Auto-blur faces" },
            ]}
            onPick={(key) => {
              setBlurMenuOpen(false);
              if (key === "face") void autoBlur();
              else {
                setTool(key as Tool);
                setSelectedId(null);
              }
            }}
            onClose={() => setBlurMenuOpen(false)}
          />
        )}

        {fontMenuOpen && (
          <PopMenu
            items={TEXT_FONTS.map((f) => ({
              key: f,
              icon: <Type size={15} />,
              label: <span style={{ fontFamily: `"${f}", sans-serif` }}>{f}</span>,
              active:
                (selectedShape?.type === "text"
                  ? (selectedShape.fontFamily ?? "Roboto")
                  : textFont) === f,
            }))}
            onPick={(f) => {
              setFontMenuOpen(false);
              setTextFont(f);
              void document.fonts.load(`16px "${f}"`).then(() => {
                if (selectedShape?.type === "text") {
                  updateShape(selectedShape.id, { fontFamily: f } as Partial<Shape>);
                }
              });
            }}
            onClose={() => setFontMenuOpen(false)}
          />
        )}

        {textContext && (
          <div className="option-row">
            <button
              className="font-pill icon-pill"
              aria-label="Text alignment"
              onClick={() => {
                const current =
                  selectedShape?.type === "text"
                    ? (selectedShape.align ?? "center")
                    : textAlign;
                const next =
                  ALIGN_ORDER[(ALIGN_ORDER.indexOf(current) + 1) % ALIGN_ORDER.length];
                setTextAlign(next);
                if (selectedShape?.type === "text") {
                  updateShape(selectedShape.id, { align: next } as Partial<Shape>);
                }
              }}
            >
              {(selectedShape?.type === "text"
                ? (selectedShape.align ?? "center")
                : textAlign) === "left" ? (
                <AlignLeft size={17} />
              ) : (selectedShape?.type === "text"
                  ? (selectedShape.align ?? "center")
                  : textAlign) === "right" ? (
                <AlignRight size={17} />
              ) : (
                <AlignCenter size={17} />
              )}
            </button>
            <button
              className="font-pill chip-toggle"
              data-active={
                (selectedShape?.type === "text"
                  ? (selectedShape.bgStyle ?? "none")
                  : textBg) === "chip"
              }
              onClick={() => {
                const current =
                  selectedShape?.type === "text"
                    ? (selectedShape.bgStyle ?? "none")
                    : textBg;
                const next = current === "chip" ? "none" : "chip";
                setTextBg(next);
                if (selectedShape?.type === "text") {
                  updateShape(selectedShape.id, { bgStyle: next } as Partial<Shape>);
                }
              }}
            >
              A
            </button>
            <button
              className="font-pill icon-pill"
              aria-label="Add another text"
              onClick={startNewText}
            >
              <Plus size={17} />
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="font-pill"
              aria-label="Font"
              style={{
                fontFamily: `"${
                  selectedShape?.type === "text"
                    ? (selectedShape.fontFamily ?? "Roboto")
                    : textFont
                }", sans-serif`,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
              onClick={() => setFontMenuOpen((o) => !o)}
            >
              {selectedShape?.type === "text"
                ? (selectedShape.fontFamily ?? "Roboto")
                : textFont}
              <ChevronUp size={14} />
            </button>
          </div>
        )}

        <ToolRow
          tools={tools}
          activeTool={tool}
          onTool={(key) => {
            closeOpenStroke();
            if (key === "blur") {
              setBlurMenuOpen((o) => !o);
              return;
            }
            setBlurMenuOpen(false);
            setFontMenuOpen(false);
            if (key === "text") {
              setTool("text");
              startNewText();
              return;
            }
            // tapping the active tool disarms it — back to pan/zoom mode
            if (key === tool) {
              setTool(null);
              return;
            }
            setTool(key as Tool);
            setSelectedId(null);
          }}
        />
      </div>
    </div>
  );
}
