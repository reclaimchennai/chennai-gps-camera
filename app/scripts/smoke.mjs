#!/usr/bin/env node
/**
 * End-to-end smoke test against the production build (dist/):
 * fake camera + Chennai geolocation → capture a photo → verify the
 * offline jurisdiction lookup, watermark, EXIF marker, and gallery.
 *
 *   node scripts/smoke.mjs [--screenshots-dir DIR]
 */
import { chromium } from "playwright";
import { preview } from "vite";
import { mkdirSync } from "node:fs";

const shotsDir =
  process.argv.includes("--screenshots-dir")
    ? process.argv[process.argv.indexOf("--screenshots-dir") + 1]
    : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// T. Nagar, Chennai — inside GCC, should resolve ward + police stations.
const GEO = { latitude: 13.0405, longitude: 80.2337, accuracy: 8 };

const server = await preview({ preview: { port: 4517, host: "127.0.0.1" } });
const base = "http://127.0.0.1:4517";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  geolocation: GEO,
  permissions: ["geolocation", "camera"],
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
const downloads = [];
page.on("download", (d) => downloads.push(d.suggestedFilename()));
page.on("pageerror", (e) => {
  errors.push(String(e));
  console.log("  pageerror:", String(e).slice(0, 200));
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("  console.error:", m.text().slice(0, 200));
});

