#!/usr/bin/env node
/**
 * The card prints the geocoder's address as the geocoder gave it.
 *
 * On the phone that is Android's own geocoder — Google's address for the
 * spot — the source every other GPS camera app prints. v1.44–v1.50 put
 * corrections on top of it (renaming areas from our place data, a vote
 * between streets, an OpenStreetMap tie-break); each fixed one place and
 * broke another, and the user asked for it to simply match:
 *
 *   - Chandigarh, Sector 11: Google answered "128, Sector 11-A" and the
 *     vote replaced it with "178, Vidya Path", a house on a nearby road;
 *   - Velachery: our place data stamped "Adambakkam" on every street;
 *
 * So: the first answer, verbatim, with only ", India" and a leading Plus
 * Code removed; the title from Android's own area and city fields. Ward,
 * zone and police come from our boundary maps and are not checked here.
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

  // Android's answers, recorded from the phone geocoder (a stand-in bridge
  // replays them): the first answer is what the card must print.
  const r = await page.evaluate(async () => {
    const answers = {
      // Chandigarh: a house numbered within its sector, no street
      "30.7616": {
        addressLine: "128, Sector 11-A, Sector 11, Chandigarh, 160011, India",
        subLocality: "Sector 11", locality: "Chandigarh", adminArea: "Chandigarh",
      },
      // Brindavan Nagar Main Road / Mohanapuri 4th Street corner, Adambakkam
      "12.9858": {
        addressLine: "46, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar, Adambakkam, Chennai, Tamil Nadu 600088, India",
        subLocality: "Adambakkam", locality: "Chennai", adminArea: "Tamil Nadu",
      },
      // a spot Google names only by its Plus Code
      "13.0611": {
        addressLine: "26RM+6F4, Nungambakkam, Chennai, Tamil Nadu 600034, India",
        subLocality: "Nungambakkam", locality: "Chennai", adminArea: "Tamil Nadu",
      },
      // Velachery: the card must not gain "Adambakkam"
      "12.9818": {
        addressLine: "50, Velachery Main Rd, Velachery, Chennai, Tamil Nadu 600042, India",
        subLocality: "Velachery", locality: "Chennai", adminArea: "Tamil Nadu",
        altSubLocalities: ["Adambakkam"],
      },
    };
    let asked = 0;
    window.Capacitor = {
      Plugins: {
        NativeBridge: {
          reverseGeocode: async ({ lat }) => {
            asked++;
            const a = answers[lat.toFixed(4)];
            return a ? { ok: true, ...a } : { ok: false };
          },
        },
      },
    };
    let fetched = 0;
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      if (/nominatim|mappls|googleapis/.test(String(url))) fetched++;
      return realFetch(url, init);
    };
    const { useSettingsStore } = await import("/src/store.ts");
    useSettingsStore.getState().setSettings({ geocoder: "auto" });
    const { clearAddressCache } = await import("/src/lib/geocache.ts");
    await clearAddressCache();
    const { reverseGeocode } = await import("/src/lib/geocode.ts");
    const out = {};
    for (const [k, lat, lng] of [
      ["chandigarh", 30.761618, 76.784141],
      ["corner", 12.985842, 80.205096],
      ["plus", 13.061105, 80.233612],
      ["velachery", 12.981793, 80.221435],
    ]) {
      out[k] = await reverseGeocode(lat, lng);
    }
    const askedBefore = asked;
    out.cached = await reverseGeocode(30.761618, 76.784141);
    out.cacheHit = asked === askedBefore;
    out.fetched = fetched;
    delete window.Capacitor;
    return out;
  });

  check(
    "Chandigarh: the house numbered in its sector, exactly as Google gave it",
    r.chandigarh?.address === "128, Sector 11-A, Sector 11, Chandigarh - 160011" &&
      r.chandigarh?.locality === "Sector 11, Chandigarh",
    `${r.chandigarh?.locality} / ${r.chandigarh?.address}`
  );
  check(
    "Adambakkam: Google's first answer, unchanged",
    r.corner?.address ===
      "46, Brindavan Nagar Main Rd, Okkiayam, Brindavan Nagar, Adambakkam, Chennai, Tamil Nadu - 600088",
    r.corner?.address
  );
  check(
    "a leading Plus Code is dropped; the rest stands",
    r.plus?.address === "Nungambakkam, Chennai, Tamil Nadu - 600034",
    r.plus?.address
  );
  check(
    "Velachery stays Velachery — nothing is added from our own place data",
    !/Adambakkam/.test(`${r.velachery?.address} ${r.velachery?.locality}`) &&
      r.velachery?.locality === "Velachery, Chennai",
    `${r.velachery?.locality} / ${r.velachery?.address}`
  );
  check(
    "the phone's answer is the only one asked for — no other service is consulted",
    r.fetched === 0,
    `${r.fetched} web geocoder requests`
  );
  check(
    "a second look at the same spot comes from the cache, unchanged",
    r.cacheHit && r.cached?.address === r.chandigarh?.address,
    `${r.cached?.address} (cache hit: ${r.cacheHit})`
  );

  // The browser build: OpenStreetMap's answer, formatted only (its zone
  // and ward tokens, and the country, are not part of an address).
  const web = await page.evaluate(async () => {
    const real = {
      display_name:
        "Major Mukund Varadharajan Salai, Ward 190, Zone 14 Perungudi, Chennai, Sholinganallur, Chennai District, Tamil Nadu, 600100, India",
      address: {
        road: "Major Mukund Varadharajan Salai",
        neighbourhood: "Ward 190",
        suburb: "Zone 14 Perungudi",
        city: "Chennai",
        county: "Sholinganallur",
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
    const { reverseGeocode } = await import("/src/lib/geocode.ts");
    return reverseGeocode(12.929253, 80.202487);
  });
  check(
    "browser build: OpenStreetMap's answer, formatted only (ward token, zone prefix and country removed)",
    web?.address ===
      "Major Mukund Varadharajan Salai, Perungudi, Chennai, Sholinganallur, Chennai District, Tamil Nadu - 600100" &&
      web?.locality === "Perungudi, Chennai",
    `${web?.locality} / ${web?.address}`
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
console.log("\nthe card prints the geocoder's address as given");
