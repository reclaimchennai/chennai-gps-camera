/**
 * Shared Telegram/WhatsApp-style editor chrome:
 *  - floating top bar: cancel + undo on the left, redo / trash / save on
 *    the right — always reachable, never scrolled away
 *  - single-row icon toolbar at the bottom (no scrolling, no select tool:
 *    placed shapes are always directly tappable/draggable)
 *  - vertical size/intensity slider on the LEFT edge of the canvas
 *  - WhatsApp-style vertical color-gradient slider on the RIGHT edge
 *  - a popup menu (e.g. the blur options) springing from the toolbar
 */
import {
  useCallback,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { X, Undo2, Redo2, Trash2, Check } from "lucide-react";

/**
 * Button with a long-press label bubble (mobile "tooltip"): hold ~500 ms
 * to see the tool's name; that press does not activate the tool.
 */
export function LongPressButton({
  label,
  tipBelow,
  className,
  active,
  disabled,
  onClick,
  style,
  children,
}: {
  label: string;
  tipBelow?: boolean;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [tip, setTip] = useState(false);
  const timerRef = useRef(0);
  const firedRef = useRef(false);

  const start = () => {
    firedRef.current = false;
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      firedRef.current = true;
      setTip(true);
    }, 500);
  };
  const end = () => {
    window.clearTimeout(timerRef.current);
    if (firedRef.current) window.setTimeout(() => setTip(false), 1100);
  };

  return (
    <button
      className={className}
      data-active={active}
      disabled={disabled}
      style={{ position: "relative", ...style }}
      aria-label={label}
      onPointerDown={start}
      onPointerUp={end}
      onPointerLeave={() => {
        window.clearTimeout(timerRef.current);
        setTip(false);
      }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        if (firedRef.current) {
          // this press was a tooltip lookup, not an activation
          e.preventDefault();
          e.stopPropagation();
          firedRef.current = false;
          return;
        }
        onClick?.();
      }}
    >
      {children}
      {tip && <span className={`lp-tip${tipBelow ? " below" : ""}`}>{label}</span>}
    </button>
  );
}

export function EditorTopBar({
  onCancel,
  onUndo,
  canUndo,
  onRedo,
  canRedo,
  onTrash,
  trashDisabled,
  onSave,
  saving,
}: {
  onCancel: () => void;
  onUndo: () => void;
  canUndo: boolean;
  onRedo: () => void;
  canRedo: boolean;
  /** Deletes the selected shape, or clears all when nothing is selected. */
  onTrash: () => void;
  trashDisabled: boolean;
  onSave: () => void;
  saving?: boolean;
}) {
  return (
    <div className="editor-topbar">
      <div className="tb-group">
        <LongPressButton className="tb-btn" label="Close without saving" tipBelow onClick={onCancel}>
          <X size={20} />
        </LongPressButton>
        <LongPressButton className="tb-btn" label="Undo" tipBelow disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={20} />
        </LongPressButton>
      </div>
      <div className="tb-group">
        <LongPressButton className="tb-btn" label="Redo" tipBelow disabled={!canRedo} onClick={onRedo}>
          <Redo2 size={20} />
        </LongPressButton>
        <LongPressButton
          className="tb-btn"
          label="Delete selected (or clear all)"
          tipBelow
          disabled={trashDisabled}
          onClick={onTrash}
        >
          <Trash2 size={20} />
        </LongPressButton>
        <LongPressButton className="tb-btn tb-save" label="Save" tipBelow disabled={saving} onClick={onSave}>
          <Check size={22} />
        </LongPressButton>
      </div>
    </div>
  );
}

export interface ToolDef {
  key: string;
  icon: ReactNode;
  label: string;
  /** render as momentary action / toggle instead of exclusive tool */
  kind?: "tool" | "action" | "toggle";
  active?: boolean;
}

export function ToolRow({
  tools,
  activeTool,
  onTool,
}: {
  tools: ToolDef[];
  /** null = no tool armed (pan/zoom mode) */
  activeTool: string | null;
  onTool: (key: string) => void;
}) {
  return (
    <div className="tool-row">
      {tools.map((t) => (
        <LongPressButton
          key={t.key}
          className="tool-ic"
          label={t.label}
          active={t.kind === "toggle" ? t.active : activeTool === t.key}
          onClick={() => onTool(t.key)}
        >
          {t.icon}
        </LongPressButton>
      ))}
    </div>
  );
}

