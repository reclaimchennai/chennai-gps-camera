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

/**
 * "PS" and its equivalents, at the end of a station name.
 *
 * The card already labels the row "Police (L&O & Traffic)", so a trailing
 * "PS" on every value repeats the label once per line and eats width the
 * long clubbed rows do not have. The packs keep it — they carry the names
 * as the source records them, and stripping it there would lose the
 * distinction on re-import — so it comes off at render time only.
 *
 * Every script the card can be set to is covered, because a Tamil card
 * gets a Tamil suffix and the redundancy is exactly the same. Applied
 * AFTER translation for that reason.
 *
 * Anchored to the end and requiring a word boundary, so a place whose
 * name merely ends in those letters is untouched.
 */
const STATION_SUFFIX = [
  /\s*\bP\.?\s?S\.?$/i, // "K1 Sembium PS", "Anna Nagar P.S."
  /\s*\bPolice\s+Station$/i,
  /\s*காவல்\s*நிலையம்$/, // Tamil
  /\s*ಪೊಲೀಸ್\s*ಠಾಣೆ$/, // Kannada
  /\s*ಠಾಣೆ$/,
  /\s*पुलिस\s*स्टेशन$/, // Hindi
  /\s*थाना$/,
  /\s*पोलीस\s*(स्टेशन|ठाणे)$/, // Marathi
  /\s*పోలీస్\s*స్టేషన్$/, // Telugu
  /\s*పోలీస్\s*స్టేషను$/,
  /\s*পুলিশ\s*(স্টেশন|থানা)$/, // Bengali
  /\s*থানা$/,
];

/** Drop a redundant station-type word, whatever the script. */
export function stripStationType(name: string): string {
  for (const rx of STATION_SUFFIX) {
    const cut = name.replace(rx, "");
    // never strip the whole value away — a name that is ONLY the suffix
    // tells the reader more than an empty row does
    if (cut !== name && cut.trim().length > 1) return cut.trim();
  }
  return name;
}

/** Language of a full station name, beat code preserved. */
export function localStation(lang: string, raw: string | undefined): string | undefined {
  if (!raw) return raw;
  if (lang === "ta") return stripStationType(tamilStation(raw));
  if (lang === "kn") return stripStationType(kannadaStation(raw));
  return stripStationType(raw);
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
