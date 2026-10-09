#!/usr/bin/env node
/**
 * The phone camera (CameraX), on a real Android device or emulator.
 *
 * Photo mode runs on NativeCameraPlugin.java: the preview behind the
 * page, real zoom across the phone's lenses, tap-to-focus, zero-shutter-
 * lag stills. None of that exists in a desktop browser, so this check
 * drives the debug APK over adb and the WebView's DevTools socket.
 *
 *   npm run build && npx cap sync android
 *   (cd android && ./gradlew assembleDebug)
 *   adb install -r -g android/app/build/outputs/apk/debug/app-debug.apk
 *   adb shell am start -n city.reclaimchennai.cam/.MainActivity
 *   node scripts/check-native-camera.mjs [adb serial]
 *
 * An emulator works (KVM needed; on a server, run it in a container with
 * --device /dev/kvm and a memory cap — it wants ~5 GB). Two things make
 * it a fair test:
 *  - `-camera-back emulated`: the 3D "virtualscene" camera has no zoom;
 *  - an ULTRAWIDE, which emulators lack. Phones such as Motorola's list it
 *    as a second rear camera, and that is the case worth testing: with
 *    `-writable-system`, `adb root && adb remount`, copy
 *    /vendor/etc/config/emu_camera_back.json over emu_camera_front.json
 *    with a shorter focal length (1.9 for 3.3: about 0.6x) and a 2048x1536
 *    pixel array (the plugin ignores lenses under 3 MP), then restart
 *    cameraserver and vendor.camera-provider-2-7-google. The front camera
 *    is gone while that is in place; restore the original file after.
 *
 * Checks that need a lens the device does not have are skipped, and say so.
 */
import { execFileSync } from "node:child_process";

const serial = process.argv[2] ?? process.env.ANDROID_SERIAL;
const PKG = "city.reclaimchennai.cam";
const PORT = 9334;
const adb = (...args) =>
  execFileSync("adb", [...(serial ? ["-s", serial] : []), ...args], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const skip = (name, why) => console.log(`SKIP  ${name} — ${why}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = adb("shell", "pidof", PKG);
if (!pid) {
  console.error(`${PKG} is not running — install the debug APK and start it first`);
  process.exit(2);
}
adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
};
/** One DevTools call. A device that stops answering fails the check
 *  rather than hanging it. */
const send = (method, params, ms = 60_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer in ${ms / 1000} s — is the app still running?`));
    }, ms);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
/** Run an async function body in the page and return its value. */
const run = async (body) => {
  const res = await send("Runtime.evaluate", {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
  }
  return res.result?.result?.value;
};
/** A trusted two-finger pinch through the app's own gesture handling. */
const pinch = async (cx, cy, from, to, steps = 30) => {
  const pts = (d) => [
    { x: cx - d / 2, y: cy, id: 1 },
    { x: cx + d / 2, y: cy, id: 2 },
  ];
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pts(from)[0]] });
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    await sleep(16);
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: pts(from + ((to - from) * i) / steps),
    });
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

const STATE = `
  const box = document.querySelector(".cam-video-box");
  const chips = [...document.querySelectorAll(".cam-zoomrow button")];
  return {
    engine: box?.dataset.engine,
    live: box?.dataset.live,
    chips: chips.map((b) => b.textContent),
    active: chips.find((b) => b.dataset.active === "true")?.textContent ?? null,
  };`;
const MEDIA = `
  const listMedia = () => new Promise((res) => {
    const rq = indexedDB.open("chennai-gps-cam");
    rq.onsuccess = () => {
      const all = rq.result.transaction("media").objectStore("media").getAll();
      all.onsuccess = () => { res(all.result); rq.result.close(); };
    };
  });`;
const shoot = async (count = 1, gapMs = 80) => {
  const before = await run(`${MEDIA} return (await listMedia()).length;`);
  await run(`
    for (let i = 0; i < ${count}; i++) {
      document.querySelector('button[aria-label="Take photo"]').click();
      await new Promise((r) => setTimeout(r, ${gapMs}));
    }`);
  // watermarking and saving run behind the shutter; give them time
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await run(`${MEDIA} return (await listMedia()).length;`);
    if (n - before >= count) return n - before;
  }
  return (await run(`${MEDIA} return (await listMedia()).length;`)) - before;
};
const watchZoom = () =>
  run(`
    window.__zooms = [];
    window.__zoomOff = await window.Capacitor.Plugins.NativeCamera.addListener(
      "zoom", (d) => window.__zooms.push(d.zoom));
    return true;`);
const zooms = () =>
  run(`await window.__zoomOff?.remove(); return window.__zooms ?? [];`);
/** Cameras held right now — from the service's live client list. Its
 *  per-device "is open" lines include a cached dump of the LAST client,
 *  which reads as open after the camera has been released. */
const openCamera = () => {
  const dump = adb("shell", "dumpsys", "media.camera");
  const live = dump.split("Active Camera Clients:")[1]?.split("]")[0] ?? "";
  return [...live.matchAll(/Camera ID: (\S+?),/g)].map((m) => m[1]).join(",");
};

// ---- the phone camera runs photo mode --------------------------------
// a cold device can take a while to get the app to its viewfinder
for (let i = 0; i < 60; i++) {
  const live = await run(`return document.querySelector(".cam-video-box")?.dataset.live === "true";`);
  if (live) break;
  await sleep(1000);
}
let s = await run(STATE);
check("photo mode runs on the phone camera", s.engine === "native", `engine ${s.engine}`);
check("its preview is live", s.live === "true");
const box = await run(`return document.querySelector(".cam-video-box").getBoundingClientRect().toJSON();`);
const cx = box.x + box.width / 2;
const cy = box.y + box.height * 0.4;

