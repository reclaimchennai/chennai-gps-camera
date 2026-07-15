/**
 * DIGIPIN — India Post's open-source 10-character geocode.
 *
 * Direct port of the official encoder from the Department of Posts
 * reference implementation (github.com/INDIAPOST-gov/digipin,
 * src/digipin.js) — the math is copied verbatim so codes always match
 * India Post's. Per the current official spec the output is a
 * continuous 10-character string with no separators.
 *
 * Verified against the official implementation:
 *   (13.11179621, 80.20264269) → "4T396F42L7"  (official doc example)
 *   (13.0405, 80.2337)         → "4T32886P6J"
 *
 * Pure math — works fully offline, anywhere inside the DIGIPIN bounding
 * box (lat 2.5–38.5 N, lon 63.5–99.5 E, i.e. country-wide for India).
 */

const DIGIPIN_GRID = [
  ["F", "C", "9", "8"],
  ["J", "3", "2", "7"],
  ["K", "4", "5", "6"],
  ["L", "M", "P", "T"],
] as const;

const BOUNDS = {
  minLat: 2.5,
  maxLat: 38.5,
  minLon: 63.5,
  maxLon: 99.5,
};

/** Encode to a DIGIPIN, or null when outside the official bounding box. */
export function latLngToDigipin(lat: number, lon: number): string | null {
  if (lat < BOUNDS.minLat || lat > BOUNDS.maxLat) return null;
  if (lon < BOUNDS.minLon || lon > BOUNDS.maxLon) return null;

  let minLat = BOUNDS.minLat;
  let maxLat = BOUNDS.maxLat;
  let minLon = BOUNDS.minLon;
  let maxLon = BOUNDS.maxLon;

  let digiPin = "";

  for (let level = 1; level <= 10; level++) {
    const latDiv = (maxLat - minLat) / 4;
    const lonDiv = (maxLon - minLon) / 4;

    // reversed row logic — rows count from the north (per official code)
    let row = 3 - Math.floor((lat - minLat) / latDiv);
    let col = Math.floor((lon - minLon) / lonDiv);

    row = Math.max(0, Math.min(row, 3));
    col = Math.max(0, Math.min(col, 3));

    digiPin += DIGIPIN_GRID[row][col];

    maxLat = minLat + latDiv * (4 - row);
    minLat = minLat + latDiv * (3 - row);

    minLon = minLon + lonDiv * col;
    maxLon = minLon + lonDiv;
  }

  return digiPin;
}
