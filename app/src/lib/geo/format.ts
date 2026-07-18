/** Display formatting for coordinates, dates, and jurisdiction lines. */
import { useSettingsStore } from "../../store";

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(6)}°${lat >= 0 ? "N" : "S"}`;
}

export function fmtLng(lng: number): string {
  return `${Math.abs(lng).toFixed(6)}°${lng >= 0 ? "E" : "W"}`;
}

export function fmtCoordsLine(lat: number, lng: number): string {
  return `Lat ${lat.toFixed(6)}°  Long ${lng.toFixed(6)}°`;
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

/** "Wednesday, 08/07/2026 06:47:32 PM GMT +05:30" (§5.3 reference layout).
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
  return (
    `${WEEKDAYS[d.getDay()]}, ${fmtDateOnly(ts, format)} ` +
    `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm} ` +
    `GMT ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function fmtAltAccuracy(
  altitude?: number | null,
  accuracy?: number
): string {
  const parts: string[] = [];
  if (altitude != null) parts.push(`Alt ${altitude.toFixed(0)} m`);
  if (accuracy != null) parts.push(`±${accuracy.toFixed(0)} m`);
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
    return name ? `Zone ${Number(leading[1])} (${name})` : `Zone ${Number(leading[1])}`;
  }

  // "Gandhinagar (2)" — name with the number already parenthesised
  const trailing = raw.match(/^(.+?)\s*\((\d+)\)$/);
  if (trailing) return `Zone ${Number(trailing[2])} (${trailing[1].trim()})`;

  // bare name — only Chennai's zones are numbered without embedding the
  // number in the data itself
  const num = GCC_ZONE_NUMBERS[raw.toLowerCase()];
  return num ? `Zone ${num} (${raw})` : `Zone ${raw}`;
}
