/**
 * The two logos the Chennai street sign carries.
 *
 * Both are bundled rather than fetched: the card has to render with no
 * network, and a sign that sometimes loses its emblems is worse than one
 * that never had them. Trimmed and scaled to ~13 KB each at build time.
 *
 * Provenance, because it matters for a municipal mark:
 *  - GCC emblem — Wikimedia Commons, tagged public domain.
 *  - Singara Chennai 2.0 — Chennai Smart City Limited's own asset page
 *    (cscl.co.in), the official government source rather than a scrape.
 *    That site carries a general "all rights reserved" footer, so this is
 *    a reproduction of a public civic mark on a civic-reporting card, not
 *    a free-licence asset. Reproducing the street sign was the owner's
 *    explicit call.
 *
 * Decoding is async but the renderer is synchronous, so images are
 * preloaded once and read from the cache. Until they resolve the sign
 * draws without them — never blocking a capture on a decode.
 */
import { resetScriptCache } from "./signboard";
import gccUrl from "../../assets/gcc-emblem.png";
import singaraUrl from "../../assets/singara-chennai.png";

export interface ChennaiLogos {
  gcc: HTMLImageElement | null;
  singara: HTMLImageElement | null;
}

const logos: ChennaiLogos = { gcc: null, singara: null };
let pending: Promise<ChennaiLogos> | null = null;

async function tamilFontReady(): Promise<void> {
  try {
    const f = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!f) return;
    await f.load('700 24px "Noto Sans Tamil"', "\u0b9a\u0bc6\u0ba9\u0bcd\u0ba9\u0bc8");
    await f.load('400 24px "Noto Sans Tamil"', "\u0b9a\u0bc6\u0ba9\u0bcd\u0ba9\u0bc8");
    resetScriptCache();
  } catch {
    // font loading unsupported — the probe still guards against tofu
  }
}

function load(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Kick off (or await) the one-time decode. Safe to call repeatedly. */
export function ensureChennaiLogos(): Promise<ChennaiLogos> {
  if (!pending) {
    pending = Promise.all([
      load(gccUrl),
      load(singaraUrl),
      // the bundled Tamil face must be resident before anything measures
      // or draws Tamil, or the first card of the session falls back
      tamilFontReady(),
    ]).then(([gcc, singara]) => {
      logos.gcc = gcc;
      logos.singara = singara;
      return logos;
    });
  }
  return pending;
}

/** Whatever has decoded so far — nulls are drawn around, not waited on. */
export function chennaiLogos(): ChennaiLogos {
  void ensureChennaiLogos();
  return logos;
}
