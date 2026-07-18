import { useCallback, useEffect, useRef, useState } from "react";
import {
  Stage,
  Layer,
  Group as KGroup,
  Rect as KRect,
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
  ScanFace,
  Crop as CropIcon,
  Play,
  Pause,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Plus,
  ChevronUp,
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
import { navigate, goBack } from "../nav";
import type { VideoRecord } from "../types";
import {
  drawMarkupShapes,
  contrastOn,
  MARK_COLORS,
  TEXT_FONTS,
  DEFAULT_BLUR_INTENSITY,
  type Shape,
} from "../lib/editor/shapes";
import { exportVideo, type CropRect } from "../lib/video/export";
import { useSettingsStore } from "../store";
import { isNativeApp } from "../lib/native";
import { downloadBlob, suggestedName } from "../lib/share";

type VTool =
  | "pen"
  | "arrow"
  | "ellipse"
  | "highlight"
  | "text"
  | "blur-rect"
  | "crop";

const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: "Free", ratio: null },
  { label: "1:1", ratio: 1 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
  { label: "4:3", ratio: 4 / 3 },
];

const strokeFor = (w: number, v: number) => w * (0.002 + 0.028 * v);
const strokeVal = (w: number, sw: number) =>
  Math.min(1, Math.max(0, (sw / w - 0.002) / 0.028));
const fontFor = (w: number, v: number) => w * (0.015 + 0.085 * v);
const fontVal = (w: number, fs: number) =>
  Math.min(1, Math.max(0, (fs / w - 0.015) / 0.085));

const DEFAULT_SLIDER: Record<string, number> = {
  pen: 0.3,
  arrow: 0.25,
  ellipse: 0.25,
  highlight: 0.55,
  text: 0.35,
  "blur-rect": DEFAULT_BLUR_INTENSITY,
};

const COLORABLE = new Set(["pen", "arrow", "ellipse", "highlight", "text"]);

/** Strokes drawn within this window merge into one selectable shape. */
const STROKE_GROUP_MS = 2000;

const ALIGN_ORDER = ["left", "center", "right"] as const;

