import type { WatermarkConfig, WatermarkFields } from "../../types";

export const APP_NAME = "Chennai GPS Camera"; // working name — final branding TBD by owner

export const ALL_FIELDS: WatermarkFields = {
  brand: false, // branding-free cards — kept in the type for stored configs
  datetime: true,
  coords: true,
  digipin: false, // opt-in (§ DIGIPIN)
  altitudeAccuracy: false,
  address: true,
  titleLine: true,
  ward: true,
  zone: true,
  loStation: true,
  trafficStation: true,
  miniMap: true,
  compass: false,
  soundLevel: true,
  profilePhoto: false,
  socialHandles: false,
  customLabel: false,
};

export const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = {
  preset: "detailed",
  fields: { ...ALL_FIELDS },
  fontScale: 1,
  opacity: 0.55,
  theme: "dark",
  customLabelText: "",
  onlineMapUpgrade: false,
  position: "bottom",
};

export interface FieldMeta {
  key: keyof WatermarkFields;
  label: string;
  hint?: string;
}

export const FIELD_META: FieldMeta[] = [
  { key: "titleLine", label: "Locality title line", hint: "e.g. Kodambakkam, Chennai" },
  { key: "address", label: "Full address", hint: "Filled in when online" },
  { key: "coords", label: "GPS coordinates" },
  { key: "digipin", label: "DIGIPIN", hint: "India Post digital address code" },
  { key: "altitudeAccuracy", label: "Altitude & accuracy" },
  { key: "datetime", label: "Date & time" },
  { key: "ward", label: "Ward", hint: "GCC & Tambaram only" },
  { key: "zone", label: "Zone", hint: "GCC & Tambaram only" },
  { key: "loStation", label: "Police station (Law & Order)" },
  { key: "trafficStation", label: "Traffic police station" },
  { key: "miniMap", label: "Mini-map" },
  { key: "compass", label: "Compass bearing" },
  { key: "soundLevel", label: "Sound level (dB)", hint: "Approximate — phone mics are uncalibrated" },
  { key: "profilePhoto", label: "Profile photo" },
  { key: "socialHandles", label: "Social handles" },
  { key: "customLabel", label: "Custom label" },
];

export const PRESET_META: { key: WatermarkConfig["preset"]; label: string; hint: string }[] = [
  { key: "detailed", label: "Detailed card", hint: "Stacked panel with mini-map" },
  { key: "compact", label: "Compact bar", hint: "Single slim bar, essentials only" },
  { key: "minimal", label: "Corner badge", hint: "Coordinates + time badge" },
];
