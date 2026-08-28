#!/usr/bin/env node
/**
 * The blur has to be ON the face, not behind it.
 *
 * Detection runs a few times a second; the screen draws at sixty. Painting
 * the last detected boxes unchanged until the next result leaves the blur
 * showing where a face WAS — and on a privacy feature the lag is not a
 * cosmetic complaint, it is uncovered face, kept permanently in every
 * frame of a recording.
 *
 *   node scripts/check-blur.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4591, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await page.goto("http://127.0.0.1:4591", { waitUntil: "load" });

  const r = await page.evaluate(async () => {
    const { BoxTracker } = await import("/src/lib/detect/tracker.ts");
    const box = (x, y) => ({ x, y, width: 100, height: 120, score: 0.9 });

    // A face crossing the frame at 300 px/s, detected every 300 ms.
    const t = new BoxTracker();
    const SPEED = 0.3; // px per ms — a person walking across the frame
    const CADENCE = 150; // what the viewfinder actually runs at
    // The property that matters is COVERAGE: is the real face inside the
    // box we are painting? Not "is the box nearby". A box 20 px off a
    // 100 px face still leaves a strip of it visible in every frame.
    const covers = (b, truthX) =>
      b.x <= truthX && b.x + b.width >= truthX + 100 &&
      b.y <= 100 && b.y + b.height >= 220;
    let trackedMisses = 0;
    let heldMisses = 0;
    let samples = 0;
    for (let step = 0; step < 10; step++) {
      const at = step * CADENCE;
      t.update([box(SPEED * at, 100)], at);
      // sample right across the gap to the next detection, not just once
      for (const off of [30, 75, 120, 149]) {
        const now = at + off;
        const truth = SPEED * now;
        samples++;
        if (!covers(t.at(now)[0], truth)) trackedMisses++;
        // what holding the last detection unchanged would have done
        if (!covers(box(SPEED * at, 100), truth)) heldMisses++;
      }
    }

    // A face that stops must not keep sliding.
    const s = new BoxTracker();
    s.update([box(0, 0)], 0);
    s.update([box(60, 0)], 200);
    s.update([box(60, 0)], 400);
    s.update([box(60, 0)], 600);
    const stopped = s.at(700)[0];

    // A face that leaves must not leave a blur behind.
    const g = new BoxTracker();
    g.update([box(0, 0)], 0);
    const ghostSoon = g.at(300).length;
    const ghostLater = g.at(2000).length;

    // Two faces must not swap identities.
    const two = new BoxTracker();
    two.update([box(0, 0), box(500, 0)], 0);
    two.update([box(30, 0), box(530, 0)], 100);
    const pair = two.at(100).map((b) => Math.round(b.x)).sort((a, b) => a - b);

    return {
      trackedMisses,
      heldMisses,
      samples,
      stoppedX: Math.round(stopped.x),
      ghostSoon,
      ghostLater,
      pair,
    };
  });

  check(
    "a moving face stays covered between detections",
    r.trackedMisses === 0,
    `${r.samples - r.trackedMisses}/${r.samples} samples fully covered; ` +
      `holding the last detection covered ${r.samples - r.heldMisses}/${r.samples}`
  );
  check(
    "a face that stops does not slide out from under it",
    Math.abs(r.stoppedX - 60) <= 12,
    `settled at x=${r.stoppedX}, face at 60`
  );
  check(
    "a face that leaves takes its blur with it",
    r.ghostSoon === 1 && r.ghostLater === 0,
    `still covered at 300 ms (${r.ghostSoon}), gone by 2 s (${r.ghostLater})`
  );
  check(
    "two faces keep their own boxes",
    r.pair.length === 2 && r.pair[0] < 100 && r.pair[1] > 400,
    `boxes at ${r.pair.join(" and ")}`
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
console.log("\nthe blur stays on the face");
