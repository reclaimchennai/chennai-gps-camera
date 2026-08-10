/**
 * The text that rides along with a shared file (§ share).
 *
 * One photo carries its full civic context: locality, address, DIGIPIN,
 * corporation/ward/zone, both police stations, and a maps link to the
 * exact coordinates. That is the point of the app — a photo that can be
 * acted on.
 *
 * A SELECTION is different. Captioning five photos from five streets with
 * one street's address would be a false claim about four of them, so the
 * location is only included when every selected item is genuinely from the
 * same place. Otherwise the caption falls back to what is true of all of
 * them: how many, and when.
 *
 * Note this is about the CAPTION. Each photo still carries its own burned
 * watermark and its own EXIF — that is the photo's own evidence and is not
 * altered by how it happens to be shared.
 */
import type { MediaRecord } from "../types";
import { fmtWard, fmtZone } from "./geo/format";

/**
 * How close two captures must be to count as "the same place".
 *
 * Generous on purpose: photographing one blocked drain from three angles
 * moves the phone several metres, and a civic complaint about a single
 * site should still read as a single site.
 */
const SAME_PLACE_M = 120;

function metresBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = (a.lat - b.lat) * 110_540;
  const dLng =
    (a.lng - b.lng) * 111_320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng);
}

/**
 * True when every record was captured at effectively one spot.
 *
 * A record with no fix makes this FALSE rather than "probably fine": an
 * unknown location cannot be asserted to match the others, and the safe
 * failure here is to say less, not more.
 */
export function sameLocation(recs: MediaRecord[]): boolean {
  if (recs.length <= 1) return true;
  const first = recs[0]?.data?.fix;
  if (!first) return false;
  for (const r of recs) {
    const f = r.data?.fix;
    if (!f) return false;
    if (metresBetween(first, f) > SAME_PLACE_M) return false;
  }
  return true;
}

/** The full location block for one record. */
export function captionFor(rec: MediaRecord): string {
  const d = rec.data;
  const jd = d.jurisdiction;
  const lines: string[] = [];
  if (d.locality) lines.push(d.locality);
  if (d.address) lines.push(d.address);
  if (d.digipin) lines.push(`DIGIPIN: ${d.digipin}`);
  if (jd && jd.scope !== "out") {
    const pending = jd.wardPending || jd.scope === "avadi";
    const parts = [jd.corporation];
    if (pending) parts.push("Ward: not yet available");
    else if (jd.ward)
      parts.push(
        `Ward ${fmtWard(jd.ward)}${jd.wardName ? ` (${jd.wardName})` : ""}`
      );
    if (jd.zone && !pending) parts.push(fmtZone(jd.zone));
    if (!jd.ward && !jd.zone) {
      if (jd.block) parts.push(`${jd.block} Block`);
      if (jd.district)
        parts.push(
          /board$/i.test(jd.district) ? jd.district : `${jd.district} District`
        );
    }
    lines.push(parts.filter(Boolean).join(" · "));
    if (jd.loStation) lines.push(`Police (L&O): ${jd.loStation}`);
    if (jd.trafficStation) lines.push(`Traffic: ${jd.trafficStation}`);
  }
  if (rec.kind === "photo" && rec.plates?.length) {
    lines.push(
      `Licence plate${rec.plates.length > 1 ? "s" : ""} (OCR, verify): ${rec.plates.join(", ")}`
    );
  }
  if (d.mockLocation) {
    lines.push("Warning: mock location detected - GPS may be spoofed");
  }
  if (d.fix) {
    lines.push(
      `https://maps.google.com/?q=${d.fix.lat.toFixed(6)},${d.fix.lng.toFixed(6)}`
    );
  }
  return lines.join("\n");
}

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** How many, and over what span — true of any selection. */
function countLine(recs: MediaRecord[]): string {
  const photos = recs.filter((r) => r.kind === "photo").length;
  const videos = recs.length - photos;
  const what = [
    photos ? `${photos} photo${photos === 1 ? "" : "s"}` : "",
    videos ? `${videos} video${videos === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  const times = recs.map((r) => r.createdAt).sort((a, b) => a - b);
  const from = fmtDay(times[0]);
  const to = fmtDay(times[times.length - 1]);
  return from === to ? `${what} · ${from}` : `${what} · ${from} – ${to}`;
}

/**
 * The caption for a selection.
 *
 * Same place → the usual full block, plus the count so the reader knows
 * they are all of one site. Mixed places → the count and dates only; no
 * address, no ward, no coordinates, no maps link.
 */
export function captionForMany(recs: MediaRecord[]): string {
  if (recs.length === 0) return "";
  if (recs.length === 1) return captionFor(recs[0]);
  const count = countLine(recs);
  if (sameLocation(recs)) {
    const body = captionFor(recs[0]);
    return body ? `${count}\n\n${body}` : count;
  }
  return `${count}\nTaken at different places — each photo carries its own location.`;
}
