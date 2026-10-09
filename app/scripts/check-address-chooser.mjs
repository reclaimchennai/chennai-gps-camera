#!/usr/bin/env node
/**
 * The address chosen by hand — for the building with several tenants.
 *
 * Asked for: pick the exact building or office from what is within 50 m,
 * search for a more precise one, edit it, and have it preferred for later
 * photos there. Coordinates cannot tell two tenants of one building apart
 * (the case that started this was two offices at one address), and no
 * geocoder can either.
 *
 * Map services are mocked: OpenStreetMap answers with two tenants of one
 * building, a search has one result near and one far, and the automatic
 * address comes from a mocked Nominatim.
 *
 *   node scripts/check-address-chooser.mjs
 *   SHOTS=/tmp/shots node scripts/check-address-chooser.mjs   (screenshots too)
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const HERE = { latitude: 13.0405, longitude: 80.2337, accuracy: 8 };
// ~70 m north: outside the 50 m a choice carries
const AWAY = { ...HERE, latitude: HERE.latitude + 0.00063 };
const north = (m) => HERE.latitude + m / 111_320;

const server = await createServer({
  server: { port: 4655, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
// a touchscreen, as on a phone: a tap ends in a click synthesized at the
// finger's position, and on a desktop mouse it does not
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  hasTouch: true,
  isMobile: true,
  geolocation: HERE,
  permissions: ["geolocation", "camera"],
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const requests = [];

// ---- mocked map services ------------------------------------------------
await ctx.route("https://overpass-api.de/**", (route) => {
  requests.push("overpass");
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      elements: [
        { type: "node", id: 1, lat: north(18), lon: HERE.longitude, tags: { name: "PI-RAHI", office: "company" } },
        {
          type: "node", id: 2, lat: north(12), lon: HERE.longitude,
          tags: { name: "Bionest", office: "company", "addr:housenumber": "14", "addr:street": "Kodambakkam High Road" },
        },
        // a road is what an address is made of, not a place to choose
        { type: "way", id: 3, center: { lat: north(5), lon: HERE.longitude }, tags: { name: "Kodambakkam High Road", highway: "primary" } },
      ],
    }),
  });
});
await ctx.route("https://nominatim.openstreetmap.org/**", (route) => {
  const url = new URL(route.request().url());
  requests.push(`nominatim:${url.pathname}`);
  if (url.pathname.startsWith("/search")) {
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { osm_type: "way", osm_id: 10, name: "Kalpataru Towers", display_name: "Kalpataru Towers, Nungambakkam, Chennai, India", lat: String(north(90)), lon: String(HERE.longitude) },
        { osm_type: "way", osm_id: 11, name: "Kalpataru Annexe", display_name: "Kalpataru Annexe, T. Nagar, Chennai, India", lat: String(north(400)), lon: String(HERE.longitude) },
      ]),
    });
  }
  // reverse: the live (automatic) address, and the building-level lookup
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      osm_type: "way",
      osm_id: 20,
      name: url.searchParams.get("zoom") === "18" ? "Prestige Building" : "",
      display_name: "Kodambakkam High Road, Nungambakkam, Chennai, Tamil Nadu, 600034, India",
      lat: String(HERE.latitude),
      lon: String(HERE.longitude),
      address: { road: "Kodambakkam High Road", suburb: "Nungambakkam", city: "Chennai", state: "Tamil Nadu", postcode: "600034" },
    }),
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
};
const cardData = () =>
  page.evaluate(async () => {
    const { collectWatermarkData } = await import("/src/lib/capture.ts");
    const d = collectWatermarkData();
    return { address: d.address, locality: d.locality, chosen: d.addressChosen ?? false };
  });
const dialog = () => page.locator('[role="dialog"][aria-label="Address here"]');
/** Tap the card: it is drawn on a canvas, so feel along the bottom of the
 *  viewfinder, where the default layout puts it, until the chooser opens. */
const tapCard = async () => {
  const box = await page.locator(".cam-video-box").boundingBox();
  for (const fy of [0.95, 0.9, 0.85, 0.8]) {
    for (const fx of [0.12, 0.3, 0.5]) {
      await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
      // the click that follows a tap lands after it; give it the time
      await sleep(400);
      if (await dialog().isVisible()) return true;
    }
  }
  return false;
};
const setFix = async (where) => {
  await ctx.setGeolocation(where);
  // let the watch deliver it and the card follow
  for (let i = 0; i < 40; i++) {
    const at = await page.evaluate(async () => {
      const { useLiveStore } = await import("/src/store.ts");
      return useLiveStore.getState().fix;
    });
    if (at && Math.abs(at.lat - where.latitude) < 1e-6) return;
    await sleep(250);
  }
};