// ---- zoom --------------------------------------------------------------
const wideChip = s.chips.find((c) => c.startsWith("."));
if (s.chips.length < 2) {
  skip("pinch zoom", "this camera reports no zoom range");
} else {
  await watchZoom();
  await pinch(cx, cy, 80, 160);
  await sleep(1500);
  const z = await zooms();
  check(
    "a pinch zooms continuously",
    z.length >= 10 && Math.abs(z.at(-1) / z[0] - 2) < 0.4,
    `${z.length} steps, ${z[0]?.toFixed(2)} → ${z.at(-1)?.toFixed(2)}`
  );
}

// ---- the wide lens -----------------------------------------------------
if (!wideChip) {
  skip("ultrawide", "no lens wider than 1x on this camera");
} else {
  const mainOpen = openCamera();
  await run(`[...document.querySelectorAll(".cam-zoomrow button")].find((b) => b.textContent.startsWith(".")).click();`);
  await sleep(3000);
  s = await run(STATE);
  check("the wide chip reaches the ultrawide", s.active === wideChip, `active ${s.active}`);
  const wideOpen = openCamera();
  const switched = wideOpen !== mainOpen;
  console.log(`      camera ${mainOpen} → ${wideOpen} (${switched ? "separate ultrawide camera" : "zoom inside one camera"})`);

  await watchZoom();
  await pinch(cx, cy, 100, 131);
  await sleep(1500);
  let z = await zooms();
  const mid = z.at(-1);
  check("0.8x sits between the ultrawide and 1x", mid > 0.7 && mid < 0.9, `${mid?.toFixed(2)}x`);

  check("a photo on the ultrawide saves", (await shoot()) === 1);

  await watchZoom();
  await pinch(cx, cy, 60, 200, 40);
  await sleep(2500);
  z = await zooms();
  s = await run(STATE);
  check(
    "pinching out crosses back to the main camera",
    z.at(-1) > 1.5 && (!switched || openCamera() === mainOpen),
    `ends at ${z.at(-1)?.toFixed(2)}x on camera ${openCamera()}`
  );
}

// ---- focus -------------------------------------------------------------
adb("logcat", "-c");
await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 60, y: cy, id: 1 }] });
await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
await sleep(1200);
const focusCalls = adb("logcat", "-d").split("\n").filter((l) => /methodName: focus\b/.test(l));
check("a tap focuses the phone camera there", focusCalls.length >= 1);
const locked = await run(`
  document.querySelector('button[aria-label="Lock focus"]')?.click();
  await new Promise((r) => setTimeout(r, 2000));
  return !!document.querySelector('button[aria-label="Unlock focus"]');`);
check("focus and exposure lock", locked);
await run(`document.querySelector('button[aria-label="Unlock focus"]')?.click();`);

// ---- the shutter ---------------------------------------------------------
check("a burst of five keeps all five", (await shoot(5)) === 5);
const kept = await run(`
  ${MEDIA}
  const before = (await listMedia()).length;
  document.querySelector('button[aria-label="Take photo"]').click();
  await new Promise((r) => setTimeout(r, 30));
  [...document.querySelectorAll(".cam-mode button")].find((b) => b.textContent.trim() === "VIDEO").click();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await listMedia()).length > before) break;
  }
  return (await listMedia()).length - before;`);
check("a photo taken as video mode opens is still saved", kept === 1);
await sleep(3000);
s = await run(STATE);
check("video mode runs on the web camera", s.engine === "web", `engine ${s.engine}`);
if (wideChip) {
  // the phone camera's lens table, used by the web camera: no probing
  const before = openCamera();
  await run(`[...document.querySelectorAll(".cam-zoomrow button")].find((b) => b.textContent.startsWith(".")).click();`);
  await sleep(5000);
  const label = await run(`return document.querySelector("video")?.srcObject?.getVideoTracks?.()[0]?.label ?? "";`);
  check(
    "video mode reaches the ultrawide too",
    s.chips.includes(wideChip) && openCamera() !== before,
    `${label}, camera ${before} → ${openCamera()}`
  );
  await run(`[...document.querySelectorAll(".cam-zoomrow button")].find((b) => b.textContent === "1×").click();`);
  await sleep(4000);
}
await run(`[...document.querySelectorAll(".cam-mode button")].find((b) => b.textContent.trim() === "PHOTO").click();`);
await sleep(5000);
s = await run(STATE);
check("back in photo mode, the phone camera again", s.engine === "native" && s.live === "true");

// ---- leaving and coming back ------------------------------------------------
await run(`[...document.querySelectorAll(".cam-zoomrow button")].find((b) => b.textContent === "2×")?.click();`);
await sleep(1500);
adb("shell", "input", "keyevent", "KEYCODE_HOME");
await sleep(3000);
check("the camera is released in the background", openCamera() === "", `open: ${openCamera() || "none"}`);
adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
await sleep(6000);
s = await run(STATE);
check(
  "it comes back on the phone camera, zoom kept",
  s.engine === "native" && s.live === "true" && (!s.chips.includes("2×") || s.active === "2×"),
  `engine ${s.engine}, active ${s.active}`
);

ws.close();
console.log(failures ? `\n${failures} failed` : "\nthe phone camera does what the stock camera does");
process.exit(failures ? 1 : 0);
