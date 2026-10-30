#!/usr/bin/env node
/**
 * A photo says where it was taken, and shows what the phone's camera sees.
 *
 *  - Photo mode opens the whole 4:3 frame and the viewfinder shows all of
 *    it; video keeps its 16:9 profile and fills the screen.
 *  - Screen off, walk somewhere, screen on, shoot: the photo carries the
 *    new place, not the last one the phone saw before the screen went off.
 *  - A photo a street away from where the viewfinder's address was looked
 *    up gets an address for its own spot.
 *  - A lookup that never answers (a stalled mobile connection) does not
 *    hold the viewfinder's address on the old place until a restart.
 *
 * Geolocation is driven by hand (a stand-in for navigator.geolocation),
 * and the geocoder answers from a stub that names the latitude, so which
 * spot an address belongs to can be read straight off it.
 *
 *   node scripts/check-fresh-place.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const A = { lat: 13.0405, lng: 80.2337 };
// ~120 m north: inside the 150 m the viewfinder's address used to be
// reused across, and a different street
const B = { lat: 13.0416, lng: 80.2337 };
// ~1 km away, for the screen-off walk
const C = { lat: 13.0495, lng: 80.2337 };

const server = await createServer({
  server: { port: 4533, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const base = "http://127.0.0.1:4533";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  permissions: ["camera"],
  deviceScaleFactor: 2,
});
// ~250 m on again, and once more, for the stalled lookup
const D = { lat: 13.0518, lng: 80.2337 };
const E = { lat: 13.0541, lng: 80.2337 };
// a lookup for a latitude listed here is never answered
const hang = new Set();
// the geocoder stub: "Street at 13.0416" — the spot is in the answer
await context.route("https://nominatim.openstreetmap.org/**", (route) => {
  const u = new URL(route.request().url());
  if (hang.has(Number(u.searchParams.get("lat")).toFixed(4))) return;
  const lat = Number(u.searchParams.get("lat")).toFixed(4);
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      display_name: `Street at ${lat}, Chennai, Tamil Nadu, India`,
      address: { road: `Street at ${lat}`, city: "Chennai", state: "Tamil Nadu" },
    }),
  });
});
await context.addInitScript(() => {
  // a hand-driven geolocation: fixes arrive only when the test sends one,
  // as on a phone whose screen was off
  const watchers = new Map();
  let next = 1;
  let last = null;
  const position = (p) => ({
    coords: {
      latitude: p.lat, longitude: p.lng, accuracy: 6, altitude: null,
      altitudeAccuracy: null, heading: null, speed: null,
    },
    timestamp: p.t ?? Date.now(),
  });
  window.__geo = {
    watching: () => watchers.size,
    send(p) {
      last = p;
      for (const cb of watchers.values()) cb(position(p));
    },
  };
  Object.defineProperty(navigator, "geolocation", {
    value: {
      watchPosition(ok) {
        const id = next++;
        watchers.set(id, ok);
        return id;
      },
      clearWatch(id) {
        watchers.delete(id);
      },
      getCurrentPosition(ok) {
        if (last) ok(position(last));
      },
    },
  });
  // the page's own visibility, so the test can turn the screen off
  let hidden = false;
  Object.defineProperty(document, "hidden", { get: () => hidden });
  Object.defineProperty(document, "visibilityState", {
    get: () => (hidden ? "hidden" : "visible"),
  });
  window.__screen = (on) => {
    hidden = !on;
    document.dispatchEvent(new Event("visibilitychange"));
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const frame = () =>
  page.evaluate(() => {
    const v = document.querySelector(".cam-video-box video");
    const box = document.querySelector(".cam-video-box").getBoundingClientRect();
    const vp = document.querySelector(".cam-viewport").getBoundingClientRect();
    return {
      w: v.videoWidth, h: v.videoHeight,
      boxW: Math.round(box.width), boxH: Math.round(box.height),
      vpW: Math.round(vp.width), vpH: Math.round(vp.height),
    };
  });
const ratio = (a, b) => Math.max(a, b) / Math.min(a, b);
const waitForShape = (r) =>
  page.waitForFunction(
    (r) => {
      const v = document.querySelector(".cam-video-box video");
      if (!v || !v.videoWidth || v.paused) return false;
      const k = Math.max(v.videoWidth, v.videoHeight) / Math.min(v.videoWidth, v.videoHeight);
      return Math.abs(k - r) < 0.02;
    },
    r,
    { timeout: 20000 }
  );

/** Take a photo the way the shutter does, and wait for it to be saved. */
const live = () =>
  page.waitForFunction(
    () => {
      const v = document.querySelector(".cam-video-box video");
      return v && v.videoWidth > 0 && !v.paused && v.srcObject?.getVideoTracks()[0]?.readyState === "live";
    },
    null,
    { timeout: 20000 }
  );
const shoot = () =>
  page.evaluate(async () => {
    const { grabFrame, processCapture } = await import("/src/lib/capture.ts");
    const { job } = await grabFrame();
    const { record } = await processCapture(job);
    return {
      lat: record.data.fix?.lat,
      address: record.data.address ?? null,
      at: record.data.timestamp,
    };
  });

