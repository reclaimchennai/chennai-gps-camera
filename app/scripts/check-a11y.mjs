#!/usr/bin/env node
/**
 * The selection band and the destructive confirmation, checked as a user
 * meets them: rendered, in both themes.
 *
 * Restyling is exactly when accessibility quietly breaks — a new token
 * that looks fine on the designer's screen, an icon-only button that
 * loses its label, a dialog that opens behind the thing that summoned it.
 * So this measures the built page rather than the stylesheet:
 *
 *   - contrast of every control's text against what is actually painted
 *     behind it, composited through translucent fills (WCAG AA);
 *   - touch targets against the 44px floor (WCAG 2.2 target size);
 *   - the destructive action distinguishable WITHOUT colour, since a
 *     red-green colourblind user receives none of that signal;
 *   - dialog semantics and where focus goes when one opens;
 *   - the selection jiggle stopping under prefers-reduced-motion.
 *
 *   node scripts/check-a11y.mjs
 */
import { chromium } from "playwright";
import { preview } from "vite";

const server = await preview({ preview: { port: 4551, host: "127.0.0.1" } });
const base = "http://127.0.0.1:4551";
const GEO = { latitude: 13.0405, longitude: 80.2337, accuracy: 8 };

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
});

/** Walk up the ancestors compositing backgrounds until one is opaque. */
const PROBE = `
  (() => {
    const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const parse = (s) => {
      const m = /rgba?\\(([^)]+)\\)/.exec(s || "");
      if (!m) return null;
      const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(Number);
      return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    window.__bgOf = (el) => {
      let bg = [255, 255, 255];
      const chain = [];
      for (let n = el; n; n = n.parentElement) chain.push(n);
      // paint from the root down so translucent layers stack correctly
      for (const n of chain.reverse()) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) bg = over(c.rgb, c.a, bg);
      }
      return bg;
    };
    window.__contrast = (el) => {
      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg) return null;
      const bg = window.__bgOf(el);
      const ink = fg.a >= 1 ? fg.rgb : over(fg.rgb, fg.a, bg);
      const a = lum(ink), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const px = parseFloat(cs.fontSize);
      const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
      // WCAG "large text": 18.66px bold or 24px regular
      const large = px >= 24 || (bold && px >= 18.66);
      return { ratio, px, large, need: large ? 3 : 4.5 };
    };
  })()
`;

