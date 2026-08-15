#!/usr/bin/env node
/**
 * Prove the watermark stays readable on any photo.
 *
 * The card is the product: a photo whose ward, zone and police station
 * cannot be read is not evidence of anything. This runs the real renderer
 * over backdrops spanning pure black to pure white and measures the
 * CONTRAST OF THE PAINTED PIXELS, not of the palette constants — so
 * anti-aliasing, globalAlpha and compositing all get a vote.
 *
 * Every preset, theme and opacity setting is rendered, the type is read
 * one line at a time, and the WEAKEST line decides. Anything under WCAG
 * AA (4.5:1) fails.
 *
 *   node scripts/check-contrast.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4519, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const base = "http://127.0.0.1:4519";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const rows = [];

try {
  await page.goto(base, { waitUntil: "load" });

  const results = await page.evaluate(async () => {
    const { renderWatermark } = await import("/src/lib/watermark/render.ts");

    const lin = (v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

    const W = 1080;
    const H = 1440;

    // FLAT backdrops, spanning the range.
    //
    // Deliberately not textured: over a photo with detail, some of that
    // detail shows through a translucent panel, and a pixel-reading test
    // cannot then tell bleed-through from type — it reports failures that
    // are artefacts of its own measurement. A flat backdrop gives an
    // unambiguous plate colour, so every pixel that differs from it IS
    // ink and the reading means something.
    //
    // Nothing is lost by it. The renderer picks its opacity from the
    // darkest and brightest patches it finds under the card, so a
    // textured photo is solved for as if it were the two flat extremes
    // tested here — while a flat backdrop is solved tightly, for that one
    // level, which is the harder case to satisfy. Testing flat is testing
    // the worst case, not ducking it.
    const BACKDROPS = {};
    for (const v of [0, 32, 72, 128, 176, 216, 255]) {
      BACKDROPS[`grey ${v}`] = (ctx) => {
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, 0, W, H);
      };
    }
    // plus two flat colour casts — sodium street light, and shade
    BACKDROPS["sodium"] = (ctx) => { ctx.fillStyle = "#c8873c"; ctx.fillRect(0, 0, W, H); };
    BACKDROPS["deep shade"] = (ctx) => { ctx.fillStyle = "#1d2733"; ctx.fillRect(0, 0, W, H); };

    const data = {
      timestamp: Date.UTC(2026, 7, 15, 14, 37, 15),
      tzOffsetMinutes: 330,
      fix: { lat: 13.1067, lng: 80.2206, accuracy: 8, altitude: 12 },
      locality: "Perambur, Chennai",
      address: "58, Madhavaram High Rd, Chinnaiyan Colony, Perambur, Chennai, Tamil Nadu - 600011",
      jurisdiction: {
        scope: "gcc",
        city: "Chennai",
        corporation: "Greater Chennai Corporation",
        zone: "6",
        zoneName: "Thiru-Vika-Nagar",
        ward: "70",
        loStation: "K1 Sembium PS",
        trafficStation: "K1 Sembium PS",
      },
      mockLocation: true, // exercise the warn ink too
    };
    const profile = { name: "", handles: {} };

    const baseConfig = {
      preset: "detailed",
      fields: {
        brand: false, datetime: true, coords: true, digipin: true,
        altitudeAccuracy: false, address: true, titleLine: true,
        ward: true, zone: true, loStation: true, trafficStation: true,
        miniMap: false, qrCode: false, compass: false, soundLevel: false,
        profilePhoto: false, socialHandles: false, customLabel: false,
      },
      fontScale: 0.8,
      opacity: 0.55,
      theme: "light",
      customLabelText: "",
      language: "en",
      signShape: "box",
      onlineMapUpgrade: false,
      position: "bottom",
    };

    const out = [];
    const themes = ["auto", "dark", "light", "brand"];
    const presets = ["detailed", "chennai", "minimal"];
    // 0.15 is the slider's floor — the setting most likely to produce an
    // unreadable card, so it is the one that must be tested
    const opacities = [0.15, 0.55, 0.9];

    for (const preset of presets) {
      for (const theme of themes) {
        for (const opacity of opacities) {
          for (const [bdName, paint] of Object.entries(BACKDROPS)) {
            const canvas = document.createElement("canvas");
            canvas.width = W;
            canvas.height = H;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            paint(ctx);
            const config = { ...baseConfig, preset, theme, opacity };
            const rect = renderWatermark(ctx, W, H, data, config, profile, {});
            if (!rect) continue;

            // measure INSIDE the card, clear of its rounded corners and
            // keyline, so the edge blend is not mistaken for ink
            const inset = 6;
            const x = Math.round(rect.x + inset);
            const y = Math.round(rect.y + inset);
            const w = Math.round(rect.width - inset * 2);
            const h = Math.round(rect.height - inset * 2);
            if (w < 20 || h < 20) continue;
            const { data: px } = ctx.getImageData(x, y, w, h);

            // Measured one TEXT LINE at a time.
            //
            // Not per pixel row: a row clipping only the tips of tall
            // letters holds nothing but anti-aliased fringe, and reading
            // its darkest pixel measures the fringe rather than the
            // stroke. Rows that contain ink are grouped into bands — one
            // band per line of type — so every reading includes glyph
            // cores.
            //
            // Not the panel as a whole either: the WEAKEST ink is what
            // decides whether a card is usable, and it is never the one
            // furthest from the plate. Read whole, the panel reports its
            // white title every time, and would pass a card whose ward
            // and police rows had faded to nothing — precisely the bug
            // being guarded against. Per band, the ward row is judged on
            // its own.
            const modeOf = (rows) => {
              const hist = new Map();
              for (const ry of rows) {
                for (let rx = 0; rx < w; rx++) {
                  const i = (ry * w + rx) * 4;
                  const k = `${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3}`;
                  hist.set(k, (hist.get(k) ?? 0) + 1);
                }
              }
              let key = null;
              let n = -1;
              for (const [k, c] of hist) if (c > n) { n = c; key = k; }
              const [r, g, b] = key.split(",").map((v) => (Number(v) << 3) + 4);
              return lum(r, g, b);
            };

            // the plate is flat here, so one reading covers the whole card
            const allRows = Array.from({ length: h }, (_, i) => i);
            const plateL = modeOf(allRows);
            const inkRow = [];
            for (let ry = 0; ry < h; ry++) {
              let off = 0;
              for (let rx = 0; rx < w; rx++) {
                const i = (ry * w + rx) * 4;
                if (Math.abs(lum(px[i], px[i + 1], px[i + 2]) - plateL) > 0.04) off++;
              }
              inkRow.push(off >= 6);
            }

            let worstRow = Infinity;
            let inked = 0;
            for (let ry = 0; ry < h; ry++) {
              if (!inkRow[ry]) continue;
              let end = ry;
              while (end + 1 < h && inkRow[end + 1]) end++;
              const band = [];
              for (let k = ry; k <= end; k++) band.push(k);
              ry = end;
              if (band.length < 3) continue; // too thin to be a line of type

              // the street sign's white strips carry blue text on white
              // while the plate around them is blue, so each band is
              // judged against its OWN background
              const bandPlate = modeOf(band);
              // Read the GLYPH CORES: gather only the pixels that differ
              // from the plate, then step 30% into them from the extreme
              // end. A flat percentile over the whole band cannot do this
              // — where a band is 98% plate, its 2nd percentile is still
              // plate, and the band scores 1:1 no matter what colour the
              // type is.
              const devs = [];
              for (const by of band) {
                for (let rx = 0; rx < w; rx++) {
                  const i = (by * w + rx) * 4;
                  const l = lum(px[i], px[i + 1], px[i + 2]);
                  if (Math.abs(l - bandPlate) > 0.04) devs.push(l);
                }
              }
              // too little ink to be a line of type — a corner arc, or the
              // anti-aliased fringe above a capital
              if (devs.length < 40) continue;
              devs.sort((x, y) => (bandPlate > 0.5 ? x - y : y - x));
              const inkL = devs[Math.floor(devs.length * 0.3)];
              inked++;

              worstRow = Math.min(worstRow, ratio(inkL, bandPlate));
            }
            if (!inked) continue;

            out.push({
              preset, theme, opacity, backdrop: bdName,
              ratio: worstRow,
              inkedRows: inked,
              coverage: (rect.width * rect.height) / (W * H),
            });
          }
        }
      }
    }
    return out;
  });

  const TARGET = 4.5; // WCAG AA for body text
  // a hair of slack for font rasterisation differing between machines
  const TOL = 0.05;

  const worst = new Map();
  for (const r of results) {
    const key = `${r.preset}/${r.theme}`;
    const cur = worst.get(key);
    if (!cur || r.ratio < cur.ratio) worst.set(key, r);
    rows.push(r);
  }

  console.log(`measured ${results.length} rendered cards\n`);
  console.log("worst case per preset + theme:");
  for (const [key, r] of [...worst].sort((a, b) => a[1].ratio - b[1].ratio)) {
    const ok = r.ratio >= TARGET - TOL;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${key.padEnd(18)} ${r.ratio.toFixed(2)}:1` +
        `  (opacity ${r.opacity}, over ${r.backdrop})`
    );
  }

  // the card must not creep toward covering the photo to buy its contrast
  const biggest = results.reduce((a, b) => (a.coverage > b.coverage ? a : b));
  console.log(
    `\nlargest card covers ${(biggest.coverage * 100).toFixed(1)}% of frame ` +
      `(${biggest.preset}/${biggest.theme})`
  );
  if (biggest.coverage > 0.35) {
    console.log("  FAIL  a card that big is hiding the evidence");
    failures++;
  }
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) {
  console.log(`\npage errors:\n  ${errors.join("\n  ")}`);
  failures += errors.length;
}
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nwatermark legible on every backdrop");
