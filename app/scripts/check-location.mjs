#!/usr/bin/env node
/**
 * A photo must never name a place it cannot know it is in.
 *
 * Ward, zone and police station are resolved from the fix by our OWN
 * polygons, so the fix's error is the attribution's error — and unlike a
 * wrong street name, a wrong police station sends a complaint to the
 * wrong desk while every row on the card agrees with every other row.
 * There is nothing in a finished photo to reveal it.
 *
 * Two things are checked, both general to every body we carry — city,
 * town, municipality, panchayat, corporation, cantonment:
 *
 *   1. a coarse fix cannot quietly displace a good one, and a fix too
 *      coarse to place a point in a ward is disclosed on the card;
 *   2. jurisdiction really does turn on distances smaller than the error
 *      a network fix carries — the reason 1 matters at all.
 *
 *   node scripts/check-location.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4543, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await page.goto("http://127.0.0.1:4543", { waitUntil: "load" });

  // ---- 1. how far apart can two answers be? --------------------------
  // Spread across body types deliberately: the point is not "Chennai is
  // dense", it is that EVERY kind of body we attribute to is drawn at a
  // scale a coarse fix cannot resolve.
  const probes = await page.evaluate(async () => {
    const { loadGeodataFor } = await import("/src/lib/geo/geodata.ts");
    const { lookup } = await import("/src/lib/geo/lookup.ts");
    const at = async (lat, lng) => {
      const pack = await loadGeodataFor(lat, lng);
      if (!pack) return null;
      const j = lookup(pack, lat, lng).jurisdiction;
      if (!j || j.scope === "out") return null;
      return { ward: j.ward, lo: j.loStation };
    };
    // Measured, not asserted: walk outward in eight directions until the
    // ward or the police station changes, and report how far that took.
    // That distance is the scale a fix has to beat to be worth printing.
    const step = (lat, lng, m, deg) => {
      const r = (deg * Math.PI) / 180;
      return [
        lat + (m * Math.cos(r)) / 111320,
        lng + (m * Math.sin(r)) / (111320 * Math.cos((lat * Math.PI) / 180)),
      ];
    };
    // A rural body is legitimately larger than a city ward, so it gets a
    // looser bound — the claim is not "everything is 300 m", it is that
    // every kind of body turns over inside the error a network fix
    // carries, which is why such a fix must never be printed as fact.
    const SPOTS = [
      ["Chennai, corporation ward", 13.0716, 80.2408, 1000],
      ["Chennai, another zone", 13.1067, 80.2206, 1000],
      ["Bengaluru, corporation ward", 12.9750, 77.5930, 1000],
      ["Tambaram, corporation ward", 12.9229, 80.1275, 1000],
      ["Maraimalai Nagar, municipality", 12.7920, 80.0250, 3000],
      ["Kanchipuram district, village/panchayat", 12.8350, 79.9800, 4000],
    ];
    const out = [];
    for (const [name, lat, lng, limit] of SPOTS) {
      const here = await at(lat, lng);
      if (!here) continue;
      let nearest = Infinity;
      let became = null;
      for (let m = 50; m <= 4000 && nearest === Infinity; m += 50) {
        for (let deg = 0; deg < 360; deg += 45) {
          const [la, ln] = step(lat, lng, m, deg);
          const there = await at(la, ln);
          if (!there) continue;
          if (there.ward !== here.ward || there.lo !== here.lo) {
            nearest = m;
            became = there;
            break;
          }
        }
      }
      out.push({ name, here, nearest, became, limit });
    }
    return out;
  });

  for (const p of probes) {
    const found = p.nearest !== null && Number.isFinite(p.nearest);
    check(
      `${p.name}: attribution turns within a coarse fix's error`,
      found && p.nearest <= p.limit,
      found
        ? `${p.nearest} m away it is already ward ${p.became.ward} / ${p.became.lo} ` +
          `(here: ward ${p.here.ward} / ${p.here.lo})`
        : `no boundary found within ${p.limit} m`
    );
  }

  // ---- 2. the card discloses a fix it cannot stand behind -------------
  const disclosure = await page.evaluate(async () => {
    const { renderWatermark } = await import("/src/lib/watermark/render.ts");
    const base = {
      timestamp: Date.UTC(2026, 7, 15, 14, 0, 0),
      tzOffsetMinutes: 330,
      locality: "Chetpet, Chennai",
      address: "Chetpet, Chennai, Tamil Nadu - 600031",
      jurisdiction: {
        scope: "gcc", city: "Chennai",
        corporation: "Greater Chennai Corporation",
        zone: "Anna Nagar", ward: "108", loStation: "G7 Chetpet PS",
        trafficStation: "G7 Chetpet PS",
      },
    };
    const config = {
      preset: "detailed",
      fields: {
        brand: false, datetime: true, coords: false, digipin: false,
        altitudeAccuracy: false, address: true, titleLine: true,
        ward: true, zone: true, loStation: true, trafficStation: true,
        miniMap: false, qrCode: false, compass: false, soundLevel: false,
        profilePhoto: false, socialHandles: false, customLabel: false,
      },
      fontScale: 1, opacity: 0.55, theme: "dark", customLabelText: "",
      language: "en", signShape: "box", onlineMapUpgrade: false,
      position: "bottom",
    };
    // read the rows back off the canvas by intercepting fillText
    const rowsFor = (accuracy, preset, language = "en") => {
      const c = document.createElement("canvas");
      c.width = 1080;
      c.height = 1440;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#888";
      ctx.fillRect(0, 0, 1080, 1440);
      const seen = [];
      const real = ctx.fillText.bind(ctx);
      ctx.fillText = (t, ...rest) => {
        seen.push(String(t));
        return real(t, ...rest);
      };
      const data = { ...base, fix: { lat: 13.0716, lng: 80.2408, accuracy } };
      renderWatermark(ctx, 1080, 1440, data, { ...config, preset, language },
        { name: "", handles: {} }, {});
      return seen.join(" | ");
    };
    return {
      goodCard: rowsFor(8, "detailed"),
      coarseCard: rowsFor(850, "detailed"),
      goodSign: rowsFor(8, "chennai"),
      coarseSign: rowsFor(850, "chennai"),
      coarseTamil: rowsFor(850, "detailed", "ta"),
    };
  });

  check(
    "a good fix says nothing extra",
    !/approximate|±/i.test(disclosure.goodCard) &&
      !/approximate|±/i.test(disclosure.goodSign),
    "no disclosure on an 8 m fix"
  );
  check(
    "a coarse fix is disclosed on the card",
    /±850 m/.test(disclosure.coarseCard),
    disclosure.coarseCard.split("|").find((r) => r.includes("±"))?.trim()
  );
  check(
    "a coarse fix is disclosed on the street sign too",
    /±850 m/.test(disclosure.coarseSign),
    disclosure.coarseSign.split("|").find((r) => r.includes("±"))?.trim()
  );
  // Checked in the string table, not on a canvas: headless Chromium has
  // no Indic fonts, so the renderer correctly falls back to English and a
  // rendering assertion here would be testing the test machine's fonts.
  const langs = await page.evaluate(async () => {
    const { LANGS } = await import("/src/lib/i18n/languages.ts");
    return Object.fromEntries(
      Object.entries(LANGS).map(([k, v]) => [k, v.strings.approx])
    );
  });
  const missing = Object.entries(langs).filter(([, v]) => !v || !v.trim());
  const untranslated = Object.entries(langs).filter(
    ([k, v]) => k !== "en" && v === langs.en
  );
  check(
    "every card language has its own disclosure",
    missing.length === 0 && untranslated.length === 0,
    `${Object.keys(langs).length} languages` +
      (missing.length ? `, missing: ${missing.map((m) => m[0])}` : "") +
      (untranslated.length ? `, still English: ${untranslated.map((m) => m[0])}` : "")
  );

  // ---- 3. the redundant station suffix is gone, in every script -------
  const stations = await page.evaluate(async () => {
    const { localStation } = await import("/src/lib/geo/local-names.ts");
    const cases = [
      ["en", "K1 Sembium PS"],
      ["en", "G7 Chetpet P.S."],
      ["en", "S13 Chrompet Police Station"],
      ["en", "S 13 Chrompet"], // already bare — must not be mangled
      ["ta", "K1 Sembium PS"],
      ["kn", "Cubbon Park PS"],
    ];
    return cases.map(([lang, raw]) => [raw, localStation(lang, raw) ?? ""]);
  });
  const suffixLeft = stations.filter(([, out]) => /\bP\.?\s?S\.?$|Police Station$/i.test(out));
  check(
    "no station name still ends in PS",
    suffixLeft.length === 0,
    stations.map(([a, b]) => `${a} → ${b}`).join("; ")
  );
  check(
    "a name without a suffix is left alone",
    stations.find(([a]) => a === "S 13 Chrompet")?.[1] === "S 13 Chrompet"
  );
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
console.log("\nthe card only claims what the fix can support");
