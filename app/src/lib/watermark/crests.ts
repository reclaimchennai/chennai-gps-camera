/**
 * Civic crests, one per body, fetched only when a board needs one.
 *
 * These are static URL imports, so the bundle carries 15 short strings
 * and the browser fetches a crest the first time a board actually draws
 * it. Loading them all up front would cost ~540 KB for a set where any
 * given user ever sees one.
 *
 * Provenance: supplied by the owner, who is responsible for the civic
 * marks this app reproduces. Cantonment boards are deliberately absent —
 * theirs carries the State Emblem of India, restricted under the 2005
 * Act — and so are bodies whose emblem we have not been given.
 */
import gccUrl from "../../assets/gcc-emblem.png";
import singaraUrl from "../../assets/singara-chennai.png";
import ndmcUrl from "../../assets/ndmc.png";
import blrEastUrl from "../../assets/blr-east.png";
import blrCentralUrl from "../../assets/blr-central.png";
import tambaramUrl from "../../assets/tambaram.png";
import cuddaloreUrl from "../../assets/tn-cuddalore.png";
import dindigulUrl from "../../assets/tn-dindigul.png";
import erodeUrl from "../../assets/tn-erode.png";
import hosurUrl from "../../assets/tn-hosur.png";
import kancheepuramUrl from "../../assets/tn-kancheepuram.png";
import karaikudiUrl from "../../assets/tn-karaikudi.png";
import maduraiUrl from "../../assets/tn-madurai.png";
import namakkalUrl from "../../assets/tn-namakkal.png";
import nagercoilUrl from "../../assets/tn-nagercoil.png";
import salemUrl from "../../assets/tn-salem.png";
import sivakasiUrl from "../../assets/tn-sivakasi.png";
import thanjavurUrl from "../../assets/tn-thanjavur.png";
import thoothukudiUrl from "../../assets/tn-thoothukudi.png";
import tiruchirappalliUrl from "../../assets/tn-tiruchirappalli.png";
import tiruppurUrl from "../../assets/tn-tiruppur.png";

export const CREST_URLS: Record<string, string> = {
  gcc: gccUrl,
  singara: singaraUrl,
  ndmc: ndmcUrl,
  "blr-east": blrEastUrl,
  "blr-central": blrCentralUrl,
  tambaram: tambaramUrl,
  cuddalore: cuddaloreUrl,
  dindigul: dindigulUrl,
  erode: erodeUrl,
  hosur: hosurUrl,
  kancheepuram: kancheepuramUrl,
  karaikudi: karaikudiUrl,
  madurai: maduraiUrl,
  namakkal: namakkalUrl,
  nagercoil: nagercoilUrl,
  salem: salemUrl,
  sivakasi: sivakasiUrl,
  thanjavur: thanjavurUrl,
  thoothukudi: thoothukudiUrl,
  tiruchirappalli: tiruchirappalliUrl,
  tiruppur: tiruppurUrl,
};

const cache = new Map<string, Promise<HTMLImageElement | null>>();

function decode(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Fetch one crest, once. Unknown or unsupplied slots resolve to null. */
export function loadCrest(
  slot: string | null | undefined
): Promise<HTMLImageElement | null> {
  if (!slot) return Promise.resolve(null);
  const url = CREST_URLS[slot];
  if (!url) return Promise.resolve(null);
  let p = cache.get(slot);
  if (!p) {
    p = decode(url);
    cache.set(slot, p);
  }
  return p;
}
