/** Shared domain types. */

// ---- Location & jurisdiction --------------------------------------

export interface Fix {
  lat: number;
  lng: number;
  accuracy?: number; // metres
  altitude?: number | null; // metres
  heading?: number | null; // degrees, from GPS velocity
  timestamp: number;
}

/**
 * Scope honesty: "in" = at least one jurisdiction layer matched in the
 * active region pack; "out" = nothing matched (GPS-only). The legacy
 * values ("gcc" | "tambaram" | "avadi") survive in photos captured by
 * older versions and must keep rendering.
 */
export type Scope = "in" | "out" | "gcc" | "tambaram" | "avadi";

export interface Jurisdiction {
  scope: Scope;
  corporation?: string; // display name, e.g. "Bengaluru Central City Corporation"
  city?: string; // for the title line ("Bengaluru", "Coimbatore", …)
  ward?: string;
  wardName?: string; // e.g. "Sampangirama Nagar" where the data names wards
  zone?: string;
  /** corporation known but ward boundaries not yet published (Avadi) */
  wardPending?: boolean;
  loStation?: string;
  loMeta?: string; // "AC · DC · Zone" enrichment line (Chennai data)
  loPhone?: string;
  trafficStation?: string;
  trafficMeta?: string; // "Sub-Division · District"
}

// ---- Watermark -----------------------------------------------------

export type LayoutPreset = "detailed" | "compact" | "minimal";
export type WatermarkTheme = "dark" | "light" | "brand";

export interface WatermarkFields {
  brand: boolean;
  datetime: boolean;
  coords: boolean;
  digipin: boolean;
  altitudeAccuracy: boolean;
  address: boolean;
  titleLine: boolean;
  ward: boolean;
  zone: boolean;
  loStation: boolean;
  trafficStation: boolean;
  miniMap: boolean;
  compass: boolean;
  /** Live ambient sound level (approximate dB) from the microphone. */
  soundLevel: boolean;
  profilePhoto: boolean;
  socialHandles: boolean;
  customLabel: boolean;
}

export interface WatermarkConfig {
  preset: LayoutPreset;
  fields: WatermarkFields;
  fontScale: number; // 0.8 – 1.4
  opacity: number; // panel background alpha 0 – 1
  theme: WatermarkTheme;
  customLabelText: string;
  /** Online Google-map thumbnail upgrade when connectivity allows (§5.4). */
  onlineMapUpgrade: boolean;
  /** Where the card sits on the photo. */
  position:
    | "bottom"
    | "top"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right";
}

/** Everything the renderer may stamp. Resolved at capture time. */
export interface WatermarkData {
  fix: Fix | null;
  jurisdiction: Jurisdiction | null;
  address?: string; // reverse-geocoded, may arrive later
  locality?: string; // for the bold title line
  bearing?: number; // compass, degrees
  digipin?: string; // India Post DIGIPIN, computed offline when enabled
  /** Ambient sound level at capture, approximate dB (uncalibrated mic). */
  db?: number;
  /** Session sound statistics (since the app was opened). */
  dbStats?: { avg: number; min: number; max: number };
  timestamp: number;
  tzOffsetMinutes: number;
}

// ---- Profile --------------------------------------------------------

export interface SocialHandle {
  id: string;
  platform: string; // Instagram, X, Facebook, YouTube, LinkedIn, Other
  handle: string;
  show: boolean;
}

export interface Profile {
  displayName: string;
  hasPhoto: boolean; // photo blob lives in the db `assets` store
  handles: SocialHandle[];
}

// ---- Media records ---------------------------------------------------

export type BackfillStatus = "pending" | "done" | "failed" | "not-needed";

export interface PhotoRecord {
  id: string;
  kind: "photo";
  createdAt: number;
  width: number;
  height: number;
  data: WatermarkData;
  config: WatermarkConfig; // config used at capture, for re-composite
  backfill: BackfillStatus;
  hasRaw: boolean; // un-watermarked original retained for backfill
  /** device-download state: "queued" = waiting for the watermark info to
   *  finish (backfill) before the file is saved to the device */
  download?: "queued" | "done";
  annotatedFrom?: string; // id of source photo if this is a flattened copy
  tags?: string[]; // user-assigned, searchable in the gallery
}

export interface VideoRecord {
  id: string;
  kind: "video";
  createdAt: number;
  duration: number; // seconds
  width: number;
  height: number;
  mimeType: string;
  data: WatermarkData;
  config: WatermarkConfig;
  exported?: boolean; // true for editor-exported (burned) copies
  tags?: string[]; // user-assigned, searchable in the gallery
  /** recorded with the experimental live-blur setting on — the editor
   *  pre-enables auto face blur for the export */
  liveBlur?: boolean;
  /** face blur was composited into the recording itself — the file on
   *  disk is already blurred, no export needed for privacy */
  blurBurned?: boolean;
  /** the watermark card is already burned into the recording (live) —
   *  the editor must not stamp it a second time on export */
  watermarkBurned?: boolean;
  /** street address was missing at record time — the queue fills
   *  record.data in later so exports/shares carry the full watermark */
  backfill?: BackfillStatus;
}

export type MediaRecord = PhotoRecord | VideoRecord;

// ---- Settings ---------------------------------------------------------

export type AppTheme = "system" | "light" | "dark";

/** Watermark/UI date style. Tokens follow common date-format notation. */
export type DateFormat = "DD/MM/YYYY" | "D MMMM YYYY" | "D MMM YYYY";

export interface AppSettings {
  gridLines: boolean;
  mirrorFrontPhoto: boolean;
  /** Auto-download each captured photo to the device (Downloads folder
   *  on the web build; gallery apps index it). */
  autoSaveToDevice: boolean;
  /** UI theme; "system" follows prefers-color-scheme. */
  appTheme: AppTheme;
  dateFormat: DateFormat;
  /** EXPERIMENTAL: on-device face blur in the live viewfinder; burns into
   *  photos at capture, pre-arms auto-blur for video exports. */
  liveFaceBlur: boolean;
  /** User calibration offset (dB) added to the sound meter so it can be
   *  matched against a reference noise-meter app. */
  dbCalibration: number;
  /** Optional Google Cloud key for the PWA geocode/static-map upgrade (§7). */
  googleApiKey: string;
  /** Optional Mappls (MapmyIndia) key — Indian addresses, user-supplied. */
  mapplsApiKey: string;
  /** "system" = the Android OS geocoder; only offered in the native app. */
  geocoder: "auto" | "system" | "google" | "mappls" | "nominatim" | "off";
}
