#!/usr/bin/env node
/**
 * On-device photo benchmark: taps the real shutter N times and measures,
 * on the page's own clock,
 *  - when each press lands (pointerdown on the shutter),
 *  - when each photo is saved in the app (a new IndexedDB media record),
 *  - viewfinder smoothness throughout (rAF frame gaps: over 50 ms is a
 *    visible stutter, over 100 ms a hitch),
 * and afterwards, with adb, when the files reached the phone's gallery.
 *
 *   CDP_PORT=9333 node scripts/device/bench-photo.mjs [shots=5] [gapMs=800]
 */
import { connect } from "./cdp.mjs";

const shots = Number(process.argv[2] || 5);
const gap = Number(process.argv[3] || 800);
const c = await connect();

const setup = await c.evaluate(`
  const b = document.querySelector('[aria-label="Take photo"]');
  if (!b) return { err: "no shutter" };
  const r = b.getBoundingClientRect();
  const count = async () => {
    const db = await new Promise((r, j) => { const q = indexedDB.open("chennai-gps-cam"); q.onsuccess = () => r(q.result); q.onerror = j; });
    const n = await new Promise((r) => { const q = db.transaction("media").objectStore("media").count(); q.onsuccess = () => r(q.result); });
    db.close(); return n;
  };
  const B = window.__bench = { t0: performance.now(), taps: [], saved: [], gaps: [], long: [], base: await count(), stop: false };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) B.long.push([Math.round(e.startTime - B.t0), Math.round(e.duration)]); }).observe({ type: "longtask" });
  } catch {}
  b.addEventListener("pointerdown", () => B.taps.push(performance.now() - B.t0), { capture: true });
  let last = performance.now();
  const loop = (t) => { B.gaps.push(t - last); last = t; if (!B.stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  (async () => {
    let n = B.base;
    while (!B.stop) {
      const m = await count();
      while (m > n) { B.saved.push(performance.now() - B.t0); n++; }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  B.wall = Date.now();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, base: B.base, wall: B.wall };
`);
if (setup.err) { console.log(setup.err); process.exit(1); }

for (let i = 0; i < shots; i++) {
  await c.tap(setup.x, setup.y);
  await new Promise((r) => setTimeout(r, gap));
}
const deadline = Date.now() + 60_000;
let B;
do {
  await new Promise((r) => setTimeout(r, 250));
  B = await c.evaluate(`const B = window.__bench; return { taps: B.taps, saved: B.saved };`);
} while (B.saved.length < shots && Date.now() < deadline);
const res = await c.evaluate(`const B = window.__bench; B.stop = true; return { taps: B.taps, saved: B.saved, gaps: B.gaps.slice(3), wall: B.wall, long: B.long };`);
c.close();
const r0 = (a) => a.map((x) => Math.round(x));
const sorted = [...res.gaps].sort((a, b) => a - b);
const pct = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]);
console.log(`presses at (ms):      ${r0(res.taps).join(", ")}`);
console.log(`saved in app at (ms): ${r0(res.saved).join(", ")}  (${res.saved.length}/${shots})`);
console.log(`press -> saved (ms):  ${res.saved.map((s, i) => Math.round(s - (res.taps[i] ?? NaN))).join(", ")}`);
console.log(`viewfinder: ${res.gaps.length} frames, median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, worst ${Math.round(sorted.at(-1))} ms, >50ms ${res.gaps.filter((g) => g > 50).length}, >100ms ${res.gaps.filter((g) => g > 100).length}`);
console.log(`long tasks [start ms, duration ms]: ${res.long.map((l) => `[${l[0]},${l[1]}]`).join(" ")}`);
console.log(`WALL_START=${res.wall}`);
