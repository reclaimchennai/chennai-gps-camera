import { useEffect, useRef, useState, type ReactNode } from "react";
import { Screen, Row, Toggle, blurOnEnter } from "./ui";
import { useLiveStore, useSettingsStore } from "../store";
import { renderWatermark, type WatermarkAssets } from "../lib/watermark/render";
import { renderMiniMap } from "../lib/watermark/minimap";
import { collectWatermarkData, getProfilePhoto } from "../lib/capture";
import { FIELD_META, PRESET_META } from "../lib/watermark/presets";
import { fmtDateOnly } from "../lib/geo/format";
import ProfileFields from "./ProfileFields";
import type { DateFormat, WatermarkData } from "../types";

const DATE_FORMATS: DateFormat[] = ["DD/MM/YYYY", "D MMMM YYYY", "D MMM YYYY"];

/** Fallback preview data when there's no live GPS fix (e.g. desktop). */
const SAMPLE: WatermarkData = {
  fix: {
    lat: 13.049953,
    lng: 80.282403,
    accuracy: 6,
    altitude: 9,
    heading: null,
    timestamp: 0,
  },
  jurisdiction: {
    scope: "in",
    corporation: "Greater Chennai Corporation",
    city: "Chennai",
    ward: "123",
    zone: "Zone 9 Teynampet",
    loStation: "D3 Ice House PS",
    trafficStation: "E1 Mylapore",
  },
  address: "Kamarajar Salai, Marina Beach, Chennai 600005",
  locality: "Mylapore, Chennai",
  bearing: 74,
  timestamp: 0,
  tzOffsetMinutes: new Date().getTimezoneOffset(),
};

