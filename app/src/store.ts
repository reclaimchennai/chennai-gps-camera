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

/**
 * "approximate" is a fix that arrived but is too coarse to place the
 * point inside a ward, village or police boundary — typically a
 * network/cell estimate. It is deliberately distinct from "ok": the
 * jurisdiction rows on the card are only as right as the fix, so a photo
 * taken on one must say so.
 */
export type GpsStatus = "waiting" | "ok" | "approximate" | "denied";

interface LiveState {
  fix: Fix | null;
  lookupResult: LookupResult | null;
  /**
   * The coordinate `lookupResult` was computed FOR.
   *
   * Without it the store held a jurisdiction with no idea where it came
   * from, and a capture paired the newest fix with whatever ward happened
   * to be sitting there — coordinates from one place, ward and police
   * station from another, with nothing on the card to show it.
   */
  lookupFor: { lat: number; lng: number } | null;
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
  setLookupResult(r: LookupResult, at: { lat: number; lng: number }): void;
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
 * Put installs back on the simple card, once.
 *
 * An earlier release made the street sign the default AND ran a one-time
 * migration (adoptStreetSign, keyed "gpscam-street-sign-default") that
 * moved every existing install from the simple card onto the sign. Users
 * have since said they prefer the simple card, and for most of them the
 * sign was never a choice — it was imposed twice over. This undoes that,
 * once, for anyone still on the sign.
 *
 * Someone who picks the sign deliberately from now on is remembered
 * ("gpscam-preset-chosen", set by the watermark editor) and is never
 * moved again. Nobody who picked it BEFORE today can be told apart from
 * someone who simply had it imposed, which is the honest limit of this —
 * and the reason the old migration should never have been silent.
 */
export function returnToSimpleCard(): void {
  try {
    if (localStorage.getItem("gpscam-simple-card-default") === "1") return;
    const st = useSettingsStore.getState();
    if (!st.hydrated) return;
    localStorage.setItem("gpscam-simple-card-default", "1");
    if (localStorage.getItem("gpscam-preset-chosen") === "1") return;
    if (st.watermark.preset === "chennai") {
      st.setWatermark({ ...st.watermark, preset: "detailed" });
    }
  } catch {
    // storage unavailable — leave the layout alone
  }
}

export const useLiveStore = create<LiveState>((set) => ({
  fix: null,
  lookupResult: null,
  lookupFor: null,
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
  setLookupResult: (lookupResult, lookupFor) => set({ lookupResult, lookupFor }),
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
  civicBodyNames: false,
  flashMode: "off",
  captureQuality: "auto",
  fullSensorStills: false,
  cameraEngine: "phone",
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
  returnToSimpleCard();
}

// run once the store exists
migrateAutoSaveForInstalledApps();
