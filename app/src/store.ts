import { create } from "zustand";
import type {
  AppSettings,
  Fix,
  Profile,
  WatermarkConfig,
} from "./types";
import type { LookupResult } from "./lib/geo/lookup";
import { kvGet, kvSet } from "./lib/db";
import { DEFAULT_WATERMARK_CONFIG } from "./lib/watermark/presets";

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
  setFix(fix: Fix): void;
  setLookupResult(r: LookupResult): void;
  setBearing(b: number): void;
  setGpsStatus(s: GpsStatus): void;
  setAddress(
    addr: string | undefined,
    locality: string | undefined,
    at: { lat: number; lng: number } | null
  ): void;
}

export const useLiveStore = create<LiveState>((set) => ({
  fix: null,
  lookupResult: null,
  bearing: undefined,
  gpsStatus: "waiting",
  address: undefined,
  locality: undefined,
  addressFor: null,
  setFix: (fix) => set({ fix }),
  setLookupResult: (lookupResult) => set({ lookupResult }),
  setBearing: (bearing) => set({ bearing }),
  setGpsStatus: (gpsStatus) => set({ gpsStatus }),
  setAddress: (address, locality, addressFor) =>
    set({ address, locality, addressFor }),
}));

// ---- Persistent settings ----------------------------------------------

export const DEFAULT_SETTINGS: AppSettings = {
  shutterSound: true,
  gridLines: false,
  mirrorFrontPhoto: false,
  autoSaveToDevice: true,
  appTheme: "system",
  dateFormat: "DD/MM/YYYY",
  liveFaceBlur: false,
  googleApiKey: "",
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
