#!/usr/bin/env node
/**
 * The simple card is the default, and stays the default.
 *
 * It took two mechanisms to put everyone on the street sign: the default
 * preset, and a one-time migration that moved existing installs onto it
 * the first time a location resolved. Changing only the first would have
 * let the second keep doing it to every new install. So this checks the
 * whole path — fresh install, a location arriving, an install the old
 * migration moved, and someone who picks the sign deliberately.
 *
 *   node scripts/check-defaults.mjs
 */
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({
  server: { port: 4601, host: "127.0.0.1" },
  logLevel: "error",
});
await server.listen();
const browser = await chromium.launch();
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Fresh browser profile, optionally seeded, then hydrate and report. */
async function scenario({ storedPreset, chosen, oldMigrationRan }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:4601/", { waitUntil: "load" });
  return page.evaluate(
    async ({ storedPreset, chosen, oldMigrationRan }) => {
      // let the app's own startup hydration land first, or it can resolve
      // after this scenario and overwrite it — a race in the test, not in
      // the app, where hydration runs exactly once
      const store0 = await import("/src/store.ts");
      for (let i = 0; i < 100 && !store0.useSettingsStore.getState().hydrated; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 100));
      localStorage.clear();
      if (chosen) localStorage.setItem("gpscam-preset-chosen", "1");
      if (oldMigrationRan) localStorage.setItem("gpscam-street-sign-default", "1");
      const db = await import("/src/lib/db.ts");
      if (storedPreset) {
        const { DEFAULT_WATERMARK_CONFIG } = await import("/src/lib/watermark/presets.ts");
        await db.kvSet("watermark-config", { ...DEFAULT_WATERMARK_CONFIG, preset: storedPreset });
      } else {
        await db.kvSet("watermark-config", undefined);
      }
      const store = await import("/src/store.ts");
      await store.hydrateSettings();
      const afterHydrate = store.useSettingsStore.getState().watermark.preset;
      // the old migration fired on the first location lookup — make sure
      // nothing does anymore
      store.useLiveStore.getState().setLookupResult(
        { jurisdiction: { scope: "gcc", city: "Chennai" }, wardFeature: null, loFeature: null, nearestStation: null },
        { lat: 13.08, lng: 80.27 }
      );
      await new Promise((r) => setTimeout(r, 50));
      return { afterHydrate, afterLookup: store.useSettingsStore.getState().watermark.preset };
    },
    { storedPreset, chosen, oldMigrationRan }
  ).finally(() => ctx.close());
}

try {
  const fresh = await scenario({});
  check(
    "a fresh install starts on the simple card",
    fresh.afterHydrate === "detailed",
    `preset: ${fresh.afterHydrate}`
  );
  check(
    "a location arriving does not move it onto the street sign",
    fresh.afterLookup === "detailed",
    `after first lookup: ${fresh.afterLookup}`
  );

  const moved = await scenario({ storedPreset: "chennai", oldMigrationRan: true });
  check(
    "an install the old migration moved is put back",
    moved.afterLookup === "detailed",
    `was chennai, now ${moved.afterLookup}`
  );

  const deliberate = await scenario({ storedPreset: "chennai", chosen: true, oldMigrationRan: true });
  check(
    "someone who picked the street sign keeps it",
    deliberate.afterLookup === "chennai",
    `stays ${deliberate.afterLookup}`
  );

  const compact = await scenario({ storedPreset: "compact" });
  check(
    "other deliberate layouts are untouched",
    compact.afterLookup === "compact",
    `stays ${compact.afterLookup}`
  );
} finally {
  await browser.close();
  await server.close();
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nthe simple card is the default");
