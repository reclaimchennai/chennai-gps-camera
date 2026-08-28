#!/usr/bin/env node
/**
 * Stations name the card only where a station really is.
 *
 * At a railway station the station IS the address a complaint is about,
 * and "Grand Southern Trunk Road, Sattamangalam" tells whoever has to act
 * on it far less than "Potheri Railway Station". But a title is a claim,
 * and the failure mode of a landmark feature is claiming ground it does
 * not own — a 350 m circle around every station would put half of
 * Perambur "at" Perambur station, which is worse than no landmark at all.
 *
 * So both directions are checked: on the platform it names the station,
 * and off the property it says nothing.
 *
 *   node scripts/check-rail.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4581, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await page.goto("http://127.0.0.1:4581", { waitUntil: "load" });

  const r = await page.evaluate(async () => {
    const { loadGeodataFor } = await import("/src/lib/geo/geodata.ts");
    const { stationAt, stationTitle } = await import("/src/lib/geo/rail.ts");
    const at = async (lat, lng, lang = "en") => {
      const pack = await loadGeodataFor(lat, lng);
      const st = stationAt(pack, lat, lng);
      return st ? { title: stationTitle(st, lang), d: Math.round(st.distance), measured: st.measured } : null;
    };
    const packOf = async (lat, lng) => (await loadGeodataFor(lat, lng))?.id;

    return {
      // the coordinate from the user's Potheri report
      potheri: await at(12.821572, 80.037241),
      potheriTa: await at(12.821572, 80.037241, "ta"),
      chetpet: await at(13.0743424, 80.242421),
      chetpetTa: await at(13.0743424, 80.242421, "ta"),
      perambur: await at(13.107719, 80.244414),
      // Paper Mills Road, ~800 m from Perambur station: a street, not a
      // station, and the reason a circle-based match would be wrong
      paperMills: await at(13.107929, 80.237139),
      // open country, far from any line
      nowhere: await at(12.9, 79.6),
      pack: await packOf(13.107929, 80.237139),
      // how much ground stations claim in total, as a sanity bound
      coverage: await (async () => {
        const pack = await loadGeodataFor(13.08, 80.24);
        const feats = pack.layers.rail.features;
        const rs = feats.map((f) => f.properties.radius);
        return {
          count: feats.length,
          maxRadius: Math.max(...rs),
          withEnv: feats.filter((f) => f.properties.env).length,
        };
      })(),
    };
  });

  check(
    "the reported Potheri coordinate names Potheri",
    !!r.potheri && /Potheri/i.test(r.potheri.title),
    r.potheri ? `"${r.potheri.title}" at ${r.potheri.d} m` : "no station matched"
  );
  check(
    "Chetpet station names itself",
    !!r.chetpet && /Chetpet/i.test(r.chetpet.title),
    r.chetpet ? `"${r.chetpet.title}" at ${r.chetpet.d} m` : "no station matched"
  );
  check(
    "Perambur station names itself",
    !!r.perambur && /Perambur/i.test(r.perambur.title),
    r.perambur ? `"${r.perambur.title}"` : "no station matched"
  );
  check(
    "a Tamil card gets the Tamil station name",
    !!r.chetpetTa && /[஀-௿]/.test(r.chetpetTa.title),
    r.chetpetTa?.title
  );
  check(
    "a street 800 m from a station is NOT called that station",
    r.paperMills === null,
    r.paperMills ? `wrongly claimed "${r.paperMills.title}"` : "no claim, correct"
  );
  check(
    "open country claims nothing",
    r.nowhere === null,
    r.nowhere ? `wrongly claimed "${r.nowhere.title}"` : "no claim, correct"
  );
  check(
    "no station claims an unreasonable radius",
    r.coverage.maxRadius <= 250,
    `${r.coverage.count} stations, largest fallback circle ${r.coverage.maxRadius} m, ` +
      `${r.coverage.withEnv} matched on measured platforms instead`
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
console.log("\nstations name the card only where a station is");