export default function VideoEditorView({ id }: { id: string }) {
  const [rec, setRec] = useState<VideoRecord | null>(null);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [srcBlob, setSrcBlob] = useState<Blob | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fit, setFit] = useState(1);
  const [duration, setDuration] = useState(0);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  // No default tool — users pick one deliberately before drawing.
  const [tool, setTool] = useState<VTool | null>(null);
  const [color, setColor] = useState(MARK_COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [history, setHistory] = useState<Shape[][]>([[]]);
  const [histIdx, setHistIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [autoBlur, setAutoBlur] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sliderVals, setSliderVals] = useState({ ...DEFAULT_SLIDER });
  const [blurMenuOpen, setBlurMenuOpen] = useState(false);
  const [fontMenuOpen, setFontMenuOpen] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textFont, setTextFont] = useState(TEXT_FONTS[0]);
  const [textBg, setTextBg] = useState<"none" | "chip">("none");
  const [textAlign, setTextAlign] = useState<"left" | "center" | "right">("center");
  const [openStrokeId, setOpenStrokeId] = useState<string | null>(null);
  const [showCoach, setShowCoach] = useState(false);

  useEffect(() => {
    void kvGet<boolean>("coach-video-editor").then((seen) => {
      if (!seen) setShowCoach(true);
    });
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const drawingRef = useRef<Shape | null>(null);
  const strokeDrawRef = useRef<string | null>(null);
  const strokeTimerRef = useRef<number>(0);
  const openStrokeIdRef = useRef<string | null>(null);
  const openStrokeToolRef = useRef<"pen" | "highlight" | null>(null);
  const histIdxRef = useRef(0);
  const shapesRef = useRef<Shape[]>([]);
  const trimBarRef = useRef<HTMLDivElement>(null);

  const showNote = useCallback((msg: string, ms = 3200) => {
    setNote(msg);
    window.setTimeout(() => setNote((n) => (n === msg ? null : n)), ms);
  }, []);

  // ---- history ------------------------------------------------------------
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

  /** Seal the open pen/highlight stroke group (one shape, one history entry). */
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

  // ---- load --------------------------------------------------------------
  useEffect(() => {
    let url: string | null = null;
    void (async () => {
      const r = await getMedia(id);
      if (!r || r.kind !== "video") {
        navigate("/gallery");
        return;
      }
      setRec(r);
      // recorded with live blur but the blur is NOT in the file (older
      // recordings) → pre-arm auto face blur; blurBurned files are
      // already blurred on disk, nothing to arm
      if (r.liveBlur && !r.blurBurned) setAutoBlur(true);
      const blob = await getBlob(id, "source");
      if (!blob) return;
      setSrcBlob(blob);
      url = URL.createObjectURL(blob);
      setSrcUrl(url);
    })();
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  const onMeta = useCallback(() => {
    const v = videoRef.current;
    if (!v || !rec) return;
    // Chrome reports Infinity for MediaRecorder webm blobs — fall back to
    // the duration measured at record time.
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : rec.duration;
    setDuration(d);
    setTrim([0, d]);
    setDims({ w: v.videoWidth, h: v.videoHeight });
  }, [rec]);

  // ---- fit ------------------------------------------------------------------
  useEffect(() => {
    if (!dims) return;
    const compute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // leave a small margin so a full-height portrait clip (whose burned
      // watermark sits at the very bottom) never abuts the toolbar
      const availW = wrap.clientWidth - 8;
      const availH = wrap.clientHeight - 16;
      setFit(Math.min(availW / dims.w, availH / dims.h) || 1);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [dims]);

  // ---- playback within trim window ---------------------------------------------
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setPlayhead(v.currentTime);
      if (v.currentTime >= trim[1]) {
        v.currentTime = trim[0];
        if (!v.paused) void v.play();
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [trim]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < trim[0] || v.currentTime >= trim[1]) {
        v.currentTime = trim[0];
      }
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, [trim]);

  // ---- trim handles -----------------------------------------------------------
  const dragTrim = useCallback(
    (which: "left" | "right") => (e: React.PointerEvent) => {
      e.preventDefault();
      const bar = trimBarRef.current;
      const v = videoRef.current;
      if (!bar || !duration) return;
      const rect = bar.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
        const t = frac * duration;
        setTrim(([a, b]) =>
          which === "left"
            ? [Math.min(t, b - 0.2), b]
            : [a, Math.max(t, a + 0.2)]
        );
        if (v) v.currentTime = t;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [duration]
  );

  // ---- sliders ---------------------------------------------------------------
  const selectedShape = shapes.find((s) => s.id === selectedId) ?? null;

  const sliderValue = ((): number | null => {
    if (!dims || tool === "crop") return null;
    if (selectedShape) {
      if (selectedShape.type === "text")
        return fontVal(dims.w, selectedShape.fontSize);
      if (selectedShape.type === "blur-rect" || selectedShape.type === "blur-lasso")
        return selectedShape.intensity ?? DEFAULT_BLUR_INTENSITY;
      return strokeVal(dims.w, selectedShape.strokeWidth);
    }
    return tool ? (sliderVals[tool] ?? null) : null;
  })();

  const onSlider = useCallback(
    (v: number) => {
      if (!dims) return;
      if (selectedShape) {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== selectedShape.id) return s;
            if (s.type === "text") return { ...s, fontSize: fontFor(dims.w, v) };
            if (s.type === "blur-rect" || s.type === "blur-lasso")
              return { ...s, intensity: v };
            return { ...s, strokeWidth: strokeFor(dims.w, v) };
          })
        );
      } else if (tool) {
        setSliderVals((sv) => ({ ...sv, [tool]: v }));
      }
    },
    [dims, selectedShape, tool]
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

  // ---- shapes: draw interactions ------------------------------------------------
  const stagePos = useCallback((): { x: number; y: number } | null => {
    const p = stageRef.current?.getPointerPosition();
    return p ? { x: p.x / fit, y: p.y / fit } : null;
  }, [fit]);

  const onStageDown = useCallback(
    (e: Konva.KonvaEventObject<Event>) => {
      if (editingTextId) return;
      const pos = stagePos();
      if (!pos || !dims) return;
      const onEmpty = e.target === e.target.getStage();
      if (!onEmpty) return; // shapes handle their own selection/drag
      setSelectedId(null);
      if (tool == null || tool === "crop" || tool === "text") return;
      const strokeWidth = Math.max(2, strokeFor(dims.w, sliderVals[tool] ?? 0.25));

      if (tool === "pen" || tool === "highlight") {
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

      let draft: Shape | null = null;
      const base = { id: newId() };
      if (tool === "arrow")
        draft = { ...base, type: "arrow", points: [pos.x, pos.y, pos.x, pos.y], stroke: color, strokeWidth };
      else if (tool === "ellipse")
        draft = { ...base, type: "ellipse", x: pos.x, y: pos.y, radiusX: 1, radiusY: 1, rotation: 0, stroke: color, strokeWidth };
      else if (tool === "blur-rect")
        draft = {
          ...base,
          type: "blur-rect",
          x: pos.x,
          y: pos.y,
          width: 1,
          height: 1,
          intensity: sliderVals["blur-rect"] ?? DEFAULT_BLUR_INTENSITY,
        };
      if (draft) {
        drawingRef.current = draft;
        setShapes((s) => [...s, draft]);
      }
    },
    [tool, color, stagePos, dims, sliderVals, editingTextId, closeOpenStroke]
  );

  const onStageMove = useCallback(() => {
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
        if (s.type === "ellipse")
          return { ...s, radiusX: Math.abs(pos.x - s.x), radiusY: Math.abs(pos.y - s.y) };
        if (s.type === "blur-rect")
          return { ...s, width: pos.x - s.x, height: pos.y - s.y };
        return s;
      })
    );
  }, [stagePos]);

  const onStageUp = useCallback(() => {
    const strokeId = strokeDrawRef.current;
    if (strokeId) {
      strokeDrawRef.current = null;
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
          if (s.id !== draft.id || s.type !== "blur-rect") return s;
          const x = Math.min(s.x, s.x + s.width);
          const y = Math.min(s.y, s.y + s.height);
          return { ...s, x, y, width: Math.abs(s.width), height: Math.abs(s.height) };
        })
        .filter((s) => {
          if (s.id !== draft.id) return true;
          if (s.type === "blur-rect") return s.width > 4 && s.height > 4;
          if (s.type === "ellipse") return s.radiusX > 3 || s.radiusY > 3;
          if (s.type === "arrow") {
            const [x1, y1, x2, y2] = s.points;
            return Math.hypot(x2 - x1, y2 - y1) > 6;
          }
          return true;
        });
      setHistory((h) => [...h.slice(0, histIdx + 1), next]);
      setHistIdx((i) => i + 1);
      return next;
    });
  }, [histIdx, closeOpenStroke]);

  const updateShape = useCallback(
    (sid: string, patch: Partial<Shape>) => {
      commit(
        shapes.map((s) => (s.id === sid ? ({ ...s, ...patch } as Shape) : s))
      );
    },
    [shapes, commit]
  );

  const onDragEnd = useCallback(
    (sid: string, node: Konva.Node) => {
      const s = shapes.find((x) => x.id === sid);
      if (!s) return;
      if (s.type === "arrow") {
        const dx = node.x();
        const dy = node.y();
        node.x(0);
        node.y(0);
        updateShape(sid, {
          points: s.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)),
        } as Partial<Shape>);
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
          x: node.x(), y: node.y(),
          radiusX: Math.max(2, s.radiusX * sx),
          radiusY: Math.max(2, s.radiusY * sy),
          rotation: node.rotation(),
        } as Partial<Shape>);
      } else if (s.type === "blur-rect") {
        node.rotation(0);
        updateShape(sid, {
          x: node.x(), y: node.y(),
          width: Math.max(4, s.width * sx),
          height: Math.max(4, s.height * sy),
        } as Partial<Shape>);
      } else if (s.type === "text") {
        updateShape(sid, {
          x: node.x(), y: node.y(),
          fontSize: Math.max(8, s.fontSize * sy),
          rotation: node.rotation(),
        } as Partial<Shape>);
      } else if (s.type === "arrow") {
        const pts = s.points.map((v, i) =>
          i % 2 === 0 ? v * sx + node.x() : v * sy + node.y()
        );
        node.x(0);
        node.y(0);
        node.rotation(0);
        updateShape(sid, { points: pts } as Partial<Shape>);
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

  // transformer attach (shapes + crop rect)
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const target = tool === "crop" ? "crop-rect" : editingTextId ? null : selectedId;
    const node = target ? stage.findOne(`#${target}`) : null;
    tr.nodes(node ? [node] : []);
    tr.keepRatio(false);
    // corner handles only, except blur boxes / crop where edges help
    const shape = shapes.find((s) => s.id === selectedId);
    const withEdges = tool === "crop" || shape?.type === "blur-rect";
    tr.enabledAnchors(
      withEdges
        ? [
            "top-left", "top-right", "bottom-left", "bottom-right",
            "middle-left", "middle-right", "top-center", "bottom-center",
          ]
        : ["top-left", "top-right", "bottom-left", "bottom-right"]
    );
  }, [selectedId, shapes, tool, crop, editingTextId]);

  const applyAspect = useCallback(
    (ratio: number | null) => {
      if (!dims) return;
      if (ratio === null) {
        setCrop({ x: 0, y: 0, width: dims.w, height: dims.h });
        return;
      }
      let w = dims.w;
      let h = w / ratio;
      if (h > dims.h) {
        h = dims.h;
        w = h * ratio;
      }
      setCrop({
        x: Math.round((dims.w - w) / 2),
        y: Math.round((dims.h - h) / 2),
        width: Math.round(w),
        height: Math.round(h),
      });
    },
    [dims]
  );

  // ---- text: inline editing -------------------------------------------------
  const startNewText = useCallback(() => {
    if (!dims) return;
    const shape: Shape = {
      id: newId(),
      type: "text",
      x: dims.w / 2,
      y: dims.h * 0.4,
      text: "",
      fontSize: fontFor(dims.w, sliderVals.text),
      fill: color,
      rotation: 0,
      fontFamily: textFont,
      bgStyle: textBg,
      align: textAlign,
    };
    setShapes((s) => [...s, shape]);
    setSelectedId(shape.id);
    setEditingTextId(shape.id);
  }, [dims, color, sliderVals, textFont, textBg, textAlign]);

  const finishTextEdit = useCallback(() => {
    if (!editingTextId) return;
    const shape = shapes.find((s) => s.id === editingTextId);
    setEditingTextId(null);
    if (shape && shape.type === "text") {
      if (!shape.text.trim()) {
        commit(shapes.filter((s) => s.id !== editingTextId));
        setSelectedId(null);
      } else {
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

  // ---- export -----------------------------------------------------------------
  const doExport = useCallback(async () => {
    if (!rec || !srcBlob || !dims) return;
    closeOpenStroke();
    videoRef.current?.pause();
    setPlaying(false);
    setEditingTextId(null);
    setExporting(0);
    try {
      const markup = shapes.filter((s) => !s.type.startsWith("blur"));
      let markupCanvas: HTMLCanvasElement | null = null;
      if (markup.length) {
        markupCanvas = document.createElement("canvas");
        markupCanvas.width = dims.w;
        markupCanvas.height = dims.h;
        drawMarkupShapes(markupCanvas.getContext("2d")!, markup);
      }
      const effectiveCrop =
        crop && (crop.x !== 0 || crop.y !== 0 || crop.width !== dims.w || crop.height !== dims.h)
          ? crop
          : null;
      const result = await exportVideo({
        record: rec,
        source: srcBlob,
        trimStart: trim[0],
        trimEnd: trim[1],
        crop: effectiveCrop,
        shapes,
        markupCanvas,
        autoBlurFaces: autoBlur,
        onProgress: (f) => setExporting(f),
      });
      const copy: VideoRecord = {
        ...rec,
        id: newId(),
        createdAt: Date.now(),
        duration: result.duration,
        width: result.width,
        height: result.height,
        mimeType: result.blob.type,
        exported: true,
      };
      await putBlob(copy.id, "final", result.blob);
      if (result.thumb) await putBlob(copy.id, "thumb", result.thumb);
      await putMedia(copy);
      if (useSettingsStore.getState().settings.autoSaveToDevice || isNativeApp()) {
        try {
          downloadBlob(
            result.blob,
            suggestedName("video", copy.createdAt, result.blob.type)
          );
        } catch {
          // download blocked — in-app copy is already saved
        }
      }
      navigate(`/media/${copy.id}`);
    } catch {
      showNote("Export failed — try a shorter clip");
    } finally {
      setExporting(null);
    }
  }, [rec, srcBlob, dims, shapes, crop, trim, autoBlur, showNote, closeOpenStroke]);

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

  const fmtT = (t: number) =>
    `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  const stageW = dims ? dims.w * fit : 0;
  const stageH = dims ? dims.h * fit : 0;
  const blurActive = tool === "blur-rect";

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
      active: blurActive || blurMenuOpen || autoBlur,
    },
    { key: "crop", icon: <CropIcon size={19} />, label: "Crop" },
  ];

  const textContext =
    tool === "text" || (selectedShape && selectedShape.type === "text");

  return (
    <div className="editor-screen">
      <div ref={wrapRef} className="editor-stage-wrap">
        {note && <div className="editor-note">{note}</div>}
        {srcUrl && (
          <div style={{ position: "relative", width: stageW, height: stageH }}>
            <video
              ref={videoRef}
              src={srcUrl}
              playsInline
              onLoadedMetadata={onMeta}
              onEnded={() => setPlaying(false)}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
            {dims && (
              <Stage
                ref={stageRef}
                width={stageW}
                height={stageH}
                scaleX={fit}
                scaleY={fit}
                style={{ position: "absolute", inset: 0 }}
                onMouseDown={onStageDown}
                onTouchStart={onStageDown}
                onMouseMove={onStageMove}
                onTouchMove={onStageMove}
                onMouseUp={onStageUp}
                onTouchEnd={onStageUp}
              >
                <Layer>
                  {shapes.map((s) => {
                    const common = {
                      id: s.id,
                      draggable: true,
                      onClick: () => setSelectedId(s.id),
                      onTap: () => setSelectedId(s.id),
                      onDragStart: () => setSelectedId(s.id),
                      onDragEnd: (e: Konva.KonvaEventObject<Event>) => onDragEnd(s.id, e.target),
                      onTransformEnd: (e: Konva.KonvaEventObject<Event>) => onTransformEnd(s.id, e.target),
                    };
                    if (s.type === "blur-rect") {
                      return (
                        <KRect
                          key={s.id}
                          {...common}
                          x={s.x}
                          y={s.y}
                          width={s.width}
                          height={s.height}
                          fill={`rgba(120,140,160,${0.35 + 0.4 * (s.intensity ?? DEFAULT_BLUR_INTENSITY)})`}
                          stroke={selectedId === s.id ? "#38bdf8" : "rgba(255,255,255,0.7)"}
                          strokeWidth={2 / fit}
                          dash={[8 / fit, 6 / fit]}
                        />
                      );
                    }
                    if (s.type === "arrow")
                      return (
                        <KArrow key={s.id} {...common} points={s.points} stroke={s.stroke} fill={s.stroke}
                          strokeWidth={s.strokeWidth} pointerLength={s.strokeWidth * 3}
                          pointerWidth={s.strokeWidth * 3} hitStrokeWidth={20} />
                      );
                    if (s.type === "ellipse")
                      return (
                        <KEllipse key={s.id} {...common} x={s.x} y={s.y} radiusX={s.radiusX} radiusY={s.radiusY}
                          rotation={s.rotation} stroke={s.stroke} strokeWidth={s.strokeWidth} hitStrokeWidth={20} />
                      );
                    if (s.type === "pen" || s.type === "highlight")
                      return (
                        <KGroup key={s.id} {...common} listening={openStrokeId !== s.id}
                          opacity={s.type === "highlight" ? 0.45 : 1}>
                          {s.strokes.map((pts, i) => (
                            <KLine key={i} points={pts} stroke={s.stroke} strokeWidth={s.strokeWidth}
                              lineCap="round" lineJoin="round" hitStrokeWidth={24} />
                          ))}
                        </KGroup>
                      );
                    if (s.type === "text") {
                      const family = s.fontFamily ?? "Roboto";
                      const isEditing = editingTextId === s.id;
                      if (s.bgStyle === "chip") {
                        return (
                          <KLabel key={s.id} {...common} x={s.x} y={s.y} rotation={s.rotation}
                            visible={!isEditing}
                            onDblClick={() => setEditingTextId(s.id)}
                            onDblTap={() => setEditingTextId(s.id)}>
                            <KTag fill={s.fill} cornerRadius={s.fontSize * 0.35} />
                            <KText text={s.text} fontSize={s.fontSize} fontFamily={family}
                              fontStyle="500" fill={contrastOn(s.fill)} align={s.align ?? "center"}
                              padding={s.fontSize * 0.35} />
                          </KLabel>
                        );
                      }
                      return (
                        <KText key={s.id} {...common} x={s.x} y={s.y} text={s.text} fontSize={s.fontSize}
                          fontFamily={family} fill={s.fill} rotation={s.rotation} fontStyle="500"
                          align={s.align ?? "center"} visible={!isEditing}
                          shadowColor="rgba(0,0,0,0.7)" shadowBlur={s.fontSize / 6}
                          onDblClick={() => setEditingTextId(s.id)}
                          onDblTap={() => setEditingTextId(s.id)} />
                      );
                    }
                    return null;
                  })}
                  {tool === "crop" && crop && (
                    <KRect
                      id="crop-rect"
                      x={crop.x}
                      y={crop.y}
                      width={crop.width}
                      height={crop.height}
                      stroke="#fbbf24"
                      strokeWidth={2 / fit}
                      draggable
                      onDragEnd={(e) =>
                        setCrop({ ...crop, x: e.target.x(), y: e.target.y() })
                      }
                      onTransformEnd={(e) => {
                        const n = e.target;
                        const sx = n.scaleX();
                        const sy = n.scaleY();
                        n.scaleX(1);
                        n.scaleY(1);
                        setCrop({
                          x: n.x(),
                          y: n.y(),
                          width: Math.max(32, crop.width * sx),
                          height: Math.max(32, crop.height * sy),
                        });
                      }}
                    />
                  )}
                  <Transformer
                    ref={trRef}
                    rotateEnabled={tool !== "crop"}
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
          </div>
        )}

        {showCoach && (
          <CoachOverlay
            items={[
              { icon: <Pen size={17} />, label: "Pen — draw freehand" },
              { icon: <Highlighter size={17} />, label: "Highlighter" },
              { icon: <ArrowUpRight size={17} />, label: "Arrow" },
              { icon: <Circle size={17} />, label: "Circle" },
              { icon: <Type size={17} />, label: "Add text" },
              { icon: <PixelateIcon size={17} />, label: "Blur & redact" },
              { icon: <CropIcon size={17} />, label: "Crop & trim" },
            ]}
            onDone={() => {
              setShowCoach(false);
              void kvSet("coach-video-editor", true);
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
        {colorableContext && !editingShape && tool !== "crop" && (
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
          onSave={() => void doExport()}
          saving={exporting !== null || !dims}
        />
      </div>

      <div className="editor-bottom" style={{ position: "relative" }}>
        {blurMenuOpen && (
          <PopMenu
            items={[
              { key: "blur-rect", icon: <Square size={17} />, label: "Blur box (fixed position)", active: tool === "blur-rect" },
              { key: "autoblur", icon: <ScanFace size={17} />, label: "Auto-blur faces on export", active: autoBlur },
            ]}
            onPick={(key) => {
              setBlurMenuOpen(false);
              if (key === "autoblur") {
                setAutoBlur((v) => {
                  if (!v) showNote("Faces will be re-detected and blurred frame-by-frame during export");
                  return !v;
                });
              } else {
                setTool("blur-rect");
                setSelectedId(null);
              }
            }}
            onClose={() => setBlurMenuOpen(false)}
          />
        )}

        <div className="transport-row">
          <button className="tool-ic" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <div ref={trimBarRef} className="trim-bar" style={{ flex: 1, margin: 0 }}>
            {duration > 0 && (
              <>
                <div
                  className="trim-window"
                  style={{
                    left: `${(trim[0] / duration) * 100}%`,
                    width: `${((trim[1] - trim[0]) / duration) * 100}%`,
                  }}
                >
                  <div className="trim-handle left" onPointerDown={dragTrim("left")} />
                  <div className="trim-handle right" onPointerDown={dragTrim("right")} />
                </div>
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: "#fff",
                    left: `${(playhead / duration) * 100}%`,
                  }}
                />
              </>
            )}
          </div>
          <span className="transport-time">
            {fmtT(trim[0])}–{fmtT(trim[1])}
          </span>
        </div>

        {tool === "crop" && (
          <div className="seg" style={{ margin: "0 12px 8px" }}>
            {ASPECTS.map((a) => (
              <button key={a.label} onClick={() => applyAspect(a.ratio)}>
                {a.label}
              </button>
            ))}
          </div>
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
            // tapping the active tool disarms it
            if (key === tool) {
              setTool(null);
              return;
            }
            setTool(key as VTool);
            setSelectedId(null);
            if (key === "crop" && !crop && dims)
              setCrop({ x: 0, y: 0, width: dims.w, height: dims.h });
          }}
        />
      </div>

      {exporting !== null && (
        <div className="modal-scrim">
          <div className="modal">
            <h2>Exporting video</h2>
            <p>
              Trim, crop, blur and watermark are applied in a single encode
              pass. This takes about as long as the clip itself.
            </p>
            <div className="progress-bar">
              <div style={{ width: `${Math.round(exporting * 100)}%` }} />
            </div>
            <p style={{ textAlign: "center", marginTop: 8 }}>
              {Math.round(exporting * 100)}%
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
