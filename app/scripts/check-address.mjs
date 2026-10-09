#!/usr/bin/env node
/**
 * The card names the place you are in, not the zone or taluk around it.
 *
 * Reported: "why it's showing Perungudi and Sholinganallur when both are
 * at least 10 km from my place". At that point every geocoder answers
 *
 *     Major Mukund Varadharajan Salai, Perungudi, Chennai,
 *     Sholinganallur, Chennai, Tamil Nadu - 600100
 *
 * — Perungudi being Greater Chennai Corporation Zone 14 and
 * Sholinganallur the revenue taluk. The neighbourhood, Pallikaranai, is
 * 589 m away and never mentioned. This checks the correction both ways:
 * wrong names go and the right one comes in, while every name that WAS
 * right — including "Perungudi" for someone actually standing in it — is
 * left exactly as the geocoder gave it.
 *
 *   node scripts/check-address.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4621, host: "127.0.0.1" },
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
  await page.goto("http://127.0.0.1:4621", { waitUntil: "load" });

  const r = await page.evaluate(async () => {
    const { loadGeodataFor } = await import("/src/lib/geo/geodata.ts");
    const { lookup } = await import("/src/lib/geo/lookup.ts");
    const { refineGeocode } = await import("/src/lib/geo/refine.ts");
    const run = async (lat, lng, answer, lang = "en") => {
      const pack = await loadGeodataFor(lat, lng);
      const j = lookup(pack, lat, lng).jurisdiction;
      return { ...refineGeocode(answer, j, pack, lat, lng, lang), area: j.area };
    };
    const reported = {
      address:
        "Major Mukund Varadharajan Salai, Perungudi, Chennai, Sholinganallur, Chennai, Tamil Nadu - 600100",
      locality: "Perungudi, Chennai",
      subLocality: "Perungudi",
      subAdminArea: "Sholinganallur",
    };
    return {
      // 1. the report, as Android answered it
      android: await run(12.929253, 80.202487, reported),
      // 2. the same answer without Android's structured taluk field —
      //    what a web provider hands over
      bare: await run(12.929253, 80.202487, {
        address: reported.address,
        locality: reported.locality,
      }),
      // 3. Android's own alternatives include the real area
      withAlt: await run(12.929253, 80.202487, {
        ...reported,
        altSubLocalities: ["Perungudi", "Pallikaranai"],
      }),
      // 4. someone actually standing in Perungudi keeps "Perungudi",
      //    even though it is also the zone's name
      inPerungudi: await run(12.97102, 80.24181, {
        address: "OMR Service Rd, Perungudi, Chennai, Tamil Nadu - 600096",
        locality: "Perungudi, Chennai",
        subLocality: "Perungudi",
      }),
      // 5. a correct answer is left exactly alone (Paper Mills Road)
      perambur: await run(13.107929, 80.237139, {
        address:
          "58, Madhavaram High Rd, Chinnaiyan Colony, Perambur, Chennai, Tamil Nadu - 600011",
        locality: "Perambur, Chennai",
        subLocality: "Perambur",
      }),
      // 6. a neighbourhood nobody has mapped is not deleted for being
      //    unknown — that would be its own error
      unmapped: await run(12.946093, 80.200583, {
        address:
          "123, Sunnambu Kolathur Main Rd, Rajam Nagar, S.Kolathur, Kovilambakkam, Chennai, Tamil Nadu - 600117",
        locality: "Kovilambakkam, Chennai",
        subLocality: "Kovilambakkam",
      }),
      // 7. OSM's own form of the reported answer, after our cleanup
      nominatim: await run(12.929253, 80.202487, {
        address:
          "Major Mukund Varadharajan Salai, Perungudi, Chennai, Sholinganallur, Chennai District, Tamil Nadu - 600100",
        locality: "Perungudi, Chennai",
        subLocality: "Perungudi",
        subAdminArea: "Sholinganallur",
      }),
      // 8. a Tamil card gets the area in Tamil
      tamil: await run(12.929253, 80.202487, reported, "ta"),
    };
  });

  // End to end, through reverseGeocode() itself: provider -> settle ->
  // refine -> cache. Fed OSM's actual response for the reported point.
  const e2e = await page.evaluate(async () => {
    const real = {
      display_name:
        "Major Mukund Varadharajan Salai, Ward 190, Zone 14 Perungudi, Chennai, Sholinganallur, Chennai District, Tamil Nadu, 600100, India",
      address: {
        road: "Major Mukund Varadharajan Salai",
        neighbourhood: "Ward 190",
        suburb: "Zone 14 Perungudi",
        city: "Chennai",
        county: "Sholinganallur",
        state_district: "Chennai District",
        state: "Tamil Nadu",
        postcode: "600100",
        country: "India",
      },
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, init) =>
      String(url).includes("nominatim")
        ? new Response(JSON.stringify(real), { headers: { "Content-Type": "application/json" } })
        : realFetch(url, init);
    const { useSettingsStore } = await import("/src/store.ts");
    useSettingsStore.getState().setSettings({ geocoder: "nominatim" });
    const { clearAddressCache } = await import("/src/lib/geocache.ts");
    await clearAddressCache();
    const { reverseGeocode, lastGeocodeDiagnostic } = await import("/src/lib/geocode.ts");
    const first = await reverseGeocode(12.929253, 80.202487);
    // second call is served from the cache — it must hold the refined answer
    const cached = await reverseGeocode(12.929253, 80.202487);
    return { first, cached, diag: lastGeocodeDiagnostic() };
  });

  const a = r.android;
  check(
    "the live lookup path applies the correction",
    e2e.first?.locality === "Pallikaranai, Chennai" &&
      !/Perungudi|Sholinganallur/.test(e2e.first?.address ?? ""),
    `${e2e.first?.locality} / ${e2e.first?.address}`
  );
  check(
    "the cache holds the corrected answer, not the raw one",
    e2e.cached?.locality === "Pallikaranai, Chennai",
    `cached: ${e2e.cached?.locality}`
  );
  check(
    "the reported point is titled by its own neighbourhood",
    a.locality === "Pallikaranai, Chennai",
    `title "${a.locality}" (was "Perungudi, Chennai")`
  );
  check(
    "neither far-away name survives in the address",
    !/Perungudi|Sholinganallur/.test(a.address),
    a.address
  );
  check(
    "the street the geocoder found is kept exactly",
    a.address.startsWith("Major Mukund Varadharajan Salai, Pallikaranai, Chennai") &&
      a.address.endsWith("Tamil Nadu - 600100") &&
      (a.address.match(/Chennai/g) ?? []).length === 1,
    a.address
  );
  check(
    "it works without Android's structured taluk field",
    r.bare.locality === "Pallikaranai, Chennai" && !/Perungudi|Sholinganallur/.test(r.bare.address),
    `"${r.bare.locality}" / ${r.bare.address}`
  );
  check(
    "Android's own verified alternative is preferred",
    r.withAlt.locality === "Pallikaranai, Chennai" &&
      r.withAlt.notes.some((n) => n.includes("alternative")),
    r.withAlt.notes.join(" | ")
  );
  check(
    "someone actually in Perungudi keeps Perungudi",
    r.inPerungudi.locality === "Perungudi, Chennai" && /Perungudi/.test(r.inPerungudi.address),
    `"${r.inPerungudi.locality}" / ${r.inPerungudi.address}`
  );
  check(
    "a correct answer is left exactly alone",
    r.perambur.locality === "Perambur, Chennai" &&
      r.perambur.address ===
        "58, Madhavaram High Rd, Chinnaiyan Colony, Perambur, Chennai, Tamil Nadu - 600011" &&
      r.perambur.notes.length === 0,
    r.perambur.notes.join(" | ") || "no changes"
  );
  check(
    "an unmapped neighbourhood is kept, not deleted",
    /Rajam Nagar/.test(r.unmapped.address) && /S\.Kolathur/.test(r.unmapped.address),
    r.unmapped.address
  );
  check(
    "OSM's form of the same answer is corrected the same way",
    r.nominatim.locality === "Pallikaranai, Chennai" &&
      !/Perungudi|Sholinganallur|District/.test(r.nominatim.address),
    r.nominatim.address
  );
  check(
    "a Tamil card names the area in Tamil",
    /பள்ளிக்கரணை/.test(r.tamil.locality ?? ""),
    r.tamil.locality
  );
  check(
    "every change says why",
    a.notes.length >= 2 && a.notes.every((n) => n.includes("—")),
    a.notes.join(" | ")
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
console.log("\nthe card names the place, not the zone around it");
