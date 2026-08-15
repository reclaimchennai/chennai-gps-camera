#!/usr/bin/env node
/**
 * The shutter is the product.
 *
 * A camera for documenting a street has one job before all the others:
 * fire the instant it is tapped, and be ready again immediately, so
 * someone can bash the button walking past and get every frame. Everything
 * else on the card is worth nothing if the moment was missed.
 *
 * This measures the only part that blocks a tap — the frame grab — and
 * then hammers the real shutter to prove nothing is dropped or serialised
 * behind the slow work. The heavy lifting (watermark, EXIF, encode, save)
 * belongs in the background queue, so a burst must NOT cost N times a
 * single shot.
 *
 *   node scripts/check-shutter.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const GEO = { latitude: 13.0405, longitude: 80.2337, accuracy: 8 };
const BURST = 10;

// Budgets, in ms. Generous next to a phone, because this runs on a
// desktop with a synthetic camera — they exist to catch a REGRESSION in
// kind (a blocking still-capture, a sync encode) rather than to certify a
// device. v1.45.0 put ImageCapture.takePhoto() in this path, which is a
// full sensor cycle with autofocus and exposure convergence on Android.
const GRAB_BUDGET = 60;
const READY_BUDGET = 120;

// the dev server, not the built bundle: the harness imports the modules
// directly to time the one call that blocks a tap
const server = await createServer({
  server: { port: 4531, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const base = "http://127.0.0.1:4531";
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
  geolocation: GEO,
  permissions: ["geolocation", "camera"],
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0 && !v.paused;
    },
    { timeout: 20000 }
  );
  // let exposure/geolocation settle so the first shot is not measuring startup
  await page.waitForTimeout(2500);
  const coach = page.locator("text=Got it").first();
  if (await coach.isVisible().catch(() => false)) await coach.click();

  // ---- 1. the blocking part of a tap ---------------------------------
  // Both halves are timed. captureFrame() is the camera call; grabFrame()
  // is everything a tap actually waits on — the frame, the rotate/crop
  // pass and the fly-to-gallery thumbnail — before the shutter is free.
  const grab = await page.evaluate(async () => {
    const { camera, lastCapture } = await import("/src/lib/camera.ts");
    const { grabFrame } = await import("/src/lib/capture.ts");
    const med = (xs) => {
      xs.sort((a, b) => a - b);
      return xs[Math.floor(xs.length / 2)];
    };
    const frameT = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      const bmp = await camera.captureFrame();
      frameT.push(performance.now() - t);
      bmp.close?.();
    }
    const source = lastCapture()?.source ?? "unknown";
    const size = lastCapture();
    const fullT = [];
    for (let i = 0; i < 8; i++) {
      const t = performance.now();
      const { job } = await grabFrame();
      fullT.push(performance.now() - t);
      job.canvas.width = 0; // release the held frame
      job.canvas.height = 0;
    }
    return {
      frame: med(frameT),
      frameWorst: frameT[frameT.length - 1],
      full: med(fullT),
      fullWorst: fullT[fullT.length - 1],
      source,
      px: size ? `${size.width}x${size.height}` : "?",
    };
  });
  check(
    "camera hands back a frame immediately",
    grab.frame <= GRAB_BUDGET,
    `median ${grab.frame.toFixed(1)} ms, worst ${grab.frameWorst.toFixed(1)} ms, ${grab.px} from the ${grab.source}`
  );
  check(
    "nothing else blocks the next tap",
    grab.full <= READY_BUDGET,
    `whole grab median ${grab.full.toFixed(1)} ms, worst ${grab.fullWorst.toFixed(1)} ms`
  );

  // ---- 2. the opt-in sensor path still works, and costs what it says --
  const sensor = await page.evaluate(async () => {
    const { camera, lastCapture } = await import("/src/lib/camera.ts");
    const { useSettingsStore } = await import("/src/store.ts");
    const before = useSettingsStore.getState().settings.fullSensorStills;
    useSettingsStore.getState().setSettings({ fullSensorStills: true });
    const times = [];
    for (let i = 0; i < 8; i++) {
      const t = performance.now();
      const bmp = await camera.captureFrame();
      times.push(performance.now() - t);
      bmp.close?.();
    }
    const c = lastCapture();
    useSettingsStore.getState().setSettings({ fullSensorStills: before });
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(times.length / 2)], source: c?.source };
  });
  check(
    "the full-sensor setting is honoured",
    sensor.source === "sensor",
    `${sensor.median.toFixed(1)} ms a frame from the ${sensor.source} — ` +
      `${(sensor.median / grab.frame).toFixed(0)}x the default path, and this is a synthetic camera`
  );

  // ---- 3. a burst loses nothing --------------------------------------
  const before = await page.evaluate(async () => {
    const { listMedia } = await import("/src/lib/db.ts");
    return (await listMedia()).length;
  });

  const shutter = page.locator("button.shutter");
  const t0 = Date.now();
  for (let i = 0; i < BURST; i++) {
    await shutter.dispatchEvent("click");
  }
  const tapsDone = Date.now() - t0;

  // Polled by hand: waitForFunction with an async predicate is always
  // satisfied on the first tick, because a Promise is truthy.
  const countNow = () =>
    page.evaluate(async () => {
      const { listMedia } = await import("/src/lib/db.ts");
      return (await listMedia()).length;
    });
  let after = before;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    after = await countNow();
    if (after >= before + BURST) break;
    await page.waitForTimeout(100);
  }
  const saved = after - before;
  const total = Date.now() - t0;

  check(
    `a burst of ${BURST} keeps every frame`,
    saved === BURST,
    `${saved}/${BURST} saved`
  );
  check(
    "the shutter accepts taps faster than it saves them",
    tapsDone / BURST <= READY_BUDGET,
    `${(tapsDone / BURST).toFixed(1)} ms per tap accepted, ${(total / BURST).toFixed(0)} ms per photo to fully persist`
  );
  // The whole point of the background queue: taps must not wait on saves.
  check(
    "the slow work stays off the shutter",
    tapsDone < total * 0.6,
    `taps took ${tapsDone} ms of the ${total} ms it took to persist them all`
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
console.log("\nshutter stays out of the way");
