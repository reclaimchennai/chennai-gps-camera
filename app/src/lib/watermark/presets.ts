import type { WatermarkConfig, WatermarkFields, WatermarkLang } from "../../types";
import { LANGS, langsFor } from "../i18n/languages";

export const APP_NAME = "Chennai GPS Camera"; // working name — final branding TBD by owner

export const ALL_FIELDS: WatermarkFields = {
  brand: false, // branding-free cards — kept in the type for stored configs
  datetime: true,
  coords: true,
  digipin: true, // on by default (§ DIGIPIN) — India Post offline code
  altitudeAccuracy: false,
  address: true,
  titleLine: true,
  ward: true,
  zone: true,
  loStation: true,
  trafficStation: true,
  miniMap: true,
    qrCode: false,
  compass: false,
  soundLevel: true,
  profilePhoto: false,
  socialHandles: false,
  customLabel: false,
};

export const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = {
  preset: "detailed",
  fields: { ...ALL_FIELDS },
  fontScale: 0.8, // smallest by default — users can size it up in the editor
  opacity: 0.55,
  theme: "dark",
  customLabelText: "",
  language: "en", // default English regardless of template (owner decision)
  signShape: "box", // owner default; the arrows remain a choice
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
  { key: "ward", label: "Ward", hint: "Where boundary data exists — see About for coverage" },
  { key: "zone", label: "Zone", hint: "Where boundary data exists — see About for coverage" },
  { key: "loStation", label: "Police station (Law & Order)" },
  { key: "trafficStation", label: "Traffic police station" },
  { key: "miniMap", label: "Mini-map" },
  { key: "qrCode", label: "Location QR (maps link + DIGIPIN)" },
  { key: "compass", label: "Compass bearing" },
  { key: "soundLevel", label: "Noise level (dB)", hint: "Approximate — phone mics are uncalibrated" },
  { key: "profilePhoto", label: "Profile photo" },
  { key: "socialHandles", label: "Social handles" },
  { key: "customLabel", label: "Custom label" },
];

export const PRESET_META: { key: WatermarkConfig["preset"]; label: string; hint: string }[] = [
  { key: "detailed", label: "Detailed card", hint: "Stacked panel with mini-map" },
  { key: "compact", label: "Compact bar", hint: "Single slim bar, essentials only" },
  { key: "minimal", label: "Corner badge", hint: "Coordinates + time badge" },
  {
    key: "chennai",
    label: "Street sign",
    hint: "Chennai-style civic board, addressed to your local body",
  },
];

/**
 * Languages to show, for wherever the user currently is. English first,
 * then the state's language, then Hindi. The card language is offered on
 * EVERY city we cover, not only the ones with a bespoke street sign —
 * a Kolkata user gets a Bengali card on the standard layout.
 */
export const SIGN_SHAPE_META: {
  key: WatermarkConfig["signShape"];
  label: string;
}[] = [
  { key: "arrow-left", label: "Arrow left" },
  { key: "arrow-right", label: "Arrow right" },
  { key: "arrow-both", label: "Both ends" },
  { key: "box", label: "Rectangle" },
];

export function langMeta(
  packId: string | null,
  current?: WatermarkLang
): { key: WatermarkLang; label: string }[] {
  const keys = langsFor(packId);
  // Always offer the language already in use. Outside a covered area the
  // list collapses to English + Hindi, which hid the user's own choice
  // and left no way to switch back off it.
  if (current && !keys.includes(current)) keys.push(current);
  return keys.map((key) => ({ key, label: LANGS[key].label }));
}
