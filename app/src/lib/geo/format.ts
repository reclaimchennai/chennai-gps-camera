/** Display formatting for coordinates, dates, and jurisdiction lines. */
import { useSettingsStore } from "../../store";
import { tamilPlace } from "./tamil-places";

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? "N" : "S"}`;
}

export function fmtLng(lng: number): string {
  return `${Math.abs(lng).toFixed(6)}°${lng >= 0 ? "E" : "W"}`;
}

/**
 * Localised labels for the numeric rows.
 *
 * Tamil and Hindi weekday names are long — "வெள்ளிக்கிழமை" is twice the width
 * of "Friday" — so the localised date line uses the ABBREVIATED weekday
 * and month. A full Tamil date pushed the row past the plate and got
 * shrunk to the point of being harder to read than the abbreviation.
 */
const LOCALE: Record<string, string> = {
  en: "en-IN",
  ta: "ta-IN",
  hi: "hi-IN",
};

function cardLang(): string {
  const l = useSettingsStore.getState().watermark?.language;
  return l === "ta" || l === "hi" ? l : "en";
}

const COORD_LABELS: Record<string, { lat: string; lng: string }> = {
  en: { lat: "Lat", lng: "Long" },
  ta: { lat: "அட்சம்", lng: "நீளம்" },
  hi: { lat: "अक्षांश", lng: "देशांतर" },
};

export function fmtCoordsLine(lat: number, lng: number): string {
  const l = COORD_LABELS[cardLang()] ?? COORD_LABELS.en;
  return `${l.lat} ${lat.toFixed(6)}°  ${l.lng} ${lng.toFixed(6)}°`;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Date portion in the given user format ("11/07/2026", "11 July 2026", …). */
export function fmtDateOnly(
  ts: number,
  format: "DD/MM/YYYY" | "D MMMM YYYY" | "D MMM YYYY"
): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (format === "D MMMM YYYY")
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  if (format === "D MMM YYYY")
    return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** "Wednesday, 08/07/2026 06:47:32 PM UTC+05:30" (§5.3 reference layout).
 *  The date portion follows the user's date-format setting. Seconds are
 *  included so video watermarks can tick in real time. */
export function fmtDateLine(ts: number, tzOffsetMinutes: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const off = -tzOffsetMinutes; // JS offset is minutes *behind* UTC
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);

  const format = useSettingsStore.getState().settings.dateFormat;
  const lang = cardLang();
  if (lang !== "en") {
    const loc = LOCALE[lang];
    let wd: string, dm: string, mer: string;
    try {
      wd = new Intl.DateTimeFormat(loc, { weekday: "short" }).format(d);
      dm = new Intl.DateTimeFormat(loc, {
        day: "numeric", month: "short", year: "numeric",
      }).format(d);
      // ICU returns Latin "AM"/"PM" for ta-IN, so use the Tamil/Hindi
      // abbreviations directly rather than shipping a half-Tamil clock
      const MER: Record<string, [string, string]> = {
        ta: ["மு.ப.", "பி.ப."],
        hi: ["पूर्वाह्न", "अपराह्न"],
      };
      mer = MER[lang] ? MER[lang][ampm === "AM" ? 0 : 1] : ampm;
    } catch {
      // no ICU data for this locale here — an English row beats a thrown
      // renderer and a blank card
      wd = WEEKDAYS[d.getDay()];
      dm = fmtDateOnly(ts, format);
      mer = ampm;
    }
    return (
      `${wd}, ${dm} ` +
      `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${mer} ` +
      `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  }
  return (
    `${WEEKDAYS[d.getDay()]}, ${fmtDateOnly(ts, format)} ` +
    `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm} ` +
    `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function fmtAltAccuracy(
  altitude?: number | null,
  accuracy?: number
): string {
  const parts: string[] = [];
  const l = cardLang();
  const altL = l === "ta" ? "உயரம்" : l === "hi" ? "ऊंचाई" : "Alt";
  const m = l === "ta" ? "மீ" : l === "hi" ? "मी" : "m";
  if (altitude != null) parts.push(`${altL} ${altitude.toFixed(0)} ${m}`);
  if (accuracy != null) parts.push(`±${accuracy.toFixed(0)} ${m}`);
  return parts.join("  ");
}

const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

export function fmtBearing(deg: number): string {
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return `${COMPASS_POINTS[idx]} ${Math.round(((deg % 360) + 360) % 360)}°`;
}

export function fmtWard(ward?: string): string {
  if (!ward) return "";
  // Ward numbers come zero-padded from the shapefile ("028")
  const n = ward.replace(/^0+/, "");
  return n || ward;
}

/** Official GCC zone numbering — the boundary data carries names only. */
const GCC_ZONE_NUMBERS: Record<string, number> = {
  thiruvottriyur: 1,
  manali: 2,
  madhavaram: 3,
  tondiarpet: 4,
  royapuram: 5,
  "thiru-vika-nagar": 6,
  ambattur: 7,
  "anna nagar": 8,
  teynampet: 9,
  kodambakkam: 10,
  valasarvakkam: 11,
  alandur: 12,
  adyar: 13,
  perungudi: 14,
  shozhanganallur: 15,
};

/** Number-first, name in brackets — same convention as fmtWard, so the
 *  zone and ward read consistently everywhere, regardless of how each
 *  city pack happens to encode the raw value:
 *  "Teynampet" → "Zone 9 (Teynampet)" (Chennai, via the lookup table)
 *  "Zone 5 Royapuram" → "Zone 5 (Royapuram)" (Chennai, "Zone N Name")
 *  "Gandhinagar (2)" → "Zone 2 (Gandhinagar)" (Bengaluru, "Name (N)")
 *  "Zone 2" → "Zone 2"; boroughs pass through unchanged. */
export function fmtZone(zone?: string): string {
  if (!zone) return "";
  const lang = cardLang();
  // the word itself, and the place inside the brackets, both follow the
  // card's language — a Tamil footer reading "மண்டலம் : Zone 5 (Royapuram)"
  // was the last Latin island on an otherwise Tamil card
  const ZONE_W = lang === "ta" ? "மண்டலம்" : lang === "hi" ? "क्षेत्र" : "Zone";
  const nm = (v: string): string =>
    (lang === "ta" ? tamilPlace(v) : null) ?? v;
  // Kolkata-style boroughs are their own term — no "Zone" prefix
  if (/^borough/i.test(zone)) return zone;
  // "North Zone" → "North" (the prefix we add would double the word)
  let raw = zone.replace(/\s+zone$/i, "").trim();
  // "Zone 5 Royapuram" / "Zone 2" → strip the leading word, keep the rest
  raw = raw.replace(/^zone\s*/i, "").trim();

  // "5 Royapuram" or bare "2" (no name to bracket)
  const leading = raw.match(/^(\d+)(?:\s+(.+))?$/);
  if (leading) {
    const name = leading[2]?.trim();
    return name
      ? `${ZONE_W} ${Number(leading[1])} (${nm(name)})`
      : `${ZONE_W} ${Number(leading[1])}`;
  }

  // "Gandhinagar (2)" — name with the number already parenthesised
  const trailing = raw.match(/^(.+?)\s*\((\d+)\)$/);
  if (trailing) return `${ZONE_W} ${Number(trailing[2])} (${nm(trailing[1].trim())})`;

  // bare name — only Chennai's zones are numbered without embedding the
  // number in the data itself
  const num = GCC_ZONE_NUMBERS[raw.toLowerCase()];
  return num ? `${ZONE_W} ${num} (${nm(raw)})` : `${ZONE_W} ${nm(raw)}`;
}
