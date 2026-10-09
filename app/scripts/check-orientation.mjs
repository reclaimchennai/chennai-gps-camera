#!/usr/bin/env node
/**
 * Turn the phone, press the shutter: the photo is laid out the way the
 * phone was held.
 *
 * Reported: switching to landscape was not smooth, and photos came out
 * with the card in portrait format on a landscape photo. The capture read
 * the UI's DEBOUNCED orientation — gravity had to dominate by 1.3x and
 * then hold for 250 ms — so turning and shooting straight away saved a
 * frame laid out for the orientation just left. Now the shutter reads the
 * hand directly, the UI follows within 120 ms, and both classify by angle
 * with hysteresis the way Android's camera does.
 *
 *   node scripts/check-orientation.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4651, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});
const ctx = await browser.newContext({
  viewport: { width: 412, height: 915 },
  geolocation: { latitude: 13.0405, longitude: 80.2337, accuracy: 8 },
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

try {
  await page.goto("http://127.0.0.1:4651/", { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0;
    },
    { timeout: 20000 }
  );

  const r = await page.evaluate(async () => {
    const { physicalRotation } = await import("/src/lib/orientation.ts");
    const { useLiveStore } = await import("/src/store.ts");
    const { grabFrame } = await import("/src/lib/capture.ts");
    const tilt = (deg, flatness = 0.1) => {
      const g = 9.81;
      const rad = (deg * Math.PI) / 180;
      window.dispatchEvent(
        new DeviceMotionEvent("devicemotion", {
          accelerationIncludingGravity: {
            x: g * Math.sin(rad),
            y: g * Math.cos(rad),
            z: g * flatness,
          },
        })
      );
    };
    const settle = async (deg, ms = 300) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        tilt(deg);
        await new Promise((res) => setTimeout(res, 16));
      }
    };
    const ui = () => useLiveStore.getState().uiRotation;
    const out = {};

    await settle(0);
    out.portrait = { physical: physicalRotation(), ui: ui() };
    // the untouched shot, for comparison: whatever shape this camera's
    // frames are, turning the phone must swap it
    {
      const { job } = await grabFrame();
      out.uprightShot = { w: job.w, h: job.h };
      job.canvas.width = 0;
    }

    // the reported failure: turn and shoot in the same instant
    tilt(90);
    out.instant = { physical: physicalRotation(), ui: ui() };
    const { job } = await grabFrame();
    out.instantShot = { w: job.w, h: job.h };
    job.canvas.width = 0;

    await settle(90);
    out.landscape = { physical: physicalRotation(), ui: ui() };

    // hysteresis: from landscape, 40° (5° past the 45° line) is still landscape
    await settle(40);
    out.hold40 = physicalRotation();
    await settle(25);
    out.back25 = physicalRotation();

    // from portrait, 50° is not yet landscape; 60° is
    await settle(0);
    await settle(50);
    out.port50 = physicalRotation();
    await settle(60);
    out.port60 = physicalRotation();

    // pointing at the ground: nearly flat, so keep the last answer
    await settle(0);
    await settle(-90);
    out.beforeFlat = physicalRotation();
    for (let i = 0; i < 20; i++) {
      tilt(0, 4); // gravity mostly through the screen
      await new Promise((res) => setTimeout(res, 16));
    }
    out.flat = physicalRotation();

    // upside-down portrait counts as portrait
    await settle(180);
    out.upside = physicalRotation();
    return out;
  });

  check("portrait reads as portrait", r.portrait.physical === 0 && r.portrait.ui === 0);
  check(
    "turn and shoot at once: the shutter already knows",
    r.instant.physical === 90,
    `hand ${r.instant.physical}°, UI still ${r.instant.ui}°`
  );
  check(
    "…and the photo is laid out for the turned phone",
    r.instantShot.w === r.uprightShot.h && r.instantShot.h === r.uprightShot.w,
    `upright ${r.uprightShot.w}×${r.uprightShot.h}, turned-and-shot ${r.instantShot.w}×${r.instantShot.h}`
  );
  check(
    "the UI follows within a moment",
    r.landscape.ui === 90 && r.landscape.physical === 90
  );
  check(
    "it does not chatter near the boundary",
    r.hold40 === 90 && r.back25 === 0 && r.port50 === 0 && r.port60 === 90,
    `landscape→40° ${r.hold40}, →25° ${r.back25}; portrait→50° ${r.port50}, →60° ${r.port60}`
  );
  check(
    "pointing at the ground keeps the last orientation",
    r.beforeFlat === -90 && r.flat === -90,
    `before ${r.beforeFlat}, flat ${r.flat}`
  );
  check("upside-down portrait counts as portrait", r.upside === 0);

  // ---- the card in landscape -------------------------------------------
  const card = await page.evaluate(async () => {
    const { renderWatermark } = await import("/src/lib/watermark/render.ts");
    const data = {
      timestamp: Date.now(),
      tzOffsetMinutes: -330,
      fix: { lat: 13.107929, lng: 80.237139, accuracy: 8 },
      locality: "Perambur, Chennai",
      address: "58, Madhavaram High Rd, Chinnaiyan Colony, Perambur, Chennai, Tamil Nadu - 600011",
      jurisdiction: {
        scope: "gcc", city: "Chennai", corporation: "Greater Chennai Corporation",
        zone: "Thiru-Vika-Nagar", ward: "070", loStation: "K1 Sembium PS", trafficStation: "K1 Sembium PS",
      },
    };
    const config = {
      preset: "detailed",
      fields: {
        brand: false, datetime: true, coords: true, digipin: true, altitudeAccuracy: false,
        address: true, titleLine: true, ward: true, zone: true, loStation: true, trafficStation: true,
        miniMap: false, qrCode: false, compass: false, soundLevel: false, profilePhoto: false,
        socialHandles: false, customLabel: false,
      },
      fontScale: 0.8, opacity: 0.55, theme: "dark", customLabelText: "", language: "en",
      signShape: "box", onlineMapUpgrade: false, position: "bottom",
    };
    const draw = (w, h) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      x.fillStyle = "#777";
      x.fillRect(0, 0, w, h);
      return renderWatermark(x, w, h, data, config, { name: "", handles: {} }, {});
    };
    return { land: draw(1920, 1080), port: draw(1080, 1920) };
  });
  check(
    "a landscape photo gets a landscape card",
    card.land.height < card.port.height * 0.8 && card.land.width > card.port.width,
    `landscape ${Math.round(card.land.width)}×${Math.round(card.land.height)} vs portrait ` +
      `${Math.round(card.port.width)}×${Math.round(card.port.height)}`
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
console.log("\nthe photo is laid out the way the phone was held");
