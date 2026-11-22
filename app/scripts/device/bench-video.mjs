#!/usr/bin/env node
/**
 * On-device video check: photo -> video switch, a recording of N seconds,
 * stop, and the clip filed in the app. Writes a frame from the middle of
 * the saved clip to FRAME_OUT (JPEG) so the burned-in card can be seen.
 *
 *   CDP_PORT=9333 FRAME_OUT=/tmp/f.jpg node scripts/device/bench-video.mjs [seconds=5]
 */
import { connect } from "./cdp.mjs";
import { writeFileSync } from "node:fs";

const secs = Number(process.argv[2] || 5);
const c = await connect();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (sel) => c.evaluate(`
  const el = [...document.querySelectorAll("button")].find((b) => ${sel});
  if (!el) return null; const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
const count = () => c.evaluate(`
  const db = await new Promise((r, j) => { const q = indexedDB.open("chennai-gps-cam"); q.onsuccess = () => r(q.result); q.onerror = j; });
  const all = await new Promise((r) => { const q = db.transaction("media").objectStore("media").getAll(); q.onsuccess = () => r(q.result); });
  db.close(); return all.length;`);

// frame gaps + long tasks over the whole run
await c.evaluate(`
  const B = window.__vb = { t0: performance.now(), gaps: [], long: [], stop: false };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) B.long.push([Math.round(e.startTime - B.t0), Math.round(e.duration)]); }).observe({ type: "longtask" }); } catch {}
  let last = performance.now();
  const loop = (t) => { B.gaps.push([Math.round(t - B.t0), t - last]); last = t; if (!B.stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop); return 1;`);
const base = await count();
const toVideo = await center(`/^video$/i.test(b.textContent.trim())`);
const t0 = Date.now();
await c.tap(toVideo.x, toVideo.y);
// wait for the record button
let rec = null;
for (let i = 0; i < 50 && !rec; i++) { await sleep(100); rec = await center(`b.getAttribute("aria-label") === "Record"`); }
await sleep(1500);
console.log(`switched to video (record button after ${Date.now() - t0} ms)`);
await c.tap(rec.x, rec.y);
const recAt = Date.now();
await sleep(secs * 1000);
const stopBtn = await center(`/stop|record/i.test(b.getAttribute("aria-label") || "")`);
await c.tap(stopBtn.x, stopBtn.y);
const stopAt = Date.now();
let n = base;
while (n === base && Date.now() - stopAt < 30000) { await sleep(200); n = await count(); }
console.log(`recorded ${Math.round((stopAt - recAt) / 1000)} s; filed in the app ${Date.now() - stopAt} ms after stop (${n - base} new)`);
const v = await c.evaluate(`
  const db = await new Promise((r, j) => { const q = indexedDB.open("chennai-gps-cam"); q.onsuccess = () => r(q.result); q.onerror = j; });
  const all = await new Promise((r) => { const q = db.transaction("media").objectStore("media").getAll(); q.onsuccess = () => r(q.result); });
  const m = all.sort((a, b) => b.createdAt - a.createdAt)[0];
  const blob = await new Promise((r) => { const q = db.transaction("blobs").objectStore("blobs").get(m.id + "/source"); q.onsuccess = () => r(q.result); });
  db.close();
  if (!blob) return { kind: m.kind, err: "no source blob", keys: Object.keys(m) };
  const el = document.createElement("video"); el.muted = true; el.src = URL.createObjectURL(blob);
  await new Promise((r) => { el.onloadedmetadata = r; el.onerror = r; });
  el.currentTime = Math.min(el.duration / 2, 2.5);
  await new Promise((r) => { el.onseeked = r; setTimeout(r, 3000); });
  const cv = document.createElement("canvas"); cv.width = el.videoWidth; cv.height = el.videoHeight;
  cv.getContext("2d").drawImage(el, 0, 0);
  const jpeg = cv.toDataURL("image/jpeg", 0.8);
  // audio present?
  let audio = null; try { audio = el.mozHasAudio ?? (el.webkitAudioDecodedByteCount ?? null); } catch {}
  return { kind: m.kind, w: el.videoWidth, h: el.videoHeight, dur: el.duration, size: blob.size, type: blob.type, rec: { w: m.width, h: m.height, duration: m.duration, burned: m.watermarkBurned }, jpeg };`);
const res = await c.evaluate(`const B = window.__vb; B.stop = true; return { gaps: B.gaps, long: B.long };`);
c.close();
if (v.jpeg && process.env.FRAME_OUT) writeFileSync(process.env.FRAME_OUT, Buffer.from(v.jpeg.split(",")[1], "base64"));
delete v.jpeg;
console.log(JSON.stringify(v));
const g = res.gaps.map((x) => x[1]).slice(3).sort((a, b) => a - b);
console.log(`frames ${g.length}: median ${Math.round(g[g.length >> 1])} ms, worst ${Math.round(g.at(-1))} ms, >50ms ${g.filter((x) => x > 50).length}, >100ms ${g.filter((x) => x > 100).length}`);
console.log(`long tasks: ${res.long.map((l) => `[${l[0]},${l[1]}]`).join(" ")}`);
