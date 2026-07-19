import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Screen, Row, Toggle } from "./ui";
import { useLiveStore, useSettingsStore } from "../store";
import { navigate } from "../nav";
import { isNativeApp } from "../lib/native";
import { startMeter, stopMeter } from "../lib/audio/meter";

// TEMPORARY (owner request): show the classic blinking NEW gif on the
// live-face-blur row until 2026-07-21, after which the Experimental chip
// returns automatically. Delete /new.gif and this block after that date.
const NEW_GIF_UNTIL = Date.UTC(2026, 6, 21); // months are 0-based → July 21
// plate reader launched 2026-07-19 — its NEW gif runs a week
const PLATE_NEW_UNTIL = Date.UTC(2026, 6, 27);

const WHEEL_ITEM_PX = 36;

/** Scroll-snap number wheel (clock-app style) for the calibration
 *  reference level: 0–120 dB, centre item selected. */
function WheelPicker({
  value,
  onChange,
  min = 0,
  max = 120,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = (value - min) * WHEEL_ITEM_PX;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const idx = Math.round(el.scrollTop / WHEEL_ITEM_PX);
      const v = Math.min(max, Math.max(min, min + idx));
      if (v !== value) onChange(v);
    }, 80);
  };

  const count = max - min + 1;
  return (
    <div className="wheel-wrap">
      <div className="wheel" ref={ref} onScroll={onScroll}>
        <div className="wheel-pad" />
        {Array.from({ length: count }, (_, i) => (
          <div
            key={i}
            className="wheel-item"
            data-active={min + i === value}
            onClick={() => {
              const el = ref.current;
              if (el)
                el.scrollTo({ top: i * WHEEL_ITEM_PX, behavior: "smooth" });
            }}
          >
            {min + i}
          </div>
        ))}
        <div className="wheel-pad" />
      </div>
      <div className="wheel-band" />
    </div>
  );
}

