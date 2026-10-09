#!/usr/bin/env node
/**
 * The photo map's heatmap follows a pinch, frame by frame.
 *
 * Reported: the heat overlay stuttered and lagged behind a pinch. The old
 * layer (leaflet.heat) ignored the zoom events a pinch is made of and
 * repainted everything when the gesture ended. lib/map/smoothHeat.ts
 * paints once and lets the map move and scale the result.
 *
 *   node scripts/check-map.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";
const server = await createServer({ server: { port: 4681, host: "127.0.0.1" }, logLevel: "error" });
await server.listen();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 });
const page = await ctx.newPage();
await ctx.route("https://tile.openstreetmap.org/**", (r) => r.fulfill({ status: 204, body: "" }));
await page.goto("http://127.0.0.1:4681", { waitUntil: "load" });
await page.evaluate(async () => {
  const { putMedia, newId } = await import("/src/lib/db.ts");
  const spots = [[31.95, 77.31], [32.0, 77.3], [30.9, 75.85], [29.97, 76.83], [28.61, 77.21], [26.91, 75.79], [27.0, 75.9], [31.1, 77.17], [30.3, 78.0]];
  let t = Date.now();
  for (let i = 0; i < 120; i++) {
    const [la, ln] = spots[i % spots.length];
    await putMedia({ id: newId(), kind: "photo", createdAt: t - i * 60000, width: 10, height: 10, data: { fix: { lat: la + Math.random() * 0.2, lng: ln + Math.random() * 0.2, accuracy: 5 }, timestamp: t, tzOffsetMinutes: 0, jurisdiction: null }, config: {}, backfill: "not-needed" });
  }
  location.hash = "#/gallery/map";
});
await page.waitForSelector(".photo-map canvas.leaflet-image-layer", { timeout: 15000 });
await page.waitForTimeout(800);
// watch: long frames and whether the heat canvas moves every frame during a pinch
await page.evaluate(() => {
  window.__frames = []; window.__moves = 0; let last = "";
  const tick = (t) => {
    window.__frames.push(t);
    const c = document.querySelector(".photo-map canvas.leaflet-image-layer");
    const k = c ? c.style.transform + c.style.width : "";
    if (k !== last) { window.__moves++; last = k; }
    if (window.__frames.length < 400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const cdp = await ctx.newCDPSession(page);
const cx = 206, cy = 500;
const pts = (d) => [{ x: cx - d / 2, y: cy, id: 1 }, { x: cx + d / 2, y: cy, id: 2 }];
async function pinch(d0, d1, steps) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0) });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 + ((d1 - d0) * i) / steps) }); await page.waitForTimeout(16); }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
await pinch(80, 260, 40);
await page.waitForTimeout(600);
await pinch(260, 90, 40);
await page.waitForTimeout(800);
const r = await page.evaluate(() => {
  const f = window.__frames; const gaps = [];
  for (let i = 1; i < f.length; i++) gaps.push(f[i] - f[i - 1]);
  gaps.sort((a, b) => b - a);
  return { frames: f.length, heatUpdates: window.__moves, worst: gaps.slice(0, 5).map(Math.round), over50: gaps.filter((g) => g > 50).length, layers: document.querySelectorAll(".photo-map canvas.leaflet-image-layer").length };
});
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`); if (!ok) failures++; };
check("the heat moves with the map during a pinch", r.heatUpdates >= 40, `${r.heatUpdates} frames moved it`);
check("no frame stalls while pinching", r.over50 === 0, `worst frames ${r.worst.join(", ")} ms`);
check("one heat layer, swapped not stacked", r.layers === 1, `${r.layers}`);
await b.close(); await server.close();
console.log(failures ? `\n${failures} failed` : "\nthe heatmap follows the fingers");
process.exit(failures ? 1 : 0);
