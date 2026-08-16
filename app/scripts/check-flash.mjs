#!/usr/bin/env node
/**
 * Three flash modes, and the two ways "automatic" goes wrong.
 *
 * The platform gives us `torch` — a steady lamp — not a shutter-synced
 * flash, so all three modes are about WHEN that lamp is lit. Which means
 * automatic has a feedback loop in it: the meter reads a scene our own
 * light is illuminating, so a naive threshold switches off the instant it
 * starts working and back on the instant it stops. That is a strobe, and
 * it is the failure this guards against.
 *
 * The other failure is quieter: a phone that reports no exposure data at
 * all. Automatic must then do nothing rather than fire blindly, because
 * an "auto" flash that ignores the light is just "on" wearing a disguise.
 *
 *   node scripts/check-flash.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4561, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await page.goto("http://127.0.0.1:4561", { waitUntil: "load" });

  const r = await page.evaluate(async () => {
    const { readLight } = await import("/src/lib/lightmeter.ts");
    // a fake track whose getSettings() we control
    const track = (settings) => ({ getSettings: () => settings });
    const out = {};

    // --- ISO, the primary signal --------------------------------------
    out.isoBrightOff = readLight(track({ iso: 100 }), null, false).dark;
    out.isoDarkOn = readLight(track({ iso: 1600 }), null, false).dark;

    // --- the feedback loop --------------------------------------------
    // Once the lamp is lit, the meter is reading a scene WE are lighting.
    // The failure that produces is a strobe, and it has an exact
    // signature: some reading where the lamp is switched ON and, with it
    // on, the very next reading wants it OFF again. Sweep the whole range
    // and prove no such reading exists — every state is a fixed point.
    out.strobe = [];
    for (let iso = 25; iso <= 6400; iso += 25) {
      const wantsOn = readLight(track({ iso }), null, false).dark;
      const staysOn = readLight(track({ iso }), null, true).dark;
      if (wantsOn && !staysOn) out.strobe.push(iso);
    }
    // and the band between the two thresholds must HOLD its state rather
    // than picking one, which is what makes it hysteresis and not a
    // second threshold
    out.bandHoldsOff = readLight(track({ iso: 500 }), null, false).dark === false;
    out.bandHoldsOn = readLight(track({ iso: 500 }), null, true).dark === true;

    // walking into daylight must still turn it off
    out.daylight_lampOn = readLight(track({ iso: 80 }), null, true).dark;

    // --- exposure time, when ISO is absent ----------------------------
    out.expDark = readLight(track({ exposureTime: 1000 }), null, false); // 1/10 s in 100µs units
    out.expBright = readLight(track({ exposureTime: 20 }), null, false); // 1/500 s

    // --- nothing measurable -------------------------------------------
    out.blind = readLight(track({}), null, false);

    // --- the settings themselves --------------------------------------
    const { useSettingsStore } = await import("/src/store.ts");
    out.defaultMode = useSettingsStore.getState().settings.flashMode;
    return out;
  });

  check("off by default", r.defaultMode === "off", `flashMode: ${r.defaultMode}`);
  check("a bright scene does not ask for light", r.isoBrightOff === false, "ISO 100");
  check("a dark scene does", r.isoDarkOn === true, "ISO 1600");
  check(
    "no reading can make the lamp strobe",
    r.strobe.length === 0,
    r.strobe.length
      ? `oscillates at ISO ${r.strobe.slice(0, 5).join(", ")}`
      : "swept ISO 25-6400, every state is stable"
  );
  check(
    "between the thresholds the lamp holds its state",
    r.bandHoldsOff && r.bandHoldsOn,
    "ISO 500 stays off if off, stays on if on"
  );
  check(
    "walking into daylight turns it off",
    r.daylight_lampOn === false,
    "ISO 80 with the lamp lit"
  );
  check(
    "exposure time is used when ISO is not offered",
    r.expDark.dark === true &&
      r.expBright.dark === false &&
      r.expDark.source === "exposure",
    `${r.expDark.detail} vs ${r.expBright.detail}`
  );
  check(
    "a phone that reports nothing does not fire blindly",
    r.blind.dark === false && r.blind.source === "unknown",
    r.blind.detail
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
console.log("\nflash does what the mode says, and automatic can justify itself");
