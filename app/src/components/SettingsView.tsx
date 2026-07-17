import { useEffect, useState } from "react";
import { Screen, Row, Toggle } from "./ui";
import { useLiveStore, useSettingsStore } from "../store";
import { navigate } from "../nav";
import { isNativeApp } from "../lib/native";
import { startMeter, stopMeter } from "../lib/audio/meter";

// TEMPORARY (owner request): show the classic blinking NEW gif on the
// live-face-blur row until 2026-07-21, after which the Experimental chip
// returns automatically. Delete /new.gif and this block after that date.
const NEW_GIF_UNTIL = Date.UTC(2026, 6, 21); // months are 0-based → July 21

export default function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const liveDb = useLiveStore((s) => s.db);
  // reference level the user is exposing the mic to (dB), for Match
  const [calRef, setCalRef] = useState("60");

  // keep the mic meter running here so the calibration row shows a live
  // reading; CameraView restarts its own metering when it regains focus
  useEffect(() => {
    startMeter();
    return () => stopMeter();
  }, []);

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
        <Row
          label="Auto-save photos to device"
          hint="Each shot is also saved to your phone (Downloads), so it shows in the gallery app"
        >
          <Toggle
            on={settings.autoSaveToDevice}
            onChange={(v) => setSettings({ autoSaveToDevice: v })}
          />
        </Row>
        <Row label="Shutter sound">
          <Toggle
            on={settings.shutterSound}
            onChange={(v) => setSettings({ shutterSound: v })}
          />
        </Row>
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
        <Row
          label={
            <>
              Live face blur{" "}
              {Date.now() < NEW_GIF_UNTIL ? (
                <img
                  src="/new.gif"
                  alt="New"
                  style={{ height: 15, verticalAlign: "-2px", marginLeft: 6 }}
                />
              ) : (
                <span className="exp-chip">Experimental</span>
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
          label={`Sound meter calibration (${settings.dbCalibration >= 0 ? "+" : ""}${settings.dbCalibration} dB)`}
          hint={`Live reading: ${liveDb != null ? `≈ ${liveDb} dB` : "listening…"}. Play a known level near the phone (e.g. a calibrated 60 dB tone or a reference noise-meter app), type that number, then tap Match.`}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="number"
              min={30}
              max={110}
              step={1}
              style={{ width: 64 }}
              value={calRef}
              onChange={(e) => setCalRef(e.target.value)}
            />
            <button
              className="ghost-btn"
              disabled={liveDb == null || calRef.trim() === ""}
              onClick={() => {
                const target = Number(calRef);
                if (liveDb == null || !Number.isFinite(target)) return;
                // current uncalibrated reading + new offset = target
                const raw = liveDb - settings.dbCalibration;
                setSettings({
                  dbCalibration: Math.max(-40, Math.min(40, Math.round(target - raw))),
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
        </Row>
      </div>

      <div className="card">
        <div className="card-title">Address lookup (online)</div>
        <Row
          label="Provider"
          hint="Addresses are fetched in the background — never before a photo saves"
        >
          <select
            style={{ width: 150 }}
            value={settings.geocoder}
            onChange={(e) =>
              setSettings({
                geocoder: e.target.value as typeof settings.geocoder,
              })
            }
          >
            <option value="auto">Automatic</option>
            <option value="nominatim">OpenStreetMap</option>
            <option value="google">Google (needs key)</option>
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
            onChange={(e) => setSettings({ googleApiKey: e.target.value.trim() })}
          />
        </Row>
      </div>

      <div className="card">
        {!isNativeApp() && (
          <Row
            label="Android app (APK)"
            hint="Native Android build — English addresses from the phone's own geocoder, saves straight to the gallery"
            onClick={() => {
              window.location.href = "/download/chennai-gps-camera.apk";
            }}
          />
        )}
        <Row
          label="About, data & accuracy"
          hint="Boundary data caveats, licences"
          onClick={() => navigate("/about")}
        />
      </div>
    </Screen>
  );
}