export default function WatermarkEditorView() {
  const config = useSettingsStore((s) => s.watermark);
  const profile = useSettingsStore((s) => s.profile);
  const setWatermark = useSettingsStore((s) => s.setWatermark);
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assetsRef = useRef<WatermarkAssets>({});
  // The pinned preview eats half the screen while the keyboard is up —
  // collapse it whenever a text input has focus so users can see what
  // they type, and slide it back when the keyboard goes away.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const isText = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return (
        tag === "TEXTAREA" ||
        (tag === "INPUT" &&
          !["checkbox", "radio", "range", "file"].includes(
            (t as HTMLInputElement).type
          ))
      );
    };
    const onFocusIn = (e: FocusEvent) => {
      if (isText(e.target)) setTyping(true);
    };
    const onFocusOut = () => {
      // wait a beat: focus may be moving between two inputs
      window.setTimeout(() => {
        if (!isText(document.activeElement)) setTyping(false);
      }, 120);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  // Live preview — same renderer as capture (§5.3: one implementation).
  // Shows JUST the card (tight crop, no fake photo behind it); only when
  // the social strip is on does it show the full frame, since the strip
  // lives on the photo edge outside the card.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const live = useLiveStore.getState();
      const data: WatermarkData = live.fix
        ? { ...collectWatermarkData(), timestamp: Date.now() }
        : { ...SAMPLE, timestamp: Date.now() };
      if (config.fields.miniMap && data.fix) {
        const m = await renderMiniMap(
          data.fix.lat,
          data.fix.lng,
          live.fix ? live.lookupResult : null
        );
        if (m) assetsRef.current.miniMap = m;
      }
      assetsRef.current.profilePhoto = await getProfilePhoto();
      if (cancelled) return;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const cssW = (canvas.parentElement?.clientWidth ?? 360) - 8;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      // render into a virtual full frame, then crop
      const W = 1080;
      const H = 1440;
      const off = document.createElement("canvas");
      off.width = W;
      off.height = H;
      const octx = off.getContext("2d");
      if (!octx) return;
      const fullFrame =
        config.fields.socialHandles || config.fields.profilePhoto;
      if (fullFrame) {
        octx.fillStyle = "#4b5563"; // neutral stand-in, only to place the strip
        octx.fillRect(0, 0, W, H);
      }
      const panel = renderWatermark(
        octx, W, H, data, config, profile, assetsRef.current
      );

      let sx = 0, sy = 0, sw = W, sh = H;
      if (!fullFrame && panel) {
        const padPx = 20;
        sx = Math.max(0, panel.x - padPx);
        sy = Math.max(0, panel.y - padPx);
        sw = Math.min(W - sx, panel.width + padPx * 2);
        sh = Math.min(H - sy, panel.height + padPx * 2);
      }

      let cw = cssW;
      let ch = (cssW * sh) / sw;
      const maxH = 340;
      if (ch > maxH) {
        ch = maxH;
        cw = (maxH * sw) / sh;
      }
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${Math.round(cw)}px`;
      canvas.style.height = `${Math.round(ch)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(off, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    })();
    return () => {
      cancelled = true;
    };
  }, [config, profile, settings.dateFormat]);

  const set = (patch: Partial<typeof config>) =>
    setWatermark({ ...config, ...patch });
  const setField = (key: keyof typeof config.fields, v: boolean) =>
    set({ fields: { ...config.fields, [key]: v } });

  return (
    <Screen title="Watermark">
      {/* frozen while scrolling: every toggle updates it live; all
          changes save immediately — there is no save button */}
      <div className="wm-preview-wrap" data-typing={typing}>
        <canvas ref={canvasRef} className="wm-preview" />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">Layout</div>
        <div style={{ padding: "10px 14px" }}>
          <div className="seg">
            {PRESET_META.map((p) => (
              <button
                key={p.key}
                data-active={config.preset === p.key}
                onClick={() => set({ preset: p.key })}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {PRESET_META.find((p) => p.key === config.preset)?.hint}
          </div>
        </div>
        <div className="row" style={{ display: "block" }}>
          <div className="label">Card position</div>
          <div className="hint" style={{ margin: "2px 0 8px" }}>
            Corners apply to landscape shots — portrait cards span the width
          </div>
          {(
            [
              ["top-left", "Top left"],
              ["top", "Top"],
              ["top-right", "Top right"],
              ["bottom-left", "Bottom left"],
              ["bottom", "Bottom"],
              ["bottom-right", "Bottom right"],
            ] as const
          ).reduce<[string, string][][]>((rows, opt, i) => {
            if (i % 3 === 0) rows.push([]);
            rows[rows.length - 1].push([opt[0], opt[1]]);
            return rows;
          }, []).map((row, ri) => (
            <div
              key={ri}
              className="seg"
              style={{ marginTop: ri ? 6 : 0, width: "100%" }}
            >
              {row.map(([key, label]) => (
                <button
                  key={key}
                  data-active={config.position === key}
                  onClick={() =>
                    set({ position: key as typeof config.position })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Fields</div>
        {FIELD_META.map((f) => {
          // Related options expand inline right under their toggle and
          // stay open while the field is on.
          let expansion: ReactNode = null;
          if (f.key === "datetime" && config.fields.datetime) {
            expansion = (
              <div className="field-expand">
                {DATE_FORMATS.map((df) => (
                  <button
                    key={df}
                    className="expand-option"
                    data-active={settings.dateFormat === df}
                    onClick={() => setSettings({ dateFormat: df })}
                  >
                    <span className="radio-dot" />
                    {fmtDateOnly(Date.now(), df)}
                  </button>
                ))}
              </div>
            );
          } else if (f.key === "miniMap" && config.fields.miniMap) {
            expansion = (
              <div className="field-expand">
                <Row
                  label="Google Maps imagery when online"
                  hint="Needs the API key from Settings. Offline photos use the built-in boundary map."
                >
                  <Toggle
                    on={config.onlineMapUpgrade}
                    onChange={(v) => set({ onlineMapUpgrade: v })}
                  />
                </Row>
              </div>
            );
          } else if (f.key === "socialHandles" && config.fields.socialHandles) {
            expansion = (
              <div className="field-expand">
                <ProfileFields />
              </div>
            );
          } else if (f.key === "customLabel" && config.fields.customLabel) {
            expansion = (
              <div className="field-expand">
                <input
                  placeholder="Custom label text"
                  value={config.customLabelText}
                  enterKeyHint="done"
                  onKeyDown={blurOnEnter}
                  onChange={(e) => set({ customLabelText: e.target.value })}
                />
              </div>
            );
          }
          return (
            <div key={f.key}>
              <Row label={f.label} hint={f.hint}>
                <Toggle
                  on={config.fields[f.key]}
                  onChange={(v) => setField(f.key, v)}
                />
              </Row>
              {expansion}
            </div>
          );
        })}
      </div>

      <div className="card">
        <div className="card-title">Style</div>
        <Row label="Theme">
          <div className="seg" style={{ width: 220 }}>
            {(["dark", "light", "brand"] as const).map((t) => (
              <button
                key={t}
                data-active={config.theme === t}
                onClick={() => set({ theme: t })}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Text size">
          <input
            type="range"
            style={{ width: 150 }}
            min={0.8}
            max={1.4}
            step={0.05}
            value={config.fontScale}
            onChange={(e) => set({ fontScale: Number(e.target.value) })}
          />
        </Row>
        <Row label="Panel opacity">
          <input
            type="range"
            style={{ width: 150 }}
            min={0.15}
            max={0.9}
            step={0.05}
            value={config.opacity}
            onChange={(e) => set({ opacity: Number(e.target.value) })}
          />
        </Row>
      </div>

    </Screen>
  );
}
