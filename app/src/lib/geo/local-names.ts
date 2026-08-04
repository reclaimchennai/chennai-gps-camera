/**
 * One place to ask "what is this called in the card's language?".
 *
 * Station, ward and body names arrive from the packs in English. Each
 * language that has a verified dictionary gets a branch here; every other
 * language falls through and keeps the English name. That fallthrough is
 * the point — see tamil-places.ts on why an unverified name is worse than
 * an English one.
 *
 * Adding a language should be an edit to THIS file and nowhere else. The
 * renderers used to test `lang === "ta"` inline, which meant Kannada
 * needed the same three call sites found and changed again.
 */
import { tamilStation, tamilPlace } from "./tamil-places";
import { tamilBodyName } from "./tn-body-names";
import { kannadaStation, kannadaPlace, kannadaBody } from "./kannada-places";

/** Language of a full station name, beat code preserved. */
export function localStation(lang: string, raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (lang === "ta") return tamilStation(raw);
  if (lang === "kn") return kannadaStation(raw);
  return raw;
}

/** Language of a bare locality or ward name, or null when unverified. */
export function localPlace(lang: string, name: string | undefined): string | null {
  if (!name) return null;
  if (lang === "ta") return tamilPlace(name);
  if (lang === "kn") return kannadaPlace(name);
  return null;
}

/** Language of a municipal body's full name, or null when unverified. */
export function localBodyName(lang: string, english: string | undefined): string | null {
  if (!english) return null;
  if (lang === "ta") return tamilBodyName(english);
  if (lang === "kn") return kannadaBody(english);
  return null;
}
