/**
 * The Chennai street-sign header — drawn, not bundled.
 *
 * Greater Chennai Corporation's street name boards are a strong local
 * signal: a dark blue board, white keyline, Tamil name stacked over the
 * English one. A complaint photo carrying that shape reads as "Chennai"
 * before anyone reads a word of it, which is the whole point of making it
 * the default here.
 *
 * It is RECREATED in canvas rather than shipped as artwork. Nothing is
 * copied, it stays sharp from a 360 px preview to a 4000 px photo, it
 * costs no download, and — the practical reason — a bundled emblem we
 * could not verify would be very hard to walk back once installed on
 * every Chennai user's phone.
 *
 * The board is a folder tab: rounded on top, square where it meets the
 * card, so the two read as one filed document.
 */
import type { WatermarkData } from "../../types";

import {
  LANGS,
  SAMPLES,
  langOf as registryLangOf,
  type CardLang,
  type CardStrings,
} from "../i18n/languages";

export type WatermarkLang = CardLang;
export type { CardStrings };

/**
 * Every config stored before card languages existed has no `language`
 * field, and photos re-composited from those records replay them verbatim
 * without the store's default-merge. Anything unrecognised resolves to
 * English rather than throwing on a missing string table.
 */
export const langOf = registryLangOf;

export function fontFor(lang: unknown): string {
  return LANGS[registryLangOf(lang)].font;
}

/**
 * Can this device actually draw this script?
 *
 * A missing Indic font does not throw — it draws tofu boxes, so a card
 * that "rendered fine" in CI can be unreadable on a user's phone.
 *
 * This compares PIXELS, not widths. The first attempt measured the sample
 * against a run of Private Use Area characters and called them equal-width
 * = unsupported; probing it showed "Chennai" in plain Latin landing within
 * 2% of its tofu run, which that rule would have declared unsupported. Two
 * different strings landing on a similar width is a coincidence; landing
 * on the same PIXELS is not. Tofu is one rectangle repeated, so if the
 * sample rasterises identically to a guaranteed-notdef run, the glyphs are
 * genuinely missing and the caller falls back to English instead of
 * stamping boxes into somebody's photo.
 */
const scriptCache = new Map<string, boolean>();

/** Drop cached probe results — call once webfonts finish loading, or a
 *  probe that ran before the Tamil face arrived stays "unavailable" for
 *  the whole session. */
export function resetScriptCache(): void {
  scriptCache.clear();
}
export function scriptAvailable(
  // kept for call-site symmetry with stringsFor(); the probe rasterises on
  // its own offscreen canvas so it can read pixels back without disturbing
  // the caller's context mid-render
  _ctx: CanvasRenderingContext2D,
  langIn: unknown
): boolean {
  const lang = langOf(langIn);
  if (lang === "en") return true;
  const hit = scriptCache.get(lang);
  if (hit !== undefined) return hit;

  const sample = SAMPLES[lang] ?? "\u091a\u0947\u0928\u094d\u0928\u0908";
  const ok = (() => {
    try {
      const W = 220;
      const H = 56;
      const ink = (text: string): Uint8ClampedArray | null => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return null;
        g.fillStyle = "#000";
        g.fillRect(0, 0, W, H);
        g.fillStyle = "#fff";
        g.font = `36px ${fontFor(lang)}`;
        g.textBaseline = "middle";
        g.fillText(text, 4, H / 2);
        return g.getImageData(0, 0, W, H).data;
      };
      const real = ink(sample);
      const tofu = ink("\uE000".repeat(sample.length));
      if (!real || !tofu) return true; // can't tell — don't disable the script
      let diff = 0;
      let drawn = 0;
      for (let i = 0; i < real.length; i += 4) {
        if (real[i] > 40) drawn++;
        if (Math.abs(real[i] - tofu[i]) > 40) diff++;
      }
      // needs actual ink, and a shape that isn't the notdef box run
      return drawn > 20 && diff > real.length / 4 / 200;
    } catch {
      return true; // no DOM/canvas (SSR, worker) — assume the font is there
    }
  })();
  scriptCache.set(lang, ok);
  return ok;
}

/** Labels for `lang`, falling back to English when the script cannot draw. */
export function stringsFor(
  ctx: CanvasRenderingContext2D,
  langIn: unknown
): CardStrings {
  const lang = registryLangOf(langIn);
  return LANGS[scriptAvailable(ctx, lang) ? lang : "en"].strings;
}

/** Is this jurisdiction Greater Chennai Corporation? */
export function isChennaiJurisdiction(
  j: { scope?: string; corporation?: string } | null | undefined
): boolean {
  if (!j) return false;
  if (j.scope === "gcc") return true;
  return /greater chennai/i.test(j.corporation ?? "");
}

/** Is this capture inside Greater Chennai Corporation? */
export function isChennai(data: WatermarkData): boolean {
  return isChennaiJurisdiction(data.jurisdiction);
}

