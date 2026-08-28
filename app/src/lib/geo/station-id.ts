/**
 * Are these two station names the same station?
 *
 * The card clubs Law & Order and Traffic into one row when both point at
 * the same place — "Police (L&O & Traffic): S10 Pallikaranai" instead of
 * naming it twice across three lines. That test used to be `lo ===
 * traffic`, string equality, and the two rows come from two different
 * government datasets with two different house styles:
 *
 *     lo       "S10 Pallikaranai PS"
 *     traffic  "S 10 Pallikaranai"
 *
 * One space, and a reader is told there are two police stations to
 * contact when there is one. Across the packs there are 18 more of these:
 * "Anna Nagar" against "Annanagar", "MICO Layout" against "Mico layout",
 * "S.P.Pattinam" against "S.p.pattinam".
 *
 * The beat code is the real identifier — S10, J12, K1 — and it is
 * reliable: of 60 codes appearing in both layers, 59 carry an identical
 * name and the 60th is "Chrompet" against "Chromepet". So a matching code
 * decides it, PROVIDED the names still look like each other. Without that
 * proviso a shared code between two genuinely different stations would
 * silently merge them, and this card exists to be trusted about which
 * station a complaint goes to.
 */
import { stripStationType } from "./local-names";

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Leading beat code, normalised: "S 10 Pallikaranai" -> "S10". */
export function beatCode(name: string): string | null {
  const m = /^([A-Za-z]{1,3})\s*(\d{1,3})\b/.exec(stripStationType(name).trim());
  return m ? `${m[1].toUpperCase()}${m[2]}` : null;
}

/** Everything after the beat code. */
function bareName(name: string): string {
  return stripStationType(name)
    .trim()
    .replace(/^([A-Za-z]{1,3})\s*(\d{1,3})\b\s*/, "");
}

/** Edit distance, but only ever asked whether it is within `max`. */
function within(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < best) best = row[j];
    }
    if (best > max) return false; // no path back under the limit
    prev = row;
  }
  return prev[b.length] <= max;
}

/** Same station, allowing for two datasets' house styles. */
export function sameStation(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const sa = squash(a);
  const sb = squash(b);
  if (sa === sb) return true;

  const ca = beatCode(a);
  const cb = beatCode(b);
  if (!ca || !cb || ca !== cb) return false;

  // Same code, so almost certainly the same station — but only accept it
  // when the names agree too, or a shared code between two different
  // stations would merge them without a trace.
  const na = squash(bareName(a));
  const nb = squash(bareName(b));
  if (!na || !nb) return true; // a bare code on one side, e.g. "S10"
  return na === nb || na.includes(nb) || nb.includes(na) || within(na, nb, 2);
}

/**
 * Which spelling to print once they are clubbed.
 *
 * Law & Order, always. Not a heuristic about which looks tidier — that
 * could pick differently on two photos of the same corner. It is the
 * station a complaint is filed at, its dataset is the more complete of
 * the two (384 properly-formed beat codes against 6 malformed), and one
 * consistent rule beats a cleverer one that is unstable.
 */
export function preferredStationName(lo: string, _traffic: string): string {
  return lo;
}