try {
  await page.goto(base, { waitUntil: "load" });

  // 1. camera live
  await page.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.readyState >= 2 && v.videoWidth > 0;
    },
    { timeout: 15000 }
  );
  check("viewfinder live", true);

  // 2. camera chrome: exactly [flash][settings], coverage chip retired
  const topButtons = await page.locator(".cam-top .cam-round").count();
  const chipCount = await page.locator(".cam-chip").count();
  check(
    "camera top bar minimal",
    topButtons === 2 && chipCount === 0,
    `${topButtons} buttons, ${chipCount} chips`
  );

  // 2b. enable DIGIPIN + verify top card position renders at the top
  await page.goto(`${base}/#/settings/watermark`);
  await page.waitForTimeout(900);
  const digipinSwitch = page
    .locator(".row", { hasText: "DIGIPIN" })
    .locator(".switch");
  // DIGIPIN defaults on now — only toggle when it happens to be off, so the
  // encoding check downstream always runs with the field enabled.
  if ((await digipinSwitch.getAttribute("aria-checked")) === "false") {
    await digipinSwitch.click();
  }
  await page.getByText("Top", { exact: true }).click();
  await page.goto(`${base}/#/`);
  await page.waitForTimeout(1800);
  const topPainted = await page.evaluate(() => {
    const c = document.querySelector("canvas.cam-overlay");
    if (!c || c.width === 0) return false;
    const ctx = c.getContext("2d");
    const top = ctx.getImageData(0, 0, c.width, 60).data;
    let hits = 0;
    for (let i = 3; i < top.length; i += 4) if (top[i] > 0) hits++;
    return hits > 200;
  });
  check("watermark card at top position", topPainted);
  await page.goto(`${base}/#/settings/watermark`);
  await page.waitForTimeout(700);
  await page.getByText("Bottom", { exact: true }).click();
  await page.goto(`${base}/#/`);
  await page.waitForTimeout(1200);

  // 3. live watermark overlay painted (interval-driven — poll for it)
  const overlayPainted = await page
    .waitForFunction(
      () => {
        const c = document.querySelector("canvas.cam-overlay");
        if (!c || c.width === 0) return false;
        const ctx = c.getContext("2d");
        const d = ctx.getImageData(0, c.height - 60, c.width, 60).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
        return false;
      },
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false);
  check("live watermark overlay", overlayPainted);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/1-camera.png` });

  // 4. capture: tap shutter, record lands in IndexedDB
  const t0 = Date.now();
  await page.locator(".shutter").click();
  let persisted = false;
  while (Date.now() - t0 < 15000 && !persisted) {
    persisted = await page.evaluate(
      () =>
        new Promise((res) => {
          const req = indexedDB.open("chennai-gps-cam");
          req.onsuccess = () => {
            const db = req.result;
            try {
              const count = db
                .transaction("media")
                .objectStore("media")
                .count();
              count.onsuccess = () => {
                db.close();
                res(count.result > 0);
              };
              count.onerror = () => {
                db.close();
                res(false);
              };
            } catch {
              db.close();
              res(false);
            }
          };
          req.onerror = () => res(false);
        })
    );
    if (!persisted) await page.waitForTimeout(150);
  }
  check("photo saved", persisted, `${Date.now() - t0} ms tap→persisted`);

  // 5. saved JPEG has EXIF and the burned watermark
  const exif = await page.evaluate(async () => {
    const open = indexedDB.open("chennai-gps-cam");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = rej;
    });
    // one transaction per read — IDB transactions die across awaits
    const media = await new Promise((res) => {
      const r = db.transaction("media").objectStore("media").getAll();
      r.onsuccess = () => res(r.result);
    });
    const photo = media.find((m) => m.kind === "photo");
    if (!photo)
      return {
        fail: `no photo record; store has ${media.length}: ${JSON.stringify(
          media.map((m) => ({ id: m.id, kind: m.kind }))
        )}`,
      };
    const blob = await new Promise((res) => {
      const r = db
        .transaction("blobs")
        .objectStore("blobs")
        .get(`${photo.id}/final`);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    });
    db.close();
    if (!blob) return { fail: "no final blob" };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const head = Array.from(bytes.slice(0, 200))
      .map((b) => String.fromCharCode(b))
      .join("");
    return {
      size: blob.size,
      hasExif: head.includes("Exif"),
      record: {
        scope: photo.data.jurisdiction?.scope,
        corp: photo.data.jurisdiction?.corporation,
        ward: photo.data.jurisdiction?.ward,
        lo: photo.data.jurisdiction?.loStation,
        traffic: photo.data.jurisdiction?.trafficStation,
        digipin: photo.data.digipin,
        backfill: photo.backfill,
      },
    };
  });
  check(
    "EXIF header present",
    Boolean(exif?.hasExif),
    exif?.fail ?? `jpeg ${exif?.size} bytes`
  );
  check(
    "jurisdiction stamped",
    exif?.record?.scope === "in" &&
      exif?.record?.corp === "Greater Chennai Corporation" &&
      Boolean(exif?.record?.lo),
    JSON.stringify(exif?.record ?? exif)
  );
  // DIGIPIN verified against India Post's official implementation for
  // this exact coordinate (13.0405, 80.2337)
  check(
    "DIGIPIN encoded (official vector)",
    exif?.record?.digipin === "4T32886P6J",
    String(exif?.record?.digipin)
  );

  // 6. second capture, then gallery grid must list BOTH photos
  await page.locator(".shutter").click();
  await page.waitForTimeout(2500);
  await page.locator(".thumb-btn").first().click();
  await page.waitForSelector(".gallery-grid", { timeout: 10000 });
  await page.waitForTimeout(600);
  const cellCount = await page.locator(".gallery-cell").count();
  check("gallery lists all photos", cellCount >= 2, `${cellCount} items`);
  check(
    "auto-save to device",
    downloads.length >= 2,
    downloads.slice(0, 3).join(", ")
  );
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/5-gallery.png` });
  await page.locator(".gallery-cell").first().click();
  await page.waitForSelector(".viewer-media img", { timeout: 10000 });
  check("photo detail opens", true);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/2-detail.png` });

  // Guard against the carousel black-screen regression: the current pane's
  // image must actually be on-screen, not translated off into the void.
  const preview = await page.evaluate(() => {
    const panes = document.querySelectorAll(".viewer-pane");
    const img = (panes[1] || panes[0])?.querySelector("img");
    const r = img?.getBoundingClientRect();
    if (!img || !r) return { ok: false, why: "no image" };
    const onScreen =
      r.left < innerWidth && r.right > 0 && r.width > 80 && r.height > 80;
    return { ok: onScreen, w: Math.round(r.width), h: Math.round(r.height) };
  });
  check(
    "gallery preview visible (not black-screened)",
    preview.ok,
    preview.ok ? `${preview.w}×${preview.h} on-screen` : preview.why || "off-screen",
  );

  // 7. annotation editor loads (lazy chunk + Konva) with first-run coach.
  // The action chrome is hidden by default now — tap the media to raise it.
  await page.locator(".viewer-media").click({ position: { x: 180, y: 300 } });
  await page.waitForSelector(".viewer-bottom.show", { timeout: 5000 });
  await page.getByText("Annotate").click();
  await page.waitForSelector(".coach-scrim", { timeout: 15000 });
  check("first-run coach overlay", true);
  await page.getByText("Got it").click();
  await page.waitForSelector(".editor-stage-wrap canvas", { timeout: 15000 });
  check("annotation editor opens", true);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/3-editor.png` });

  // 8. watermark settings preview
  await page.goto(`${base}/#/settings/watermark`);
  await page.waitForFunction(() => {
    const c = document.querySelector("canvas.wm-preview");
    return c && c.width > 100;
  }, { timeout: 10000 });
  check("watermark editor preview", true);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/4-watermark.png` });

  // 9. PWA installability basics
  const pwa = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const mf = await fetch("/manifest.webmanifest").then((r) => r.json());
    return {
      sw: Boolean(reg?.active),
      icons: (mf.icons ?? []).map((i) => i.sizes),
      display: mf.display,
      hasMaskable: (mf.icons ?? []).some((i) => i.purpose === "maskable"),
    };
  });
  check(
    "service worker active",
    pwa.sw
  );
  check(
    "manifest complete",
    pwa.display === "standalone" &&
      pwa.icons.includes("192x192") &&
      pwa.icons.includes("512x512") &&
      pwa.hasMaskable,
    JSON.stringify(pwa)
  );

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  // 10. Bengaluru region pack: fresh context at Cubbon Park — the pack
  // must fetch on demand and stamp GBA corporation/ward/police
  const blrCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    geolocation: { latitude: 12.9763, longitude: 77.5929, accuracy: 8 },
    permissions: ["geolocation", "camera"],
    deviceScaleFactor: 2,
  });
  const blrPage = await blrCtx.newPage();
  await blrPage.goto(base, { waitUntil: "load" });
  await blrPage.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.readyState >= 2 && v.videoWidth > 0;
    },
    { timeout: 15000 }
  );
  await blrPage.waitForTimeout(3500); // fix + pack fetch + lookup
  await blrPage.locator(".shutter").click();
  await blrPage.waitForTimeout(3000);
  const blr = await blrPage.evaluate(async () => {
    const open = indexedDB.open("chennai-gps-cam");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = rej;
    });
    const media = await new Promise((res) => {
      const r = db.transaction("media").objectStore("media").getAll();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    const j = media.find((m) => m.kind === "photo")?.data.jurisdiction;
    return j
      ? { corp: j.corporation, ward: j.ward, wardName: j.wardName, zone: j.zone, lo: j.loStation, traffic: j.trafficStation }
      : null;
  });
  check(
    "Bengaluru pack lookup",
    Boolean(
      blr &&
        /Bengaluru .*City Corporation/.test(blr.corp ?? "") &&
        blr.ward === "4" &&
        blr.lo === "Cubbon Park PS"
    ),
    JSON.stringify(blr)
  );
  await blrCtx.close();

  // 11. live-blur video recording: with the setting on, the saved file
  // itself must be the composited (blur-burned) stream and decodable
  const vidCtx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    geolocation: { latitude: 13.0405, longitude: 80.2337, accuracy: 8 },
    permissions: ["geolocation", "camera", "microphone"],
  });
  const vidPage = await vidCtx.newPage();
  await vidPage.goto(base, { waitUntil: "load" });
  await vidPage.waitForTimeout(2000);
  await vidPage.locator('[aria-label="Settings"]').click();
  await vidPage.waitForTimeout(500);
  // live face blur lives in the collapsed Advanced section now
  await vidPage.locator(".adv-toggle").click();
  await vidPage.waitForTimeout(450);
  await vidPage
    .locator(".row", { hasText: "Live face blur" })
    .locator("button.switch")
    .click();
  await vidPage.goBack();
  await vidPage.waitForTimeout(800);
  await vidPage.getByText("VIDEO", { exact: true }).click();
  await vidPage.waitForTimeout(1500);
  await vidPage.locator(".shutter").click();
  await vidPage.waitForTimeout(2500);
  await vidPage.locator(".shutter").click();
  await vidPage.waitForTimeout(3000);
  const vid = await vidPage.evaluate(async () => {
    const open = indexedDB.open("chennai-gps-cam");
    const db = await new Promise((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = rej;
    });
    const media = await new Promise((res) => {
      const r = db.transaction("media").objectStore("media").getAll();
      r.onsuccess = () => res(r.result);
    });
    const rec = media
      .filter((m) => m.kind === "video")
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!rec) return null;
    const blob = await new Promise((res) => {
      const r = db.transaction("blobs").objectStore("blobs").get(rec.id + "/source");
      r.onsuccess = () => res(r.result);
    });
    db.close();
    if (!blob || !blob.size) return { blurBurned: rec.blurBurned, decodable: false };
    const v = document.createElement("video");
    v.muted = true;
    v.src = URL.createObjectURL(blob);
    const decodable = await new Promise((res) => {
      v.onloadedmetadata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 8000);
    });
    return {
      blurBurned: rec.blurBurned ?? false,
      watermarkBurned: rec.watermarkBurned ?? false,
      decodable,
      size: blob.size,
      type: blob.type,
    };
  });
  check(
    "live-blur video burns into file",
    Boolean(vid && vid.blurBurned && vid.decodable),
    JSON.stringify(vid)
  );
  check(
    "video watermark burned into recording",
    Boolean(vid && vid.watermarkBurned && vid.decodable),
    JSON.stringify(vid)
  );
  await vidCtx.close();
} catch (err) {
  failures++;
  console.error("FATAL", err);
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/fatal.png` }).catch(() => {});
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
