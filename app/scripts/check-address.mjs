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
      // 9. reported from a Galaxy S25: Velachery is mapped in OSM as an
      //    outline, not a point, and without outlines every Velachery
      //    address had Adambakkam (the nearest point, 1.3 km off) added
      velachery: await run(12.981793, 80.221435, {
        address: "50, Velachery Main Rd, Velachery, Chennai, Tamil Nadu - 600042",
        locality: "Velachery, Chennai",
        subLocality: "Velachery",
        altSubLocalities: ["Adambakkam"],
      }),
      // 10. and Adambakkam itself, just outside that outline, keeps its name
      adambakkam: await run(12.98222, 80.20912, {
        address: "Brindavan Nagar Main Rd, Adambakkam, Chennai, Tamil Nadu - 600088",
        locality: "Adambakkam, Chennai",
        subLocality: "Adambakkam",
      }),
      // 11. Android's answers at a photo on Brindavan Nagar Main Road, 7 m
      // from the Mohanapuri 4th Street junction (recorded from the phone
      // geocoder). Printed first: a corner plot on 4th Street.
      brindavan: await (async () => {
        const { pickAddress } = await import("/src/lib/geo/pickAddress.ts");
        const { cleanAddress } = await import("/src/lib/geocode.ts");
        const L = ", Adambakkam, Chennai, Tamil Nadu 600088, India";
        const at = (line, thoroughfare, lat, lng) => ({ line: line + L, thoroughfare, subLocality: "Adambakkam", locality: "Chennai", adminArea: "Tamil Nadu", lat, lng });
        const pick = (lat, lng, results, road) => {
          const p = pickAddress(results, lat, lng, road);
          return { line: p?.chosen.line ?? results[0].line, why: p?.why };
        };
        const main = pick(12.985842, 80.205096, [
          at("Plot No-63, 4th St, Okkiayam, Thouraipakkam, New Colony", "4th Street", 12.9857723, 80.2052094),
          at("46, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.9858278, 80.2049866),
          at("Plot no 45A, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.9858303, 80.2050018),
          at("4/64, Okkiayam, Thouraipakkam, Brindavan Nagar", undefined, 12.9856861, 80.2053094),
          at("Brindavan Nagar, Mohanapuri, Brindavan Nagar", undefined, 12.986961, 80.205304),
        ]);
        // 80 m along 4th Street: there it IS the street
        const side = pick(12.98567, 80.206, [
          at("X6P4+7CF, Mohanapuri 4th St, Okkiayam", "Mohanapuri 4th Street", 12.9857, 80.20596),
          at("14/69, Okkiayam, Thouraipakkam", undefined, 12.98555, 80.206),
          at("15/62, Mohanapuri, Thouraipakkam", undefined, 12.98552, 80.20592),
          at("14, Mohanapuri 4th St, Mohanapuri", "Mohanapuri 4th Street", 12.98581, 80.206),
        ]);
        // and where the first answer already was right, it is untouched
        const first = pick(12.985698, 80.205033, [
          at("46, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.9856918, 80.2050293),
          at("18A, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.985709, 80.2049651),
          at("4/64, Okkiayam, Thouraipakkam, Brindavan Nagar", undefined, 12.9856861, 80.2053094),
        ]);
        // 4 m from the junction: two 4th Street buildings (two spellings)
        // outvote one on the main road; OpenStreetMap's road line settles it
        const corner = [
          at("Plot No-63, 4th St, Okkiayam, Thouraipakkam, New Colony", "4th Street", 12.9857723, 80.2052094),
          at("No 56, 1, Mohanapuri 4th St, Okkiayam, Thouraipakkam", "Mohanapuri 4th Street", 12.9858793, 80.2051785),
          at("56, Brindavan Nagar Main Rd, Mohanapuri", "Brindavan Nagar Main Road", 12.98594, 80.20507),
          at("4/64, Okkiayam, Thouraipakkam, Brindavan Nagar", undefined, 12.9856861, 80.2053094),
        ];
        const { streetsDisagree } = await import("/src/lib/geo/pickAddress.ts");
        const cornerNoHint = pick(12.9858, 80.20512, corner);
        const cornerOsm = pick(12.9858, 80.20512, corner, "Brindavan Nagar Main Road");
        const cornerElsewhere = pick(12.9858, 80.20512, corner, "Some Other Road");
        const disagree = streetsDisagree(corner, 12.9858, 80.20512);
        const agreeOnly = streetsDisagree(
          [at("46, Brindavan Nagar Main Rd", "Brindavan Nagar Main Road", 12.9856918, 80.2050293)],
          12.985698, 80.205033
        );
        const card = await run(12.985698, 80.205033, {
          address: cleanAddress("36, Brindavan Nagar Main Rd, Okkiayam, Thouraipakkam, New Colony, Adambakkam, Chennai, Tamil Nadu 600088, India", "Tamil Nadu"),
          locality: "Adambakkam, Chennai",
          subLocality: "Adambakkam",
        });
        return { cornerNoHint, cornerOsm, cornerElsewhere, disagree, agreeOnly, main, side: { ...side, clean: cleanAddress(side.line, "Tamil Nadu") }, first, card };
      })(),
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

  // The APK path end to end: the phone geocoder's recorded answers at the
  // corner, through nativeReverseGeocode -> vote -> OpenStreetMap's road ->
  // refine -> the card. A stand-in bridge replays what the phone said.
  const apk = await page.evaluate(async () => {
    const L = ", Adambakkam, Chennai, Tamil Nadu 600088, India";
    const at = (line, thoroughfare, lat, lng) => ({ line: line + L, thoroughfare, subLocality: "Adambakkam", locality: "Chennai", adminArea: "Tamil Nadu", lat, lng });
    const answers = {
      // the corner: Google's streets disagree
      "12.9858": [
        at("Plot No-63, 4th St, Okkiayam, Thouraipakkam, New Colony", "4th Street", 12.9857723, 80.2052094),
        at("No 56, 1, Mohanapuri 4th St, Okkiayam, Thouraipakkam", "Mohanapuri 4th Street", 12.9858793, 80.2051785),
        at("56, Brindavan Nagar Main Rd, Mohanapuri", "Brindavan Nagar Main Road", 12.98594, 80.20507),
      ],
      // up the main road: every answer is on it
      "12.9857": [
        at("46, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.9856918, 80.2050293),
        at("18A, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar", "Brindavan Nagar Main Road", 12.985709, 80.2049651),
      ],
    };
    window.Capacitor = {
      Plugins: {
        NativeBridge: {
          reverseGeocode: async ({ lat }) => {
            const results = answers[lat.toFixed(4)];
            const a = results[0];
            return { ok: true, addressLine: a.line, subLocality: a.subLocality, locality: a.locality, adminArea: a.adminArea, results };
          },
        },
      },
    };
    const osmCalls = [];
    window.fetch = async (url) => {
      osmCalls.push(String(url));
      return new Response(
        JSON.stringify({ display_name: "Brindavan Nagar Main Road, Chennai", address: { road: "Brindavan Nagar Main Road" } }),
        { headers: { "Content-Type": "application/json" } }
      );
    };
    const { useSettingsStore } = await import("/src/store.ts");
    useSettingsStore.getState().setSettings({ geocoder: "auto" });
    const { clearAddressCache } = await import("/src/lib/geocache.ts");
    await clearAddressCache();
    const { reverseGeocode, lastGeocodeDiagnostic } = await import("/src/lib/geocode.ts");
    const corner = await reverseGeocode(12.9858, 80.20512);
    const cornerDiag = lastGeocodeDiagnostic();
    const cornerCalls = osmCalls.length;
    const along = await reverseGeocode(12.985698, 80.205033);
    useSettingsStore.getState().setSettings({ geocoder: "system" });
    await clearAddressCache();
    const pinned = await reverseGeocode(12.9858, 80.20512);
    useSettingsStore.getState().setSettings({ geocoder: "auto" });
    delete window.Capacitor;
    return { corner, cornerDiag, cornerCalls, alongCalls: osmCalls.length - cornerCalls, along, pinned };
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
    "a street inside Velachery's outline is in Velachery, with no other area added",
    r.velachery.address === "50, Velachery Main Rd, Velachery, Chennai, Tamil Nadu - 600042" &&
      r.velachery.locality === "Velachery, Chennai" &&
      r.velachery.area === "Velachery",
    `${r.velachery.address} | area ${r.velachery.area}`
  );
  check(
    "Adambakkam, outside it, is still Adambakkam",
    r.adambakkam.area === "Adambakkam" && /Adambakkam/.test(r.adambakkam.address) && !/Velachery/.test(r.adambakkam.address),
    `${r.adambakkam.address} | area ${r.adambakkam.area}`
  );
  const b = r.brindavan;
  check(
    "on a main road by a junction, the main road — not the corner plot facing the side street",
    /^(46|Plot no 45A), Brindavan Nagar Main Rd/.test(b.main.line) && /4th St/.test(b.main.why ?? ""),
    `${b.main.line.split(",").slice(0, 2).join(",")} | ${b.main.why}`
  );
  check(
    "at the corner itself, OpenStreetMap's road line decides between Google's streets",
    /^56, Brindavan Nagar Main Rd/.test(b.cornerOsm.line) && /OpenStreetMap/.test(b.cornerOsm.why ?? ""),
    `${b.cornerOsm.line.split(",").slice(0, 2).join(",")} | ${b.cornerOsm.why}`
  );
  check(
    "without it (offline), the vote stands; a road Google never named changes nothing",
    /4th St/.test(b.cornerNoHint.line.split(",").slice(0, 3).join(",")) && b.cornerElsewhere.line === b.cornerNoHint.line,
    `${b.cornerNoHint.line.split(",").slice(0, 3).join(",")} / ${b.cornerElsewhere.line.split(",").slice(0, 3).join(",")}`
  );
  check(
    "OpenStreetMap is asked only when Google's answers name more than one street",
    b.disagree === true && b.agreeOnly === false,
    `disagree ${b.disagree}, single street ${b.agreeOnly}`
  );
  check(
    "80 m into the side street, the side street — named even where Google's nearest answer is a grid code",
    /^Mohanapuri 4th St/.test(b.side.clean),
    b.side.clean
  );
  check(
    "where the geocoder's first answer was already right, it is used unchanged",
    /^46, Brindavan Nagar Main Rd/.test(b.first.line) && !b.first.why,
    b.first.line.split(",").slice(0, 2).join(",")
  );
  check(
    "Google's 'Thouraipakkam' is Thoraipakkam, 6 km away, and leaves the card",
    !/Thouraipakkam/.test(b.card.address) && /^36, Brindavan Nagar Main Rd/.test(b.card.address) && /Adambakkam/.test(b.card.address),
    `${b.card.address} | ${b.card.notes.join(" | ")}`
  );
  check(
    "APK: at the corner the card names the main road, settled by OpenStreetMap",
    /^56, Brindavan Nagar Main Rd/.test(apk.corner?.address ?? "") && apk.cornerCalls === 1 &&
      (apk.cornerDiag?.refinements ?? []).some((n) => /OpenStreetMap puts this point/.test(n)),
    `${apk.corner?.address} | OSM asked ${apk.cornerCalls}× | ${(apk.cornerDiag?.refinements ?? [])[0]}`
  );
  check(
    "APK: where Google's answers agree, OpenStreetMap is not asked at all",
    /^46, Brindavan Nagar Main Rd/.test(apk.along?.address ?? "") && apk.alongCalls === 0,
    `${apk.along?.address} | OSM asked ${apk.alongCalls}×`
  );
  check(
    "APK: with the phone geocoder chosen by hand, no other service is asked",
    /^Plot No-63, 4th St/.test(apk.pinned?.address ?? ""),
    apk.pinned?.address
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