try {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => window.__geo?.watching() > 0, null, { timeout: 20000 });
  await page.evaluate((p) => window.__geo.send(p), A);
  const coach = page.locator("text=Got it").first();
  if (await coach.isVisible().catch(() => false)) await coach.click();

  // ---- 1. the frame ---------------------------------------------------
  await waitForShape(4 / 3);
  await page.waitForTimeout(500);
  let f = await frame();
  check("a photo opens the whole 4:3 frame", Math.abs(ratio(f.w, f.h) - 4 / 3) < 0.02, `${f.w}×${f.h}`);
  check(
    "the viewfinder shows all of it, nothing cropped off the sides",
    Math.abs(ratio(f.boxW, f.boxH) - 4 / 3) < 0.02 && f.boxW <= f.vpW && f.boxH <= f.vpH,
    `box ${f.boxW}×${f.boxH} in ${f.vpW}×${f.vpH}`
  );

  await page.getByRole("button", { name: /^video$/i }).first().click();
  await waitForShape(16 / 9);
  await page.waitForTimeout(500);
  f = await frame();
  check("video opens its 16:9 profile", Math.abs(ratio(f.w, f.h) - 16 / 9) < 0.02, `${f.w}×${f.h}`);
  check("video fills the viewfinder", f.boxW === f.vpW && f.boxH === f.vpH, `box ${f.boxW}×${f.boxH} in ${f.vpW}×${f.vpH}`);
  const mics = await page.evaluate(
    () => document.querySelector(".cam-video-box video").srcObject.getAudioTracks().filter((t) => t.readyState === "live").length
  );
  check("video has its microphone, once", mics === 1, `${mics} live audio tracks`);

  await page.getByRole("button", { name: /^photo$/i }).first().click();
  await waitForShape(4 / 3);
  f = await frame();
  check("back to photo, back to 4:3", Math.abs(ratio(f.w, f.h) - 4 / 3) < 0.02, `${f.w}×${f.h}`);

  // ---- 2. a photo's address is its own ---------------------------------
  const viewfinder = await page.evaluate(async () => {
    const { useLiveStore } = await import("/src/store.ts");
    for (let i = 0; i < 100 && !useLiveStore.getState().address; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return useLiveStore.getState().address ?? null;
  });
  check("the viewfinder has the address for where it stands", /13\.0405/.test(viewfinder ?? ""), JSON.stringify(viewfinder));
  // a short walk: 120 m, under the old 150 m reuse distance; shoot at
  // once, before the viewfinder's own refresh can land
  await page.evaluate((p) => window.__geo.send(p), B);
  const near = await shoot();
  check("a photo a street on is stamped with its own spot", Math.abs(near.lat - B.lat) < 1e-6, String(near.lat));
  check("and gets the address for that spot, not the last one", /13\.0416/.test(near.address ?? ""), near.address);

  // ---- 3. screen off, walk, screen on, shoot ---------------------------
  await page.evaluate(() => window.__screen(false));
  await page.waitForTimeout(9000);
  await page.evaluate(() => window.__screen(true));
  await live();
  // the phone takes a moment to measure where it now is; the shutter
  // goes before it does
  const pending = shoot();
  await page.waitForTimeout(1500);
  await page.evaluate((p) => window.__geo.send(p), C);
  const after = await pending;
  check("the first photo after the screen comes back is stamped where it was taken", Math.abs(after.lat - C.lat) < 1e-6, `${after.lat} (old place ${B.lat})`);
  check("with that place's address", /13\.0495/.test(after.address ?? ""), after.address);

  // an old position handed back on resume is not a new measurement
  await page.evaluate(() => window.__screen(false));
  await page.waitForTimeout(9000);
  await page.evaluate(() => window.__screen(true));
  await live();
  const pending2 = shoot();
  await page.evaluate((p) => window.__geo.send({ ...p, t: Date.now() - 60_000 }), B);
  await page.waitForTimeout(800);
  await page.evaluate((p) => window.__geo.send(p), A);
  const after2 = await pending2;
  check("a cached position from before the screen went off is not taken for the new one", Math.abs(after2.lat - A.lat) < 1e-6, String(after2.lat));

  // ---- 4. a lookup that never answers ---------------------------------
  hang.add(D.lat.toFixed(4));
  await page.waitForTimeout(6500);
  await page.evaluate((p) => window.__geo.send(p), D);
  await page.waitForTimeout(7000);
  await page.evaluate((p) => window.__geo.send(p), E);
  // the stalled lookup is given up on; the next fix gets its address
  const t1 = Date.now();
  let got = null;
  while (Date.now() - t1 < 20000) {
    await page.evaluate((p) => window.__geo.send(p), E);
    got = await page.evaluate(async () => (await import("/src/store.ts")).useLiveStore.getState().address ?? null);
    if (/13\.0541/.test(got ?? "")) break;
    await page.waitForTimeout(1000);
  }
  check(
    "a lookup that never answers does not keep the old address on screen",
    /13\.0541/.test(got ?? ""),
    `${got} after ${Math.round((Date.now() - t1) / 1000)} s`
  );

  // standing still with the screen on: no wait at all
  const t0 = Date.now();
  await shoot();
  check("with the screen on throughout, a photo does not wait for anything", Date.now() - t0 < 3000, `${Date.now() - t0} ms`);

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `\n${failures} failed` : "\na photo says where it was taken, and shows what the camera sees");
process.exit(failures ? 1 : 0);