export default function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const liveDb = useLiveStore((s) => s.db);
  const native = isNativeApp();
  // reference level the user is exposing the mic to (dB), for Match
  const [calRef, setCalRef] = useState(60);
  const [advOpen, setAdvOpen] = useState(false);

  // keep the mic meter running here so the calibration row shows a live
  // reading; CameraView restarts its own metering when it regains focus
  useEffect(() => {
    if (!advOpen) return;
    startMeter();
    return () => stopMeter();
  }, [advOpen]);

  return (
    <Screen title="Settings">
      <div className="card">
        <Row
          label="Watermark"
          hint="Fields, layout, style, profile & social handles"
          onClick={() => navigate("/settings/watermark")}
        />
      </div>

      <div className="card">
        <div className="card-title">Appearance</div>
        <Row label="Theme" hint="System follows your phone's light/dark setting">
          <div className="seg" style={{ width: 210 }}>
            {(["system", "light", "dark"] as const).map((t) => (
              <button
                key={t}
                data-active={settings.appTheme === t}
                onClick={() => setSettings({ appTheme: t })}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Camera</div>
        {/* the native app always saves captures to the gallery — no
            toggle to confuse things there */}
        {!native && (
          <Row
            label="Auto-save photos to device"
            hint="Each shot is also saved to your phone (Downloads), so it shows in the gallery app"
          >
            <Toggle
              on={settings.autoSaveToDevice}
              onChange={(v) => setSettings({ autoSaveToDevice: v })}
            />
          </Row>
        )}
        <Row label="Grid lines">
          <Toggle
            on={settings.gridLines}
            onChange={(v) => setSettings({ gridLines: v })}
          />
        </Row>
        <Row
          label="Mirror front-camera photos"
          hint="Save selfies as seen in the preview"
        >
          <Toggle
            on={settings.mirrorFrontPhoto}
            onChange={(v) => setSettings({ mirrorFrontPhoto: v })}
          />
        </Row>
      </div>

      <div className="card">
        <button
          className="adv-toggle"
          aria-expanded={advOpen}
          onClick={() => setAdvOpen((o) => !o)}
        >
          <span className="card-title" style={{ padding: 0 }}>Advanced</span>
          <ChevronDown
            size={18}
            style={{
              transition: "transform 0.25s ease",
              transform: advOpen ? "rotate(180deg)" : "none",
            }}
          />
        </button>
        <div className="adv-body" data-open={advOpen}>
          <div>
            <Row
              label={
                <>
                  Live face blur{" "}
                  <span className="exp-chip">Experimental</span>
                  {Date.now() < NEW_GIF_UNTIL && (
                    <img
                      src="/new.gif"
                      alt="New"
                      style={{ height: 15, verticalAlign: "-2px", marginLeft: 6 }}
                    />
                  )}
                </>
              }
              hint="Blurs detected faces in the viewfinder and burns them into photos and recorded videos. Best-effort — always review; uses more battery."
            >
              <Toggle
                on={settings.liveFaceBlur}
                onChange={(v) => setSettings({ liveFaceBlur: v })}
              />
            </Row>

            <Row
              label={
                <>
                  Licence plate reader{" "}
                  <span className="exp-chip">Experimental</span>
                  {Date.now() < PLATE_NEW_UNTIL && (
                    <img
                      src="/new.gif"
                      alt="New"
                      style={{ height: 15, verticalAlign: "-2px", marginLeft: 6 }}
                    />
                  )}
                </>
              }
              hint="Reads vehicle number plates from photos, fully on-device, in the background — never slows the shutter. Found plates show on the photo and ride along when you share it. Best-effort: verify before reporting."
            >
              <Toggle
                on={settings.plateOcr}
                onChange={(v) => setSettings({ plateOcr: v })}
              />
            </Row>

            {/* styled exactly like the other settings rows: bold label,
                lighter hint at the standard size */}
            <div className="row" style={{ display: "block" }}>
              <div className="label">
                Noise meter calibration
                {settings.dbCalibration !== 0 &&
                  ` (${settings.dbCalibration > 0 ? "+" : ""}${settings.dbCalibration} dB)`}
              </div>
              <div className="hint" style={{ lineHeight: 1.5 }}>
                Phone microphones are not calibrated instruments, so the
                meter can drift from reality. To correct it, expose the
                phone to a sound of a known level — a calibrated 60 dB
                reference tone, or simply a noise-meter app you trust
                running next to it. Pick that known level on the wheel
                below, then tap Match while the sound is playing; the meter
                computes the exact offset.
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                Current live reading:{" "}
                <strong style={{ color: "var(--text)" }}>
                  {liveDb != null ? `≈ ${liveDb} dB` : "listening…"}
                </strong>
              </div>
              <div className="cal-controls">
                <WheelPicker value={calRef} onChange={setCalRef} />
                <button
                  className="ghost-btn"
                  disabled={liveDb == null}
                  onClick={() => {
                    if (liveDb == null) return;
                    // current uncalibrated reading + new offset = target
                    const raw = liveDb - settings.dbCalibration;
                    setSettings({
                      dbCalibration: Math.max(
                        -40,
                        Math.min(40, Math.round(calRef - raw))
                      ),
                    });
                  }}
                >
                  Match
                </button>
                <button
                  className="ghost-btn"
                  disabled={settings.dbCalibration === 0}
                  onClick={() => setSettings({ dbCalibration: 0 })}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="card-title" style={{ paddingTop: 14 }}>
              Address lookup (online)
            </div>
            <Row
              label="Provider"
              hint="Addresses are fetched in the background — never before a photo saves"
            >
              <select
                style={{ width: 160 }}
                value={settings.geocoder}
                onChange={(e) =>
                  setSettings({
                    geocoder: e.target.value as typeof settings.geocoder,
                  })
                }
              >
                <option value="auto">Automatic</option>
                {native && <option value="system">System (Android)</option>}
                <option value="nominatim">OpenStreetMap</option>
                <option value="google">Google (needs key)</option>
                <option value="mappls">Mappls (needs key)</option>
                <option value="off">Off</option>
              </select>
            </Row>
            <Row
              label="Google Maps API key"
              hint="Optional. Enables Google addresses + real map thumbnails"
            >
              <input
                style={{ width: 170 }}
                type="password"
                placeholder="Not set"
                value={settings.googleApiKey}
                onChange={(e) =>
                  setSettings({ googleApiKey: e.target.value.trim() })
                }
              />
            </Row>
            <Row
              label="Mappls API key"
              hint="Optional. MapmyIndia addresses — strong Indian coverage"
            >
              <input
                style={{ width: 170 }}
                type="password"
                placeholder="Not set"
                value={settings.mapplsApiKey}
                onChange={(e) =>
                  setSettings({ mapplsApiKey: e.target.value.trim() })
                }
              />
            </Row>
          </div>
        </div>
      </div>

      <div className="card">
        {!native && (
          <Row
            label="Android app (APK)"
            hint="Native Android build — English addresses from the phone's own geocoder, saves straight to the gallery"
            onClick={() => {
              // always the newest release asset, straight from GitHub —
              // avoids the Cloudflare-cached copy of the self-hosted file
              window.location.href =
                "https://github.com/reclaimchennai/chennai-gps-camera/releases/latest/download/app-release.apk";
            }}
          />
        )}
        <Row
          label="Report an issue"
          hint="Send feedback or a bug — with an optional annotated screenshot"
          onClick={() => navigate("/report")}
        />
        <Row
          label="About, data & accuracy"
          hint="Boundary data caveats, licences"
          onClick={() => navigate("/about")}
        />
        <Row
          label="Privacy policy"
          hint="What stays on your device, and the few things that don't"
          onClick={() => {
            window.open(
              "https://cam.reclaimchennai.city/privacy.html",
              "_blank",
              "noopener,noreferrer"
            );
          }}
        />
      </div>
    </Screen>
  );
}
