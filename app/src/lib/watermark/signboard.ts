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

export type WatermarkLang = "en" | "ta" | "hi";

/** GCC street-board palette. */
const SIGN_BG = "#123a6d";
const SIGN_LINE = "rgba(255,255,255,0.92)";
const SIGN_TEXT = "#ffffff";

const LATIN =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
/** Tamil/Devanagari need their own stacks — the Latin one silently tofus. */
const TAMIL = `'Noto Sans Tamil', 'Latha', 'Tamil Sangam MN', ${LATIN}`;
const DEVA = `'Noto Sans Devanagari', 'Nirmala UI', 'Kohinoor Devanagari', ${LATIN}`;

/**
 * Every config stored before this release has NO `language` field, and
 * photos re-composited from those records replay them verbatim. Anything
 * unrecognised — undefined included — resolves to English, so an old card
 * renders exactly as it always did instead of throwing on a missing
 * string table.
 */
export function langOf(lang: unknown): WatermarkLang {
  return lang === "ta" || lang === "hi" ? lang : "en";
}

export function fontFor(lang: unknown): string {
  const l = langOf(lang);
  return l === "ta" ? TAMIL : l === "hi" ? DEVA : LATIN;
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

  const sample = lang === "ta" ? "\u0b9a\u0bc6\u0ba9\u0bcd\u0ba9\u0bc8" : "\u091a\u0947\u0928\u094d\u0928\u0908";
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

/** Board wording per language. `authority` is the routing line. */
interface SignStrings {
  authority: string;
  complaint: string;
}
const SIGN: Record<WatermarkLang, SignStrings> = {
  en: {
    authority: "Greater Chennai Corporation",
    complaint: "Civic report",
  },
  ta: {
    authority: "பெருநகர சென்னை மாநகராட்சி",
    complaint: "குடிமைப் புகார்",
  },
  hi: {
    authority: "बृहत् चेन्नई नगर निगम",
    complaint: "नागरिक शिकायत",
  },
};

/** Card field labels, so the whole card follows the chosen language. */
export interface CardStrings {
  digipin: string;
  ward: string;
  zone: string;
  block: string;
  district: string;
  policeBoth: string;
  policeLo: string;
  traffic: string;
  noise: string;
  avg: string;
  min: string;
  max: string;
  facing: string;
  acquiring: string;
  wardPending: string;
  mock: string;
}

const STRINGS: Record<WatermarkLang, CardStrings> = {
  en: {
    digipin: "DIGIPIN",
    ward: "Ward",
    zone: "Zone",
    block: "Block",
    district: "District",
    policeBoth: "Police (L&O & Traffic)",
    policeLo: "Police (L&O)",
    traffic: "Traffic",
    noise: "Noise",
    avg: "Avg",
    min: "Min",
    max: "Max",
    facing: "Facing",
    acquiring: "GPS: acquiring…",
    wardPending: "Ward: not yet available",
    mock: "⚠ Mock location — GPS may be spoofed",
  },
  ta: {
    digipin: "டிஜிபின்",
    ward: "வார்டு",
    zone: "மண்டலம்",
    block: "ஒன்றியம்",
    district: "மாவட்டம்",
    policeBoth: "காவல் (சட்டம் & போக்குவரத்து)",
    policeLo: "காவல் நிலையம்",
    traffic: "போக்குவரத்து",
    noise: "ஒலி அளவு",
    avg: "சராசரி",
    min: "குறைந்தது",
    max: "அதிகபட்சம்",
    facing: "திசை",
    acquiring: "GPS: பெறப்படுகிறது…",
    wardPending: "வார்டு: இன்னும் கிடைக்கவில்லை",
    mock: "⚠ போலி இருப்பிடம் — GPS தவறாக இருக்கலாம்",
  },
  hi: {
    digipin: "डिजिपिन",
    ward: "वार्ड",
    zone: "क्षेत्र",
    block: "प्रखंड",
    district: "जिला",
    policeBoth: "पुलिस (कानून व यातायात)",
    policeLo: "पुलिस थाना",
    traffic: "यातायात",
    noise: "ध्वनि स्तर",
    avg: "औसत",
    min: "न्यूनतम",
    max: "अधिकतम",
    facing: "दिशा",
    acquiring: "GPS: प्राप्त किया जा रहा है…",
    wardPending: "वार्ड: अभी उपलब्ध नहीं",
    mock: "⚠ नकली स्थान — GPS गलत हो सकता है",
  },
};

/** Labels for `lang`, falling back to English when the script can't draw. */
export function stringsFor(
  ctx: CanvasRenderingContext2D,
  langIn: unknown
): CardStrings {
  const lang = langOf(langIn);
  return STRINGS[scriptAvailable(ctx, lang) ? lang : "en"];
}

/** Is this capture inside Greater Chennai Corporation? */
export function isChennai(data: WatermarkData): boolean {
  const j = data.jurisdiction;
  if (!j) return false;
  if (j.scope === "gcc") return true;
  return /greater chennai/i.test(j.corporation ?? "");
}

export { SIGN, SIGN_BG, SIGN_LINE, SIGN_TEXT, LATIN, TAMIL };
