import { create } from "zustand";
import { isInstalledApp, isNativeApp } from "./lib/native";
import type {
  AppSettings,
  Fix,
  Profile,
  WatermarkConfig,
} from "./types";
import type { LookupResult } from "./lib/geo/lookup";
import { kvGet, kvSet } from "./lib/db";
import { DEFAULT_WATERMARK_CONFIG } from "./lib/watermark/presets";
import { ensureCardFont } from "./lib/i18n/languages";
import { resetScriptCache } from "./lib/watermark/signboard";

// ---- Live (ephemeral) state ------------------------------------------

export type GpsStatus = "waiting" | "ok" | "denied";

interface LiveState {
  fix: Fix | null;
  lookupResult: LookupResult | null;
  bearing: number | undefined;
  gpsStatus: GpsStatus;
  address: string | undefined; // live-preview reverse geocode (best effort)
  locality: string | undefined;
  addressFor: { lat: number; lng: number } | null;
  /** live ambient sound level, approximate dB (null = mic unavailable) */
  db: number | null;
  /** session sound stats — average/min/max since the app opened */
  dbStats: { avg: number; min: number; max: number } | null;
  /** physical device rotation for in-place UI rotation (lib/orientation) */
  uiRotation: 0 | 90 | -90;
  /** true when the current fix is a mock/spoofed location (disclosed, not blocked) */
  mockLocation: boolean;
  setFix(fix: Fix): void;
  setLookupResult(r: LookupResult): void;
  setBearing(b: number): void;
  setGpsStatus(s: GpsStatus): void;
  setAddress(
    addr: string | undefined,
    locality: string | undefined,
    at: { lat: number; lng: number } | null
  ): void;
  setDb(db: number | null): void;
  setDbStats(stats: { avg: number; min: number; max: number } | null): void;
  setUiRotation(r: 0 | 90 | -90): void;
  setMockLocation(m: boolean): void;
}

/**
 * Chennai users get the street-sign card by default (owner decision).
 *
 * It cannot be decided at install: the template depends on WHERE the user
 * is, which is only known once a fix resolves inside Greater Chennai
 * Corporation. So the first Chennai fix adopts it — once, guarded by a
 * flag, and only from the plain detailed card. A user who has picked any
 * other layout (or who picks detailed back afterwards) is never
 * overridden: the app gets one chance to suggest, not a standing veto on
 * their choice.
 */
function adoptChennaiTemplate(r: LookupResult | null): void {
  try {
    if (localStorage.getItem("gpscam-chennai-template") === "1") return;
    const j = r?.jurisdiction;
    const chennai =
      j &&
      (j.scope === "gcc" || /greater chennai/i.test(j.corporation ?? ""));
    if (!chennai) return;
    // A fix can land before hydrateSettings() resolves. Claiming the flag
    // then would burn the one chance against a default-valued store and
    // the template would never appear — so wait for real settings and let
    // the next fix try again.
    const st = useSettingsStore.getState();
    if (!st.hydrated) return;
    localStorage.setItem("gpscam-chennai-template", "1");
    if (st.watermark.preset === "detailed") {
      st.setWatermark({ ...st.watermark, preset: "chennai" });
    }
  } catch {
    // storage unavailable — leave the layout alone
  }
}

export const useLiveStore = create<LiveState>((set) => ({
  fix: null,
  lookupResult: null,
  bearing: undefined,
  gpsStatus: "waiting",
  address: undefined,
  locality: undefined,
  addressFor: null,
  db: null,
  dbStats: null,
  uiRotation: 0,
  mockLocation: false,
  setFix: (fix) => set({ fix }),
  setLookupResult: (lookupResult) => {
    set({ lookupResult });
    adoptChennaiTemplate(lookupResult);
  },
  setBearing: (bearing) => set({ bearing }),
  setGpsStatus: (gpsStatus) => set({ gpsStatus }),
  setAddress: (address, locality, addressFor) =>
    set({ address, locality, addressFor }),
  setDb: (db) => set({ db }),
  setDbStats: (dbStats) => set({ dbStats }),
  setUiRotation: (uiRotation) => set({ uiRotation }),
  setMockLocation: (mockLocation) => set({ mockLocation }),
}));

// ---- Persistent settings ----------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  gridLines: false,
  plateOcr: false,
  captureQuality: "auto",
  mirrorFrontPhoto: false,
  // Off by default for INSTALLED web apps: saving is a browser download,
  // and Chrome shows a banner for every one — after every photo. In a
  // plain browser tab it stays on, where that feedback is expected and the
  // app has no gallery of its own to fall back on.
  autoSaveToDevice: !isInstalledApp() || isNativeApp(),
  appTheme: "system",
  dateFormat: "DD/MM/YYYY",
  liveFaceBlur: false,
  dbCalibration: 0,
  googleApiKey: "",
  mapplsApiKey: "",
  geocoder: "auto",
};

export const DEFAULT_PROFILE: Profile = {
  displayName: "",
  hasPhoto: false,
  handles: [],
};

interface SettingsState {
  hydrated: boolean;
  settings: AppSettings;
  watermark: WatermarkConfig;
  profile: Profile;
  setSettings(patch: Partial<AppSettings>): void;
  setWatermark(config: WatermarkConfig): void;
  setProfile(profile: Profile): void;
}

/**
 * Existing installed web apps: stop the download banner after every photo.
 *
 * v1.16.2 made auto-save default OFF for installed web apps, but a default
 * only applies to a fresh profile — and reinstalling a home-screen app
 * keeps the site's storage, so anyone who already had it on kept getting
 * a download prompt per shot. Turn it off once, and remember that we did,
 * so a deliberate re-enable is never overridden.
 */
function migrateAutoSaveForInstalledApps(): void {
  try {
    if (isNativeApp() || !isInstalledApp()) return;
    if (localStorage.getItem("gpscam-autosave-migrated") === "1") return;
    localStorage.setItem("gpscam-autosave-migrated", "1");
    const st = useSettingsStore.getState();
    if (st.settings.autoSaveToDevice) {
      st.setSettings({ autoSaveToDevice: false });
    }
  } catch {
    // storage unavailable — nothing to migrate
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  hydrated: false,
  settings: DEFAULT_SETTINGS,
  watermark: DEFAULT_WATERMARK_CONFIG,
  profile: DEFAULT_PROFILE,
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void kvSet("settings", settings);
  },
  setWatermark: (watermark) => {
    set({ watermark });
    // bring the script in before the next render measures it, and clear
    // the probe cache once it lands — otherwise a probe that ran while
    // the face was still loading pins the card to English labels
    void ensureCardFont(watermark.language, resetScriptCache);
    void kvSet("watermark-config", watermark);
  },
  setProfile: (profile) => {
    set({ profile });
    void kvSet("profile", profile);
  },
}));

export async function hydrateSettings(): Promise<void> {
  const [settings, watermark, profile] = await Promise.all([
    kvGet<AppSettings>("settings"),
    kvGet<WatermarkConfig>("watermark-config"),
    kvGet<Profile>("profile"),
  ]);
  void ensureCardFont(watermark?.language, resetScriptCache);
  useSettingsStore.setState({
    hydrated: true,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    watermark: watermark
      ? {
          ...DEFAULT_WATERMARK_CONFIG,
          ...watermark,
          fields: { ...DEFAULT_WATERMARK_CONFIG.fields, ...watermark.fields },
        }
      : DEFAULT_WATERMARK_CONFIG,
    profile: { ...DEFAULT_PROFILE, ...profile },
  });
}

// run once the store exists
migrateAutoSaveForInstalledApps();
