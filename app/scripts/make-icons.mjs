#!/usr/bin/env node
/** Rasterize the app icon SVG into the PWA icon set. */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

// Location pin with a camera-lens head on a deep-navy tile.
const icon = (pad = 0) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#134e6f"/>
    </linearGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7dd3fc"/>
      <stop offset="1" stop-color="#38bdf8"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="108" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <path d="M256 84c-77 0-140 62-140 139 0 96 118 194 133 206a11 11 0 0 0 14 0c15-12 133-110 133-206 0-77-63-139-140-139z"
      fill="url(#ring)"/>
    <circle cx="256" cy="222" r="86" fill="#0b1220"/>
    <circle cx="256" cy="222" r="62" fill="none" stroke="#7dd3fc" stroke-width="14"/>
    <circle cx="256" cy="222" r="26" fill="#38bdf8"/>
    <circle cx="238" cy="204" r="9" fill="#e0f2fe"/>
  </g>
</svg>`;

const jobs = [
  ["icon-192.png", 192, 0],
  ["icon-512.png", 512, 0],
  ["icon-maskable-512.png", 512, 0.18],
  ["apple-touch-icon.png", 180, 0],
  ["favicon-64.png", 64, 0],
];

for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(icon(pad))).resize(size, size).png().toFile(join(OUT, name));
  console.log(`${name} (${size}px)`);
}