async function run(theme) {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    geolocation: GEO,
    permissions: ["geolocation", "camera"],
    deviceScaleFactor: 2,
    colorScheme: theme,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(
    () => { const v = document.querySelector("video"); return v && v.videoWidth > 0; },
    { timeout: 20000 }
  );
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
  }, theme);

  // two captures, so a selection of more than one is possible
  const coach = page.locator("text=Got it").first();
  if (await coach.isVisible().catch(() => false)) await coach.click();
  for (let i = 0; i < 2; i++) {
    await page.locator("button.shutter").click();
    await page.waitForTimeout(1400);
  }
  await page.goto(`${base}/#/gallery`, { waitUntil: "load" });
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-theme", t);
  }, theme);
  await page.waitForSelector(".gallery-cell", { timeout: 15000 });

  // long-press the first cell to arm selection, then add the second
  const cell = page.locator(".gallery-cell").first();
  const box = await cell.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForSelector(".sel-bar", { timeout: 5000 });
  const second = page.locator(".gallery-cell").nth(1);
  if (await second.isVisible().catch(() => false)) await second.click();

  await page.evaluate(PROBE);

  // ---- band: contrast + target size --------------------------------
  const band = await page.evaluate(() => {
    const out = [];
    for (const b of document.querySelectorAll(".sel-bar .pill-action")) {
      const r = b.getBoundingClientRect();
      const label = b.querySelector("span")?.textContent?.trim() ?? "";
      const c = window.__contrast(b.querySelector("span") ?? b);
      out.push({
        label,
        w: Math.round(r.width),
        h: Math.round(r.height),
        ratio: c?.ratio ?? 0,
        need: c?.need ?? 4.5,
        hasIcon: !!b.querySelector("svg"),
        hasText: label.length > 0,
      });
    }
    return out;
  });

  check(
    `[${theme}] band labels clear WCAG AA`,
    band.length > 0 && band.every((b) => b.ratio >= b.need),
    band.map((b) => `${b.label} ${b.ratio.toFixed(2)}:1`).join(", ")
  );
  check(
    `[${theme}] band targets are at least 44px`,
    band.every((b) => b.h >= 44 && b.w >= 44),
    band.map((b) => `${b.label} ${b.w}x${b.h}`).join(", ")
  );
  check(
    `[${theme}] every action names itself in text, not just an icon`,
    band.every((b) => b.hasText && b.hasIcon)
  );

  // ---- destructive: distinguishable without colour ------------------
  const danger = await page.evaluate(() => {
    const d = document.querySelector(".sel-bar .pill-action.danger");
    const peer = document.querySelector(".sel-bar .pill-action:not(.danger)");
    if (!d || !peer) return null;
    const ds = getComputedStyle(d);
    const ps = getComputedStyle(peer);
    return {
      // a fill the peers do not have
      fillDiffers: ds.backgroundColor !== ps.backgroundColor,
      // a separating rule drawn as a pseudo-element
      hasRule:
        getComputedStyle(d, "::before").content !== "none" &&
        parseFloat(getComputedStyle(d, "::before").width) > 0,
      spaced: parseFloat(ds.marginLeft) > 0,
      label: d.textContent.trim(),
    };
  });
  check(
    `[${theme}] delete is marked out by more than colour`,
    danger && (danger.fillDiffers || danger.hasRule) && danger.spaced,
    danger
      ? `fill ${danger.fillDiffers}, rule ${danger.hasRule}, gap ${danger.spaced}`
      : "not found"
  );

  // ---- the confirmation ---------------------------------------------
  await page.locator(".sel-bar .pill-action.danger").click();
  await page.waitForSelector(".modal-destructive", { timeout: 5000 });
  await page.evaluate(PROBE);

  const dialog = await page.evaluate(() => {
    const d = document.querySelector(".modal-destructive");
    const btn = d.querySelector(".destructive-btn");
    const cancel = d.querySelector(".ghost-btn");
    const rect = (e) => {
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const labelledBy = d.getAttribute("aria-labelledby");
    const describedBy = d.getAttribute("aria-describedby");
    return {
      role: d.getAttribute("role"),
      modal: d.getAttribute("aria-modal"),
      titleFound: !!(labelledBy && document.getElementById(labelledBy)),
      bodyFound: !!(describedBy && document.getElementById(describedBy)),
      focusInside: d.contains(document.activeElement),
      focusLabel: document.activeElement?.textContent?.trim() ?? "",
      confirmText: btn?.textContent?.trim() ?? "",
      confirm: rect(btn),
      cancel: rect(cancel),
      confirmContrast: window.__contrast(btn.querySelector("span") ?? btn),
      cancelContrast: window.__contrast(cancel),
      bodyContrast: window.__contrast(document.getElementById(describedBy)),
      bodyText: document.getElementById(describedBy)?.textContent ?? "",
    };
  });

  check(
    `[${theme}] confirmation announces itself as a dialog`,
    dialog.role === "alertdialog" &&
      dialog.modal === "true" &&
      dialog.titleFound &&
      dialog.bodyFound,
    `role=${dialog.role} modal=${dialog.modal} title=${dialog.titleFound} body=${dialog.bodyFound}`
  );
  check(
    `[${theme}] focus moves into the dialog, onto the SAFE option`,
    dialog.focusInside && /cancel/i.test(dialog.focusLabel),
    `focus on "${dialog.focusLabel}"`
  );
  check(
    `[${theme}] the confirming button says what it does`,
    /remove|delete/i.test(dialog.confirmText) && /\d/.test(dialog.confirmText),
    `"${dialog.confirmText}"`
  );
  check(
    `[${theme}] dialog text clears WCAG AA`,
    [dialog.confirmContrast, dialog.cancelContrast, dialog.bodyContrast].every(
      (c) => c && c.ratio >= c.need
    ),
    `confirm ${dialog.confirmContrast?.ratio.toFixed(2)}, cancel ${dialog.cancelContrast?.ratio.toFixed(2)}, body ${dialog.bodyContrast?.ratio.toFixed(2)}`
  );
  check(
    `[${theme}] dialog targets are at least 44px`,
    dialog.confirm.h >= 44 && dialog.cancel.h >= 44,
    `confirm ${dialog.confirm.w}x${dialog.confirm.h}, cancel ${dialog.cancel.w}x${dialog.cancel.h}`
  );
  // The old copy claimed the photo was gone from the device. It is not:
  // deleteMedia() drops this app's record and leaves the gallery file.
  check(
    `[${theme}] the dialog does not overstate what is deleted`,
    /gallery/i.test(dialog.bodyText) && !/permanently from this device/i.test(dialog.bodyText),
    dialog.bodyText.replace(/\s+/g, " ").trim().slice(0, 90) + "…"
  );

  // Escape must dismiss a destructive prompt — a keyboard user who cannot
  // reach Cancel is otherwise trapped in front of it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(
    `[${theme}] Escape dismisses it`,
    (await page.locator(".modal-destructive").count()) === 0
  );

  await context.close();
  return errors;
}

const allErrors = [];
try {
  for (const theme of ["dark", "light"]) {
    allErrors.push(...(await run(theme)));
  }

  // ---- reduced motion ------------------------------------------------
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 },
    reducedMotion: "reduce",
    geolocation: GEO,
    permissions: ["geolocation", "camera"],
  });
  const p2 = await ctx.newPage();
  await p2.goto(base, { waitUntil: "load" });
  const still = await p2.evaluate(() => {
    const el = document.createElement("div");
    el.className = "gallery-cell jiggle";
    document.body.appendChild(el);
    const name = getComputedStyle(el).animationName;
    el.remove();
    return name;
  });
  check(
    "the selection jiggle stops under prefers-reduced-motion",
    still === "none" || still === "",
    `animation-name: ${still || "(none)"}`
  );
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}

if (allErrors.length) {
  console.log(`\npage errors:\n  ${allErrors.join("\n  ")}`);
  failures += allErrors.length;
}
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nselection band and delete confirmation are usable by everyone");
