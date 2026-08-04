/**
 * Civic crests, one per body, fetched only when a board needs one.
 *
 * These are static URL imports, so the bundle carries 15 short strings
 * and the browser fetches a crest the first time a board actually draws
 * it. Loading them all up front would cost ~540 KB for a set where any
 * given user ever sees one.
 *
 * Provenance: supplied by the owner, who is responsible for the civic
 * marks this app reproduces. Several of these incorporate the national
 * flag or the Ashoka Chakra as part of the body's OWN arms, which is
 * ordinary for Indian civic crests. Cantonment boards remain absent:
 * theirs is the Government of India emblem carrying the Ashoka lion
 * capital, restricted under the State Emblem of India (Prohibition of
 * Improper Use) Act 2005, which is a different thing from a corporation
 * quoting the chakra in its own seal.
 */
import gccUrl from "../../assets/gcc-emblem.png";
import singaraUrl from "../../assets/singara-chennai.png";
import ndmcUrl from "../../assets/ndmc.png";
import mcdUrl from "../../assets/mcd.png";
import chandigarhUrl from "../../assets/chandigarh.png";
import gurugramUrl from "../../assets/gurugram.png";
import mumbaiUrl from "../../assets/mumbai.png";
import ghmcUrl from "../../assets/ghmc.png";
import blrEastUrl from "../../assets/blr-east.png";
import blrCentralUrl from "../../assets/blr-central.png";
import blrNorthUrl from "../../assets/blr-north.png";
import blrSouthUrl from "../../assets/blr-south.png";
import blrWestUrl from "../../assets/blr-west.png";
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
import coimbatoreUrl from "../../assets/tn-coimbatore.png";
import avadiUrl from "../../assets/tn-avadi.png";
import velloreUrl from "../../assets/tn-vellore.png";
import tirunelveliUrl from "../../assets/tn-tirunelveli.png";

export const CREST_URLS: Record<string, string> = {
  gcc: gccUrl,
  singara: singaraUrl,
  ndmc: ndmcUrl,
  mcd: mcdUrl,
  chandigarh: chandigarhUrl,
  gurugram: gurugramUrl,
  mumbai: mumbaiUrl,
  ghmc: ghmcUrl,
  "blr-east": blrEastUrl,
  "blr-central": blrCentralUrl,
  "blr-north": blrNorthUrl,
  "blr-south": blrSouthUrl,
  "blr-west": blrWestUrl,
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
  coimbatore: coimbatoreUrl,
  avadi: avadiUrl,
  vellore: velloreUrl,
  tirunelveli: tirunelveliUrl,
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