/** One-time quick guide shown on the first editor open. */
export function CoachOverlay({
  items,
  onDone,
}: {
  items: { icon: ReactNode; label: string }[];
  onDone: () => void;
}) {
  return (
    <div className="coach-scrim" onClick={onDone}>
      <div className="coach-card" onClick={(e) => e.stopPropagation()}>
        <h2>Quick guide</h2>
        <div className="coach-grid">
          {items.map((it, i) => (
            <div className="coach-row" key={i}>
              <span className="coach-ic">{it.icon}</span>
              <span>{it.label}</span>
            </div>
          ))}
        </div>
        <p>
          Tap any placed mark to move, resize or delete it. Long-press any
          button to see its name. The size slider is on the left, the color
          slider on the right.
        </p>
        <button className="primary-btn" style={{ width: "100%" }} onClick={onDone}>
          Got it
        </button>
      </div>
    </div>
  );
}

export interface PopMenuItem {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  active?: boolean;
}

/** Small popup springing from the toolbar (Telegram shape-menu style). */
export function PopMenu({
  items,
  onPick,
  onClose,
}: {
  items: PopMenuItem[];
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="popmenu-scrim" onClick={onClose} />
      <div className="popmenu">
        {items.map((it) => (
          <button
            key={it.key}
            className="popmenu-item"
            data-active={it.active}
            onClick={() => onPick(it.key)}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---- WhatsApp-style vertical color slider (right edge) ----------------

const COLOR_STOPS = [
  [255, 255, 255],
  [255, 0, 0],
  [255, 128, 0],
  [255, 255, 0],
  [0, 200, 0],
  [0, 220, 220],
  [0, 90, 255],
  [200, 0, 255],
  [0, 0, 0],
] as const;

function colorAt(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const seg = clamped * (COLOR_STOPS.length - 1);
  const i = Math.min(COLOR_STOPS.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = COLOR_STOPS[i];
  const b = COLOR_STOPS[i + 1];
  const mix = (x: number, y: number) => Math.round(x + (y - x) * f);
  return `#${[mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

const COLOR_GRADIENT = `linear-gradient(to bottom, ${COLOR_STOPS.map(
  (c, i) =>
    `rgb(${c[0]},${c[1]},${c[2]}) ${((i / (COLOR_STOPS.length - 1)) * 100).toFixed(1)}%`
).join(", ")})`;

export function ColorSlider({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  // The thumb keeps its own position; palette-independent colors just
  // leave the thumb where the user last set it.
  const [pos, setPos] = useState(0.14);
  const trackRef = useRef<HTMLDivElement>(null);

  const posFromEvent = useCallback((clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0.5;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  }, []);

  const apply = useCallback(
    (clientY: number) => {
      const t = posFromEvent(clientY);
      setPos(t);
      onChange(colorAt(t));
    },
    [posFromEvent, onChange]
  );

  return (
    <div
      className="c-slider"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        apply(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.buttons) apply(e.clientY);
      }}
    >
      <div
        ref={trackRef}
        className="c-slider-track"
        style={{ background: COLOR_GRADIENT }}
      />
      <div
        className="c-slider-thumb"
        style={{ top: `${pos * 100}%`, background: color }}
      />
    </div>
  );
}

/**
 * Vertical slider on the left edge of the stage (Telegram-style).
 * Value 0 (bottom) … 1 (top).
 */
export function IntensitySlider({
  value,
  onChange,
  onCommit,
}: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const valueFromEvent = useCallback((clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0.5;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height));
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      onChange(valueFromEvent(e.clientY));
    },
    [onChange, valueFromEvent]
  );

  return (
    <div
      className="v-slider"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (e.buttons) onChange(valueFromEvent(e.clientY));
      }}
      onPointerUp={() => onCommit?.()}
      onPointerCancel={() => onCommit?.()}
    >
      <div ref={trackRef} className="v-slider-track">
        <div className="v-slider-fill" style={{ height: `${value * 100}%` }} />
        <div className="v-slider-thumb" style={{ bottom: `${value * 100}%` }} />
      </div>
    </div>
  );
}
