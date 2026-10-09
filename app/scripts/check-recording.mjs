#!/usr/bin/env node
/**
 * A recording must survive being long, and survive the app dying.
 *
 * Motorola users reported long recordings ending with the app quitting or
 * freezing and the video gone. The cause was memory: every chunk was held
 * in memory until Stop, and finalising then read the whole file into
 * memory several more times — a ten-minute recording is about a gigabyte,
 * so finishing one asked for several. Nothing had reached storage, so a
 * killed WebView took the evidence with it.
 *
 * This records REAL MediaRecorder output (not synthetic boxes), then:
 *   - finalises it while instrumenting every read, and requires the
 *     largest single read to be a small fraction of the file;
 *   - plays the result and requires the right duration, a sample table,
 *     and the GPS atom;
 *   - cuts the raw recording off mid-fragment, as a crash leaves it, and
 *     requires the salvaged file to play up to the cut;
 *   - does the same for WebM where the browser offers it.
 *
 *   node scripts/check-recording.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4631, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await page.goto("http://127.0.0.1:4631", { waitUntil: "load" });

  const r = await page.evaluate(async () => {
    const { finalizeVideoBlob } = await import("/src/lib/video/postprocess.ts");

    // track the biggest single read anything does while finalising
    let maxRead = 0;
    const origAB = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      maxRead = Math.max(maxRead, this.size);
      return origAB.call(this);
    };
    const origFR = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (b) {
      maxRead = Math.max(maxRead, b.size);
      return origFR.call(this, b);
    };

    /** Record `seconds` of an animated canvas with real MediaRecorder. */
    const record = async (mime, seconds) => {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      const ctx = c.getContext("2d");
      let f = 0;
      const tick = setInterval(() => {
        f++;
        ctx.fillStyle = `hsl(${(f * 7) % 360},70%,45%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#fff";
        ctx.font = "48px sans-serif";
        ctx.fillText(`frame ${f}`, 40, 120);
        // noise so the encoder has real work and fragments are real size
        for (let i = 0; i < 400; i++) {
          ctx.fillStyle = `rgb(${(i * 37 + f) % 255},${(i * 91) % 255},${(f * 13) % 255})`;
          ctx.fillRect((i * 53 + f * 3) % 640, (i * 97) % 360, 12, 12);
        }
      }, 33);
      const stream = c.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((res) => (rec.onstop = res));
      rec.start(500);
      await new Promise((res) => setTimeout(res, seconds * 1000));
      rec.stop();
      await done;
      clearInterval(tick);
      return new Blob(chunks, { type: mime.split(";")[0] });
    };

    /** Load a blob in a <video> and report what a player sees. */
    const probe = async (blob) => {
      const v = document.createElement("video");
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      const meta = await Promise.race([
        new Promise((res) => (v.onloadedmetadata = () => res(true))),
        new Promise((res) => (v.onerror = () => res(false))),
        new Promise((res) => setTimeout(() => res(false), 8000)),
      ]);
      if (!meta) return { ok: false };
      const duration = v.duration;
      // seek near the end and require a decodable frame there
      let tailOk = false;
      if (Number.isFinite(duration) && duration > 1) {
        v.currentTime = Math.max(0, duration - 0.5);
        tailOk = await Promise.race([
          new Promise((res) => (v.onseeked = () => res(true))),
          new Promise((res) => setTimeout(() => res(false), 8000)),
        ]);
      }
      URL.revokeObjectURL(v.src);
      return { ok: true, duration, tailOk };
    };

    /** Top-level box types, read by headers only. */
    const topBoxes = async (blob) => {
      const { scanTopLevel } = await import("/src/lib/video/remux.ts");
      const s = await scanTopLevel(blob);
      return s ? s.boxes.map((b) => b.type) : null;
    };
    const hasBox = async (blob, fourcc) => {
      // search the (small) moov for a child type anywhere inside it
      const { scanTopLevel } = await import("/src/lib/video/remux.ts");
      const s = await scanTopLevel(blob);
      const moov = s?.boxes.find((b) => b.type === "moov");
      if (!moov?.bytes) return false;
      const b = moov.bytes;
      const want = [...fourcc].map((ch) => ch.charCodeAt(0));
      for (let i = 0; i < b.length - 4; i++) {
        if (b[i] === want[0] && b[i + 1] === want[1] && b[i + 2] === want[2] && b[i + 3] === want[3]) return true;
      }
      return false;
    };

    const out = {};
    const SECONDS = 6;
    const mp4 = ['video/mp4;codecs="avc1.42E01E"', "video/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
    out.mp4Supported = Boolean(mp4);
    if (mp4) {
      const raw = await record(mp4, SECONDS);
      out.rawSize = raw.size;
      out.rawBoxes = (await topBoxes(raw))?.filter((t, i, a) => a.indexOf(t) === i);
      maxRead = 0;
      const fin = await finalizeVideoBlob(raw, SECONDS * 1000, { lat: 12.929253, lng: 80.202487, accuracy: 8, timestamp: Date.now() });
      out.finMaxRead = maxRead;
      out.finSize = fin.size;
      out.finBoxes = await topBoxes(fin);
      out.finHasStsz = await hasBox(fin, "stsz");
      out.finHasXyz = await hasBox(fin, "\xa9xyz");
      out.finProbe = await probe(fin);

      // a crash mid-fragment: everything durably written up to 70% of the way
      const cut = raw.slice(0, Math.floor(raw.size * 0.7), raw.type);
      const salv = await finalizeVideoBlob(cut, SECONDS * 1000, null);
      out.salvBoxes = await topBoxes(salv);
      out.salvProbe = await probe(salv);
    }
    const webm = ["video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    out.webmSupported = Boolean(webm);
    if (webm) {
      const raw = await record(webm, 4);
      out.webmRawProbe = await probe(raw);
      maxRead = 0;
      const fin = await finalizeVideoBlob(raw, 4000, null);
      out.webmMaxRead = maxRead;
      out.webmSize = raw.size;
      out.webmProbe = await probe(fin);
    }
    return out;
  });

  if (!r.mp4Supported) {
    check("MP4 recording available to test", false, "this Chromium does not record MP4");
  } else {
    check(
      "MediaRecorder wrote fragmented MP4",
      r.rawBoxes?.includes("moof"),
      `boxes: ${r.rawBoxes?.join(" ")}`
    );
    check(
      "finalising never reads more than a sliver of the file",
      r.finMaxRead < r.rawSize * 0.25 && r.finMaxRead <= 1024 * 1024,
      `largest single read ${(r.finMaxRead / 1024).toFixed(0)} KB of a ${(r.rawSize / 1024).toFixed(0)} KB recording`
    );
    check(
      "the result is a progressive MP4 with sample tables",
      r.finBoxes?.join(" ") === "ftyp moov mdat" && r.finHasStsz,
      `boxes: ${r.finBoxes?.join(" ")}`
    );
    check("the GPS atom is written", r.finHasXyz);
    check(
      "it plays, at the right length, to the end",
      r.finProbe.ok && Math.abs(r.finProbe.duration - 6) < 1 && r.finProbe.tailOk,
      `duration ${r.finProbe.duration?.toFixed(2)} s, seek to end ${r.finProbe.tailOk}`
    );
    check(
      "a recording cut off mid-fragment is salvaged up to the cut",
      r.salvProbe.ok && r.salvProbe.duration > 2.5 && r.salvProbe.duration < 6 && r.salvProbe.tailOk,
      `boxes ${r.salvBoxes?.join(" ")}, duration ${r.salvProbe.duration?.toFixed(2)} s`
    );
  }
  if (r.webmSupported) {
    check(
      "WebM gets a real duration, read from the header alone",
      r.webmProbe.ok && Number.isFinite(r.webmProbe.duration) && Math.abs(r.webmProbe.duration - 4) < 1 &&
        r.webmMaxRead <= 1024 * 1024,
      `before: ${r.webmRawProbe.duration}, after: ${r.webmProbe.duration?.toFixed(2)} s, ` +
        `largest read ${(r.webmMaxRead / 1024).toFixed(0)} KB of ${(r.webmSize / 1024).toFixed(0)} KB`
    );
  }
  // ---- the real thing: kill the app mid-recording ---------------------
  // A reload is exactly what Android killing the WebView looks like to the
  // app: the page is gone mid-recording, Stop never runs. The video must
  // come back on the next launch.
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    geolocation: { latitude: 13.0405, longitude: 80.2337, accuracy: 8 },
    permissions: ["geolocation", "camera", "microphone"],
  });
  const app = await ctx.newPage();
  app.on("pageerror", (e) => errors.push(String(e)));
  await app.goto("http://127.0.0.1:4631/", { waitUntil: "load" });
  await app.waitForFunction(
    () => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0;
    },
    { timeout: 20000 }
  );
  const coach = app.locator("text=Got it").first();
  if (await coach.isVisible().catch(() => false)) await coach.click();
  await app.getByText("VIDEO", { exact: true }).click();
  await app.waitForTimeout(1500);
  await app.locator(".shutter").click();
  await app.waitForTimeout(6000);
  const idb = async (fn) =>
    app.evaluate(async (src) => {
      const open = indexedDB.open("chennai-gps-cam");
      const db = await new Promise((res, rej) => {
        open.onsuccess = () => res(open.result);
        open.onerror = rej;
      });
      const all = (store, keys) =>
        new Promise((res) => {
          const tx = db.transaction(store).objectStore(store);
          const r = keys ? tx.getAllKeys() : tx.getAll();
          r.onsuccess = () => res(r.result);
        });
      return new Function("all", `return (${src})(all)`)(all);
    }, fn.toString());
  const before = await idb(async (all) => {
    const keys = await all("blobs", true);
    const kv = await all("kv", true);
    return {
      chunks: keys.filter((k) => String(k).startsWith("rec:")).length,
      sessions: kv.filter((k) => String(k).startsWith("rec-session:")).length,
    };
  });
  check(
    "chunks reach storage while the recording is still running",
    before.chunks >= 4 && before.sessions === 1,
    `${before.chunks} chunks stored after 6 s, ${before.sessions} open session`
  );

  // kill it
  await app.reload({ waitUntil: "load" });
  let rescued = null;
  for (let i = 0; i < 60 && !rescued; i++) {
    await app.waitForTimeout(500);
    rescued = await idb(async (all) => {
      const media = await all("media");
      return media.find((m) => m.kind === "video" && m.recovered) ?? null;
    });
  }
  check(
    "the killed recording comes back on the next launch",
    Boolean(rescued),
    rescued ? `recovered ${rescued.duration?.toFixed(1)} s video, ${rescued.mimeType}` : "nothing recovered"
  );
  if (rescued) {
    const play = await app.evaluate(async (id) => {
      const open = indexedDB.open("chennai-gps-cam");
      const db = await new Promise((res) => (open.onsuccess = () => res(open.result)));
      const blob = await new Promise((res) => {
        const r = db.transaction("blobs").objectStore("blobs").get(`${id}/source`);
        r.onsuccess = () => res(r.result);
      });
      const v = document.createElement("video");
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      const meta = await Promise.race([
        new Promise((res) => (v.onloadedmetadata = () => res(true))),
        new Promise((res) => setTimeout(() => res(false), 8000)),
      ]);
      // metadata alone is not a video: an init segment with a patched
      // duration "loads" too. Require a decoded frame from the middle.
      let frame = false;
      if (meta && Number.isFinite(v.duration)) {
        v.currentTime = v.duration / 2;
        frame = await Promise.race([
          new Promise((res) => (v.onseeked = () => res(v.videoWidth > 0 && v.readyState >= 2))),
          new Promise((res) => setTimeout(() => res(false), 8000)),
        ]);
      }
      return { ok: meta && frame, duration: v.duration, size: blob?.size, w: v.videoWidth };
    }, rescued.id);
    check(
      "the recovered video plays at the length that was recorded",
      play.ok && play.duration > 3 && play.duration < 9 && play.size > 50_000,
      `frames decode: ${play.ok}, ${play.duration?.toFixed(2)} s, ${play.w}px wide, ${(play.size / 1024).toFixed(0)} KB`
    );
    const after = await idb(async (all) => {
      const keys = await all("blobs", true);
      const kv = await all("kv", true);
      return {
        chunks: keys.filter((k) => String(k).startsWith("rec:")).length,
        sessions: kv.filter((k) => String(k).startsWith("rec-session:")).length,
      };
    });
    check(
      "the stored chunks are cleared once it is safe",
      after.chunks === 0 && after.sessions === 0,
      `${after.chunks} chunks, ${after.sessions} sessions left`
    );
  }

  // and a normal stop still works, and leaves nothing behind
  await app.getByText("VIDEO", { exact: true }).click().catch(() => {});
  await app.waitForTimeout(1500);
  await app.locator(".shutter").click();
  await app.waitForTimeout(3000);
  await app.locator(".shutter").click();
  let normal = null;
  for (let i = 0; i < 40 && !normal; i++) {
    await app.waitForTimeout(500);
    normal = await idb(async (all) => {
      const media = await all("media");
      const vids = media.filter((m) => m.kind === "video" && !m.recovered);
      const keys = await all("blobs", true);
      return vids.length
        ? { vids: vids.length, chunks: keys.filter((k) => String(k).startsWith("rec:")).length }
        : null;
    });
  }
  check(
    "a normal stop saves the video and clears its chunks",
    normal && normal.vids === 1 && normal.chunks === 0,
    normal ? `${normal.vids} saved, ${normal.chunks} chunks left` : "nothing saved"
  );
  await ctx.close();
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
console.log("\nrecordings finish in bounded memory and survive being cut off");
