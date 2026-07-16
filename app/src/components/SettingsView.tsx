import { Screen, Row, Toggle } from "./ui";
import { useSettingsStore } from "../store";
import { navigate } from "../nav";

// TEMPORARY (owner request): show the classic blinking NEW gif on the
// live-face-blur row until 2026-07-21, after which the Experimental chip
// returns automatically. Delete /new.gif and this block after that date.
const NEW_GIF_UNTIL = Date.UTC(2026, 6, 21); // months are 0-based → July 21

export default function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);

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
          hint="Blurs detected faces in the viewfinder and burns them into photos. Videos record raw and blur at export. Best-effort — always review; uses more battery."
        >
          <Toggle
            on={settings.liveFaceBlur}
            onChange={(v) => setSettings({ liveFaceBlur: v })}
          />
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
        <Row
          label="About, data & accuracy"
          hint="Boundary data caveats, licences"
          onClick={() => navigate("/about")}
        />
      </div>
    </Screen>
  );
}
