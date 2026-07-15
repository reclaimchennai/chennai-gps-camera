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

/** "Wednesday, 08/07/2026 06:47 PM GMT +05:30" (§5.3 reference layout).
 *  The date portion follows the user's date-format setting. */
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
    `${pad(h)}:${pad(d.getMinutes())} ${ampm} ` +
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

/** "Teynampet" → "Zone Teynampet (9)"; "Zone 2" → "Zone 2";
 *  "Zone 5 Royapuram" → "Zone Royapuram (5)". */
export function fmtZone(zone?: string): string {
  if (!zone) return "";
  const m = zone.match(/^zone\s*(\d+)\s*(.*)$/i);
  if (m) {
    const name = m[2].trim();
    return name ? `Zone ${name} (${Number(m[1])})` : `Zone ${Number(m[1])}`;
  }
  const num = GCC_ZONE_NUMBERS[zone.trim().toLowerCase()];
  return num ? `Zone ${zone} (${num})` : `Zone ${zone}`;
}