try {
  await page.goto("http://127.0.0.1:4655", { waitUntil: "load" });
  await page.waitForSelector('.cam-video-box[data-live="true"]', { timeout: 20000 });
  await page.evaluate(async () => {
    const { useSettingsStore } = await import("/src/store.ts");
    // the browser build's geocoder setting is "auto": OSM in, no key
    useSettingsStore.getState().setSettings({ addressChooser: false, googleApiKey: "" });
  });
  await setFix(HERE);
  // the automatic address arrives from the mocked reverse geocode
  for (let i = 0; i < 40 && !(await cardData()).address; i++) await sleep(250);
  const auto = await cardData();
  check("the automatic address is in place", !!auto.address && !auto.chosen, auto.address);

  // ---- off: a tap on the card focuses, nothing more --------------------
  check("with the setting off, tapping the card does not open a chooser", !(await tapCard()));

  // ---- on ----------------------------------------------------------------
  await page.evaluate(async () => {
    const { useSettingsStore } = await import("/src/store.ts");
    useSettingsStore.getState().setSettings({ addressChooser: true });
  });
  check("with it on, tapping the card opens the chooser", await tapCard());
  await page.waitForSelector(".addr-option .addr-name >> text=PI-RAHI", { timeout: 10000 });
  const names = await dialog().locator(".addr-option .addr-name").allTextContents();
  check(
    "it lists the tenants within 50 m, nearest first",
    names.indexOf("Bionest") > 0 && names.indexOf("Bionest") < names.indexOf("PI-RAHI"),
    names.join(" | ")
  );
  check("roads are not offered as places", !names.includes("Kodambakkam High Road"));
  check("nothing went to Google without a key", !requests.some((r) => r.includes("google")));

  await shot("1-nearby");

  // ---- choose, edit, keep --------------------------------------------------
  await dialog().locator(".addr-option", { hasText: "PI-RAHI" }).click();
  const title = await dialog().locator(".addr-edit input").inputValue();
  const addr = await dialog().locator(".addr-edit textarea").inputValue();
  check(
    "choosing a tenant fills in its name, keeping the street address it lacks",
    title === "PI-RAHI" && addr.includes("Kodambakkam High Road"),
    `${title} / ${addr}`
  );
  await dialog().locator(".addr-edit textarea").fill(`2nd floor, ${addr}`);
  await shot("2-edit");
  await dialog().locator(".addr-save").click();
  await page.waitForSelector('[role="dialog"][aria-label="Address here"]', { state: "detached" });
  let d = await cardData();
  await sleep(600);
  await shot("3-card");
  check(
    "the card now carries the choice, and says it was chosen",
    d.locality === "PI-RAHI" && d.address.startsWith("2nd floor,") && d.chosen,
    `${d.locality} / ${d.address}`
  );

  // ---- it belongs to the spot ------------------------------------------------
  await setFix(AWAY);
  d = await cardData();
  check("70 m away the automatic address is back", !d.chosen && d.locality !== "PI-RAHI", d.locality ?? "");
  await setFix(HERE);
  d = await cardData();
  check("back at the spot, the choice is used again", d.chosen && d.locality === "PI-RAHI");

  const stored = await page.evaluate(async () => {
    const { kvGet } = await import("/src/lib/db.ts");
    return (await kvGet("address-pins")) ?? [];
  });
  check("it is kept on the device", stored.length === 1 && stored[0].title === "PI-RAHI");

  // ---- the photo itself ---------------------------------------------------------
  const photo = await page.evaluate(async () => {
    const { listMedia } = await import("/src/lib/db.ts");
    const before = (await listMedia()).length;
    document.querySelector('button[aria-label="Take photo"]').click();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const all = await listMedia();
      if (all.length > before) {
        const m = all.sort((a, b) => b.createdAt - a.createdAt)[0];
        return { locality: m.data.locality, chosen: m.data.addressChosen ?? false };
      }
    }
    return null;
  });
  check("a photo taken there carries the choice and the disclosure", photo?.chosen && photo.locality === "PI-RAHI");

  // ---- search ----------------------------------------------------------------------
  check("the chooser opens on the chosen address", await tapCard());
  const current = dialog().locator(".addr-option", { hasText: "Your choice here" });
  check(
    "it shows the choice in effect, selected",
    (await current.getAttribute("aria-pressed")) === "true" && /PI-RAHI/.test(await current.textContent())
  );
  await dialog().locator(".addr-search input").fill("Kalpataru");
  await dialog().locator(".addr-search button").click();
  await page.waitForSelector(".addr-option .addr-name >> text=Kalpataru Annexe", { timeout: 10000 });
  await shot("4-search");
  const near = dialog().locator(".addr-option", { hasText: "Kalpataru Towers" });
  const far = dialog().locator(".addr-option", { hasText: "Kalpataru Annexe" });
  check(
    "a search result 90 m away can be used; one 400 m away cannot, and says why",
    (await near.isEnabled()) && !(await far.isEnabled()) && /too far/.test(await far.textContent()),
  );
  const contrast = await far.locator(".addr-far").evaluate((el) => {
    const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    let bgEl = el;
    let bg = "rgba(0, 0, 0, 0)";
    while (bgEl && /rgba\(.*, 0\)$/.test(bg)) {
      bg = getComputedStyle(bgEl).backgroundColor;
      bgEl = bgEl.parentElement;
    }
    const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(bg))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  check("the reason is readable", contrast >= 4.5, `${contrast.toFixed(2)}:1`);
  // close without saving: nothing changes — by tapping the dimmed
  // camera above the sheet, as people do
  await page.touchscreen.tap(200, 40);
  await page.waitForSelector('[role="dialog"][aria-label="Address here"]', { state: "detached", timeout: 3000 })
    .then(() => check("a tap on the backdrop closes the chooser", true))
    .catch(async () => {
      check("a tap on the backdrop closes the chooser", false);
      await dialog().locator('button[aria-label="Close"]').click();
    });
  d = await cardData();
  check("closing without saving changes nothing", d.locality === "PI-RAHI");

  // ---- choosing again near the spot replaces, never doubles ------------------------------
  await setFix({ ...HERE, latitude: north(30) });
  check("30 m along, the choice still applies", (await cardData()).chosen);
  await tapCard();
  await page.waitForSelector(".addr-option .addr-name >> text=Bionest", { timeout: 10000 });
  await dialog().locator(".addr-option", { hasText: "Bionest" }).click();
  await dialog().locator(".addr-save").click();
  await page.waitForSelector('[role="dialog"][aria-label="Address here"]', { state: "detached" });
  const after = await page.evaluate(async () => {
    const { allAddressPins } = await import("/src/lib/geo/addressPins.ts");
    return allAddressPins().map((p) => p.title);
  });
  check("a new choice there replaces the old one", after.length === 1 && after[0] === "Bionest", after.join(", "));
  await setFix(HERE);

  // ---- back to automatic ----------------------------------------------------------------
  await tapCard();
  await dialog().locator(".addr-option", { hasText: "Automatic" }).first().click();
  await dialog().locator(".addr-save").click();
  await page.waitForSelector('[role="dialog"][aria-label="Address here"]', { state: "detached" });
  d = await cardData();
  check("choosing Automatic again removes the choice for the spot", !d.chosen && d.locality !== "PI-RAHI");

  // ---- a backup carries it -------------------------------------------------------------------
  const backup = await page.evaluate(async () => {
    const pins = await import("/src/lib/geo/addressPins.ts");
    await pins.saveAddressPin({ lat: 13.0405, lng: 80.2337, title: "Bionest", address: "14 Kodambakkam High Road", source: "nearby" });
    const { buildBackup, parseBackup, applyBackup } = await import("/src/lib/backup.ts");
    const file = parseBackup(await (await buildBackup()).text());
    const inFile = file.addressPins?.length ?? 0;
    await pins.removeAddressPin(pins.allAddressPins()[0].id);
    const report = await applyBackup(file);
    return { inFile, restored: report.addressPins, now: pins.allAddressPins().map((p) => p.title) };
  });
  check(
    "a backup carries chosen addresses, and restoring brings them back",
    backup.inFile === 1 && backup.restored === 1 && backup.now[0] === "Bionest",
    JSON.stringify(backup)
  );

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `\n${failures} failed` : "\nthe address can be chosen, and it says so");
process.exit(failures ? 1 : 0);
