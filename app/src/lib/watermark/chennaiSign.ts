/**
 * The Greater Chennai Corporation street sign, as the whole watermark.
 *
 * Modelled on the real boards: a left-pointing arrow plate in GCC blue
 * with a white keyline, a white header strip carrying the corporation's
 * name in Tamil and English between its two emblems, the place name large
 * in the middle, and a white footer strip with the ward/zone/pincode row.
 *
 * It replaces the standard panel rather than sitting on top of it. An
 * earlier version stacked a small tab above the normal card, which put
 * the ward in one block and the zone in another and read as two objects.
 * A street sign is one object, so the technical rows live inside it.
 *
 * Bilingual where we actually have both languages — the corporation's own
 * name, and the footer labels. The place name is English only: it comes
 * from a geocoder that returns English, and transliterating a street name
 * into Tamil ourselves would be inventing the one thing on the card a
 * reader would most reasonably trust.
 */
import type { WatermarkConfig, WatermarkData } from "../../types";
import { fmtCoordsLine, fmtDateLine, fmtWard, fmtZone } from "../geo/format";
import { latLngToDigipin } from "../geo/digipin";
import { tamilStation, tamilPlace } from "../geo/tamil-places";
import { tamilBodyName } from "../geo/tn-body-names";
import {
  isChennaiJurisdiction,
  langOf,
  scriptAvailable,
  stringsFor,
  fontFor,
} from "./signboard";

const BLUE = "#0056b3";
const DELHI_GREEN = "#146b4a";
const WHITE = "#ffffff";
const LATIN =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
const TAMIL = `'Noto Sans Tamil', 'Latha', 'Tamil Sangam MN', ${LATIN}`;

/**
 * Who the board is addressed to, and how that city draws its boards.
 *
 * The sign was gated on Greater Chennai Corporation, which is
 * administratively right and practically wrong: St Thomas Mount reads
 * "Chennai - 600016" to anyone who lives there, but it is a Cantonment
 * Board, so choosing the template did nothing at all. The board now
 * works wherever a jurisdiction resolves, names the body that ACTUALLY
 * covers the spot, and follows that city's own board conventions.
 *
 * Emblems are per-body and never shared. GCC's crest and the Singara
 * Chennai mark appear only inside GCC; stamping them on a complaint
 * bound for a Cantonment Board would misattribute it, which is the one
 * thing this card exists not to do.
 *
 * `logo` names a slot, not a file. Slots stay empty until an emblem with
 * provenance we can stand behind is dropped in — see crests.ts.
 * A board with an empty slot simply renders without it.
 */
export type LogoSlot =
  | "gcc"
  | "singara"
  | "tambaram"
  | "blr-east"
  | "blr-central"
  | "blr-north"
  | "blr-south"
  | "blr-west"
  | "bbmp"
  | "ndmc"
  | "mcd"
  /** Tamil Nadu city corporations, keyed by city */
  | string
  | null;

export interface SignStyle {
  tamil: string | null;
  english: string;
  /** white bar behind the authority name at the top */
  topStrip: boolean;
  /** white bar carrying ward / zone / pincode at the bottom */
  bottomStrip: boolean;
  /** emblem at the left of the header */
  leftLogo: LogoSlot;
  /** emblem straddling the header's lower edge, centred */
  centreLogo: LogoSlot;
  /** Bengaluru: the roundel sits ON the plate at the left, not on a strip */
  logoOnBlue: boolean;
  /** plate colour — Delhi's boards are emerald green, not GCC blue */
  plate: string;
}


/**
 * Tamil Nadu's city corporations: the crest slot and the body's own Tamil
 * name, matched on the corporation string the boundary data reports.
 *
 * Every one of these draws Chennai's layout with its own crest in the
 * centre slot and no GCC crest — a Madurai complaint must not travel
 * under Chennai Corporation's arms.
 *
 * All twenty-one of Tamil Nadu's city corporations are covered. Anything
 * outside the list falls through to the generic board, which names the
 * body in text and draws no crest — nothing borrows a neighbour's arms.
 */
const TN_CORPORATIONS: { match: RegExp; slot: LogoSlot; tamil: string }[] = [
  { match: /tambaram/i, slot: "tambaram", tamil: "தாம்பரம் மாநகராட்சி" },
  { match: /madurai/i, slot: "madurai", tamil: "மதுரை மாநகராட்சி" },
  { match: /tiruchirappalli|trichy/i, slot: "tiruchirappalli", tamil: "திருச்சிராப்பள்ளி மாநகராட்சி" },
  { match: /salem/i, slot: "salem", tamil: "சேலம் மாநகராட்சி" },
  { match: /tiruppur|tirupur/i, slot: "tiruppur", tamil: "திருப்பூர் மாநகராட்சி" },
  { match: /erode/i, slot: "erode", tamil: "ஈரோடு மாநகராட்சி" },
  { match: /thoothukudi|tuticorin/i, slot: "thoothukudi", tamil: "தூத்துக்குடி மாநகராட்சி" },
  { match: /dindigul/i, slot: "dindigul", tamil: "திண்டுக்கல் மாநகராட்சி" },
  { match: /thanjavur|tanjore/i, slot: "thanjavur", tamil: "தஞ்சாவூர் மாநகராட்சி" },
  { match: /hosur/i, slot: "hosur", tamil: "ஓசூர் மாநகராட்சி" },
  { match: /nagercoil/i, slot: "nagercoil", tamil: "நாகர்கோயில் மாநகராட்சி" },
  { match: /kancheepuram|kanchipuram/i, slot: "kancheepuram", tamil: "காஞ்சிபுரம் மாநகராட்சி" },
  { match: /karaikudi/i, slot: "karaikudi", tamil: "காரைக்குடி மாநகராட்சி" },
  { match: /cuddalore/i, slot: "cuddalore", tamil: "கடலூர் மாநகராட்சி" },
  { match: /sivakasi/i, slot: "sivakasi", tamil: "சிவகாசி மாநகராட்சி" },
  { match: /namakkal/i, slot: "namakkal", tamil: "நாமக்கல் மாநகராட்சி" },
  { match: /coimbatore|kovai/i, slot: "coimbatore", tamil: "கோவை மாநகராட்சி" },
  { match: /tirunelveli/i, slot: "tirunelveli", tamil: "திருநெல்வேலி மாநகராட்சி" },
  { match: /vellore/i, slot: "vellore", tamil: "வேலூர் மாநகராட்சி" },
  { match: /avadi/i, slot: "avadi", tamil: "ஆவடி மாநகராட்சி" },
];

/**
 * Local-language names for bodies outside Tamil Nadu.
 *
 * Bengaluru's five are read straight off the corporation roundels the
 * owner supplied — the Kannada ring text IS the official name — and the
 * metros are their published official titles. Tamil Nadu is not here: its
 * 527 bodies come from the LGD table (tn-body-names.ts).
 */
const LOCAL_NAMES: { match: RegExp; local: string; slot?: LogoSlot }[] = [
  { match: /bengaluru north/i, local: "ಬೆಂಗಳೂರು ಉತ್ತರ ನಗರ ಪಾಲಿಕೆ", slot: "blr-north" },
  { match: /bengaluru south/i, local: "ಬೆಂಗಳೂರು ದಕ್ಷಿಣ ನಗರ ಪಾಲಿಕೆ", slot: "blr-south" },
  { match: /bengaluru east/i, local: "ಬೆಂಗಳೂರು ಪೂರ್ವ ನಗರ ಪಾಲಿಕೆ", slot: "blr-east" },
  { match: /bengaluru west/i, local: "ಬೆಂಗಳೂರು ಪಶ್ಚಿಮ ನಗರ ಪಾಲಿಕೆ", slot: "blr-west" },
  { match: /bengaluru central/i, local: "ಬೆಂಗಳೂರು ಕೇಂದ್ರ ನಗರ ಪಾಲಿಕೆ", slot: "blr-central" },
  { match: /bruhat bengaluru|bbmp/i, local: "ಬೃಹತ್ ಬೆಂಗಳೂರು ಮಹಾನಗರ ಪಾಲಿಕೆ", slot: "bbmp" },
  { match: /brihanmumbai|greater mumbai/i, local: "बृहन्मुंबई महानगरपालिका" },
  { match: /pune municipal/i, local: "पुणे महानगरपालिका" },
  { match: /kolkata municipal/i, local: "কলকাতা পৌরসংস্থা" },
  { match: /greater hyderabad/i, local: "గ్రేటర్ హైదరాబాద్ మున్సిపల్ కార్పొరేషన్" },
  { match: /visakhapatnam/i, local: "గ్రేటర్ విశాఖపట్నం మున్సిపల్ కార్పొరేషన్" },
  { match: /new delhi municipal/i, local: "नई दिल्ली नगरपालिक परिषद", slot: "ndmc" },
  { match: /municipal corporation of delhi|^delhi/i, local: "दिल्ली नगर निगम", slot: "mcd" },
];

export function signStyle(data: WatermarkData): SignStyle | null {
  const j = data.jurisdiction;
  if (!j || j.scope === "out") return null;
  const name = j.corporation ?? j.district;

  if (isChennaiJurisdiction(j)) {
    return {
      tamil: "பெருநகர சென்னை மாநகராட்சி",
      english: "Greater Chennai Corporation",
      topStrip: true,
      bottomStrip: true,
      leftLogo: "gcc",
      centreLogo: "singara",
      logoOnBlue: false,
      plate: BLUE,
    };
  }
  if (!name) return null;

  // Cantonment boards: name only. Their emblem carries the State Emblem
  // of India, restricted under the 2005 Act, so no crest is drawn. They
  // have no ward/zone data either, so there is nothing for a bottom bar
  // to hold and it is omitted rather than left empty.
  if (/cantonment/i.test(name)) {
    return {
      tamil: null,
      english: name,
      topStrip: true,
      bottomStrip: false,
      leftLogo: null,
      centreLogo: null,
      logoOnBlue: false,
      plate: BLUE,
    };
  }

  const tn = TN_CORPORATIONS.find((c) => c.match.test(name));
  if (tn) {
    return {
      tamil: tn.tamil,
      english: name,
      topStrip: true,
      bottomStrip: true,
      leftLogo: null,
      centreLogo: tn.slot,
      logoOnBlue: false,
      plate: BLUE,
    };
  }

  // One board for everyone: the body's own-language name on the left of
  // the white strip, its crest in the middle, the English name on the
  // right. Tamil Nadu's names come from the LGD table; everywhere else
  // from LOCAL_NAMES. A body with neither still gets the English name,
  // which is always present.
  const hit = LOCAL_NAMES.find((l) => l.match.test(name));
  const local = hit?.local ?? tamilBodyName(name);
  return {
    tamil: local,
    english: name,
    topStrip: true,
    bottomStrip: true,
    leftLogo: null,
    centreLogo: hit?.slot ?? null,
    logoOnBlue: false,
    plate: /delhi/i.test(name) ? DELHI_GREEN : BLUE,
  };
}

/** Back-compat name used by render.ts's gate. */
export const signAuthority = signStyle;

/** Width/height of a drawable, falling back to its known design ratio. */
function aspect(img: CanvasImageSource, fallback: number): number {
  const w = (img as HTMLImageElement).width;
  const h = (img as HTMLImageElement).height;
  return w && h ? w / h : fallback;
}


/** Localise a data value (station, zone name) when the card is Tamil. */
function loc(lang: string, v: string | undefined): string | undefined {
  return v && lang === "ta" ? tamilStation(v) : v;
}

/** Pull a 6-digit Indian pincode out of the reverse-geocoded address. */
function pincodeOf(data: WatermarkData): string | null {
  const m = /\b([1-9]\d{5})\b/.exec(data.address ?? "");
  return m ? m[1] : null;
}

/** Place name for the big line — first segment, no ", Chennai" tail. */
function placeName(data: WatermarkData, lang: string): string {
  const raw = data.locality ?? data.jurisdiction?.city ?? "Chennai";
  const head = raw.split(",")[0].trim() || "Chennai";
  // the geocoder usually answers in Tamil already; this covers the
  // offline path, where the locality comes from the English pack
  return (lang === "ta" ? tamilPlace(head) : null) ?? head;
}

/**
 * Wrap `text` to `maxW` over at most `maxLines`, breaking at spaces and
 * preferring a comma boundary so an address splits where a reader would
 * split it. The last line is ellipsized if it still overflows.
 */
function wrapTo(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  font: string,
  maxW: number,
  maxLines: number
): string[] {
  ctx.font = `${px}px ${font}`;
  if (ctx.measureText(text).width <= maxW) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const attempt = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(attempt).width <= maxW || !cur) {
      cur = attempt;
    } else if (lines.length < maxLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = attempt;
    }
  }
  if (cur) lines.push(cur);
  // Break after a comma, choosing the one nearest the MIDDLE rather than
  // the last that happens to fit — an address split at its final comma
  // gives one long line and one stub.
  if (lines.length === 2) {
    const joined = lines.join(" ");
    const mid = joined.length / 2;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < joined.length; i++) {
      if (joined[i] !== ",") continue;
      if (ctx.measureText(joined.slice(0, i + 1)).width > maxW) continue;
      if (ctx.measureText(joined.slice(i + 1).trim()).width > maxW) continue;
      const dist = Math.abs(i - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    if (best > 0) {
      lines[0] = joined.slice(0, best + 1).trim();
      lines[1] = joined.slice(best + 1).trim();
    }
  }
  let last = lines[lines.length - 1];
  if (last && ctx.measureText(last).width > maxW) {
    while (ctx.measureText(last + "\u2026").width > maxW && last.length > 2) {
      last = last.slice(0, -2);
    }
    lines[lines.length - 1] = last + "\u2026";
  }
  return lines;
}

/** Split a name over at most two balanced lines at a space. */
function splitTwo(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const words = t.split(/\s+/);
  if (words.length < 3) return [t];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(i).join(" ").length;
    if (Math.abs(a - b) < bestDiff) {
      bestDiff = Math.abs(a - b);
      best = i;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  font: string,
  maxW: number,
  weight = "700"
): number {
  let size = px;
  for (;;) {
    ctx.font = `${weight} ${Math.round(size)}px ${font}`;
    if (ctx.measureText(text).width <= maxW || size <= px * 0.45) break;
    size *= 0.94;
  }
  return Math.round(size);
}

export interface SignMetrics {
  height: number;
  /** Shrink-wrapped plate width — the caller positions with this. */
  width: number;
}

/**
 * Measure and/or paint. Pass `measureOnly` to get the height without
 * drawing, so the caller can place the plate before committing to it.
 */
export function renderChennaiSign(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  s: number,
  data: WatermarkData,
  config: WatermarkConfig,
  qr: CanvasImageSource | null,
  gcc: CanvasImageSource | null,
  singara: CanvasImageSource | null,
  corp: CanvasImageSource | null,
  preview = false,
  measureOnly = false
): SignMetrics {
  const lang = langOf(config.language);
  const t = stringsFor(ctx, lang);
  const style = signStyle(data);
  // Slots decide which emblem, if any, each position gets. An emblem with
  // no slot on this board is dropped rather than reused elsewhere.
  const leftImg =
    style?.leftLogo === "gcc" ? gcc : style?.leftLogo ? corp : null;
  const centreImg =
    style?.centreLogo === "singara"
      ? singara
      : style?.centreLogo
        ? corp
        : null;
  gcc = leftImg;
  singara = centreImg;
  const tamilOk = scriptAvailable(ctx, "ta") && !!style?.tamil;

  const pad = Math.round(16 * s);
  const shape = config.signShape ?? "arrow-left";
  const pointsLeft = shape === "arrow-left" || shape === "arrow-both";
  const pointsRight = shape === "arrow-right" || shape === "arrow-both";
  // Fixed to the scale rather than to the plate width: the width is about
  // to be derived FROM the content, so an arrow measured as a fraction of
  // it would be circular.
  const arrow = Math.round(78 * s);
  const insetL = (pointsLeft ? arrow : 0) + pad;
  const insetR = (pointsRight ? arrow : 0) + pad;

  // ---- header strip -------------------------------------------------
  const withStrip = style?.topStrip !== false;
  const bandH = Math.round(66 * s);
  const emblemH = Math.round(bandH * 0.86);
  const authPx = Math.round(19 * s);

  const place = placeName(data, lang);
  const rowPx0 = Math.round(19 * s);

  // ---- technical rows -----------------------------------------------
  const rowPx = rowPx0;
  const rows: string[] = [];
  const f = config.fields;
  const addressText = f.address ? (data.address ?? "") : "";
  if (f.coords) {
    rows.push(
      data.fix ? fmtCoordsLine(data.fix.lat, data.fix.lng, lang) : t.acquiring
    );
  }
  if (f.digipin && data.fix) {
    const code = data.digipin ?? latLngToDigipin(data.fix.lat, data.fix.lng);
    if (code) rows.push(`${t.digipin}: ${code}`);
  }
  if (f.datetime) rows.push(fmtDateLine(data.timestamp, data.tzOffsetMinutes, lang));
  const j = data.jurisdiction;
  // Police is ONE row, same rule the detailed card follows: club L&O and
  // Traffic when the station is the same rather than printing it twice.
  const lo = loc(lang, f.loStation ? j?.loStation : undefined);
  const traffic = loc(lang, f.trafficStation ? j?.trafficStation : undefined);
  if (lo && traffic) {
    rows.push(
      lo === traffic
        ? `${t.policeBoth}: ${lo}`
        : `${t.policeLo} - ${lo}  ·  ${t.traffic} - ${traffic}`
    );
  } else if (lo) {
    rows.push(`${t.policeLo}: ${lo}`);
  } else if (traffic) {
    rows.push(`${t.traffic}: ${traffic}`);
  }
  if (data.mockLocation) rows.push(t.mock);
  const rowGap = Math.round(rowPx * 0.34); // was 0.5 — the rows drove the height

  // ---- footer strip: ward / zone / pincode --------------------------
  const footBits: string[] = [];
  if (f.ward && j?.ward && !j.wardPending) {
    footBits.push(`${t.ward} : ${fmtWard(j.ward)}`);
  }
  if (f.zone && j?.zone) {
    // the real boards print "\u0bae\u0ba3\u0bcd\u0b9f\u0bb2\u0bae\u0bcd : 12" — label then number. fmtZone()
    // returns "Zone 5 (Royapuram)", which behind a "Zone :" label read
    // "Zone : Zone 5 (Royapuram)"; that duplication was on the English
    // card too. Take the number, and only fall back to the full string
    // when a pack has no zone number to take.
    const z = fmtZone(j.zone, lang);
    const num = /(\d+)/.exec(z);
    footBits.push(`${t.zone} : ${num ? num[1] : z}`);
  }
  const pin = pincodeOf(data);
  if (pin) footBits.push(`${t.pincode} : ${pin}`);
  const wantsFoot = style?.bottomStrip !== false && footBits.length > 0;
  const footH = wantsFoot ? Math.round(34 * s) : 0;
  // no bottom bar: the same facts still belong on the board, so they go
  // in as an ordinary white-on-blue row rather than being dropped
  if (!wantsFoot && footBits.length) rows.push(footBits.join("  ·  "));
  // measured only now: the no-bottom-strip styles append a row above,
  // and computing this earlier left the plate one row short, clipping it


  // Scannable, not enormous. Sizing off the plate alone starved it once
  // the plate started shrink-wrapping (a 1440x900 frame gave ~50 px, about
  // 1.4 device pixels per module, which does not decode). Tying it to the
  // output at 0.14 then overcorrected and the code dominated the board.
  // The content is ~37 modules, so ~3 px each is the floor that matters:
  // 100 px is the smallest that reliably decodes, and there is nothing to
  // gain above ~112 — at 170 the code was dominating the board.
  // The QR is a share of the PLATE, not of the frame. Sizing it off the
  // frame made it look different on every photo shape and enormous on the
  // live overlay, because a fixed pixel floor is a big fraction of a small
  // canvas. Measured off the board the owner approved: ~13.5% of the
  // plate's content width.
  //
  // The absolute floor is only about surviving being photographed, so it
  // applies at capture sizes only; the preview is purely proportional and
  // therefore matches what gets written.
  const QR_PLATE_FRAC = 0.135;

  // ---- shrink-wrap ---------------------------------------------------
  // The plate used to span the full frame whatever it held, so a short
  // place name over five short rows still painted a board across the
  // whole photo. Measure what the content actually needs and take the
  // smaller of that and the space available.
  const measure = (text: string, px: number, font: string, weight = "400") => {
    ctx.font = `${weight} ${px}px ${font}`;
    return ctx.measureText(text).width;
  };
  const availW = w - insetL - insetR;
  const gapMin = Math.round(18 * s);
  const emblemW = gcc ? Math.round(aspect(gcc, 139 / 190) * emblemH) : 0;
  const singaraW = singara
    ? Math.round(aspect(singara, 1) * Math.round(112 * s))
    : 0;
  const tamilLines = tamilOk ? splitTwo(style!.tamil!) : [];
  const tamilW = tamilLines.length
    ? Math.max(...tamilLines.map((l) => measure(l, authPx, TAMIL, "700")))
    : 0;
  // the English name is split over two lines at the last space that
  // keeps both halves under half the plate; a Cantonment Board's name is
  // far longer than "Greater / Chennai Corporation"
  const engLines = splitTwo(style?.english ?? "");
  const engW = Math.max(
    ...engLines.map((l) => measure(l, authPx, LATIN, "700"))
  );
  // The Singara mark is drawn CENTRED, so a sequential left+logo+right
  // sum is not enough: whichever side is wider decides how much room the
  // centre has. Sizing to twice the wider side keeps the logo clear of
  // both — a plain sum let the Tamil name run under the logo once the
  // plate started shrink-wrapping.
  const leftBlock = emblemW + Math.round(8 * s) + tamilW;
  const rightBlock = engW + Math.round(10 * s);
  const headerW =
    2 * Math.max(leftBlock, rightBlock) + singaraW + 2 * gapMin;
  const placeNatural = measure(place, Math.round(46 * s), fontFor(lang), "700");
  const rowsNatural = rows.reduce(
    (m, r) => Math.max(m, measure(r, rowPx, fontFor(lang))),
    0
  );
  const footNatural = footBits.length
    ? measure(footBits.join("  ·  "), Math.round(19 * s), fontFor(lang), "700") +
      Math.round(24 * s)
    : 0;
  // Pass one: what the board needs with no QR in it. That fixes the
  // plate's natural width, which the QR is then sized against — sizing
  // the two against each other would be circular.
  const need0 = Math.max(headerW, placeNatural, rowsNatural, footNatural);
  const content0 = Math.max(
    Math.round(220 * s),
    Math.min(availW, Math.ceil(need0))
  );
  const qrIdeal = content0 * QR_PLATE_FRAC;
  // provisional, only so the badge row can reserve space; the real size
  // is taken from the FINAL plate width below
  const qrProvisional = qr
    ? preview
      ? Math.round(qrIdeal)
      : Math.round(Math.min(170, Math.max(96, qrIdeal)))
    : 0;

  // the crest is centred and the QR sits hard right, so the plate has to
  // be wide enough that they cannot meet
  const badgeRowW = qrProvisional
    ? 2 * (qrProvisional + gapMin) + singaraW
    : 0;
  // The address is the one row that can run far longer than everything
  // else. Left in the width calculation it stretched the plate across the
  // whole photo; shrunk to fit it became a thread. It is wrapped instead,
  // to the width the REST of the board already needs, over at most two
  // lines — so the plate stays the size its other content asks for.
  let needed = Math.max(need0, badgeRowW);
  if (addressText) {
    // Prefer letting the address WIDEN the plate over stacking another
    // row. A board is meant to be wide; capping the wrap at the width the
    // rest of the board happened to need made the address fold and the
    // plate come out nearly square (877x806).
    const cap = Math.min(availW, Math.max(needed, Math.round(availW * 0.55)));
    const addrLines = wrapTo(ctx, addressText, rowPx, fontFor(lang), cap, 2);
    rows.unshift(...addrLines);
    // and the plate must actually adopt that width — wrapping to a cap
    // the plate never took would just hand a too-long line to fitText,
    // which shrinks it to a thread. This is the bug the wrap replaced.
    for (const l of addrLines) {
      needed = Math.max(needed, measure(l, rowPx, fontFor(lang)));
    }
  }
  // Measured only now. The address lines join `rows` above, and computing
  // this before that left the plate short by two rows — the footer strip
  // fell out of the bottom of the board. Same mistake as the ward row
  // before it; the rule is that nothing may touch `rows` after this line.
  const rowsH = rows.length ? rows.length * (rowPx + rowGap) : 0;
  const contentW = Math.max(
    Math.round(220 * s), // never so narrow the header collapses
    Math.min(availW, Math.ceil(needed))
  );
  const width = insetL + contentW + insetR;
  // Sized against the FINAL plate, so the code keeps the same share of the
  // board however wide the address made it. Taking it from the pre-address
  // width left the QR at 7% of a wide plate when the approved look is
  // ~13.5%.
  const qrSize = qr
    ? preview
      ? Math.round(contentW * QR_PLATE_FRAC)
      : Math.round(Math.min(170, Math.max(96, contentW * QR_PLATE_FRAC)))
    : 0;
  const placePx = fitText(
    ctx, place, Math.round(46 * s), fontFor(lang), contentW
  );

  // The Singara mark straddles the header strip's lower edge the way it
  // sits on the real boards: the diamond half on the white and half on
  // the blue, with the "Singara Chennai 2.0" wordmark clear of the strip
  // on the blue below it.
  //
  // Centring the IMAGE on that edge would not do it — the asset is a
  // diamond with the wordmark beneath, so the artwork's own centre sits
  // at 0.426 of its height (measured: ink rows 0-179 diamond, 189-209
  // wordmark, of 210). Aligning by the diamond's centre instead is what
  // makes the halves actually equal.
  const DIAMOND_MID = 0.426;
  const singaraH = singara ? Math.round(112 * s) : 0;
  const overhang = singara ? Math.round(singaraH * (1 - DIAMOND_MID)) : 0;

  const qrTop = qr ? Math.round(8 * s) : 0;
  const badgeH = Math.max(overhang, qrTop + qrSize);

  const gapS = Math.round(7 * s);
  const height =
    pad +
    bandH +
    badgeH +
    gapS +
    Math.round(placePx * 1.18) +
    (rowsH ? gapS + rowsH : 0) +
    (footH ? gapS + footH : 0) +
    pad;

  if (measureOnly) return { height, width };

  const h = height;
  ctx.save();

  // ---- plate --------------------------------------------------------
  // left-pointing arrow, apex at mid-height, per the GCC boards
  const plate = (insetPx: number) => {
    const l = x + insetPx;
    const r = x + width - insetPx;
    const tp = y + insetPx;
    const bt = y + h - insetPx;
    const mid = (tp + bt) / 2;
    const ax = l + arrow;
    const bx = r - arrow;
    ctx.beginPath();
    if (pointsLeft) {
      ctx.moveTo(l, mid);
      ctx.lineTo(ax, tp);
    } else {
      ctx.moveTo(l, tp);
    }
    if (pointsRight) {
      ctx.lineTo(bx, tp);
      ctx.lineTo(r, mid);
      ctx.lineTo(bx, bt);
    } else {
      ctx.lineTo(r, tp);
      ctx.lineTo(r, bt);
    }
    ctx.lineTo(pointsLeft ? ax : l, bt);
    ctx.closePath();
  };
  // The plate honours the card's opacity like every other layout, so the
  // photo stays visible behind it — a solid board hid the very thing the
  // photo was taken to show. Only the BACKGROUND fades: the keyline, the
  // text, the emblems and the QR stay fully opaque, because a translucent
  // QR does not scan and a translucent address is not evidence.
  plate(0);
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0.35, config.opacity));
  ctx.fillStyle = style?.plate ?? BLUE;
  ctx.fill();
  ctx.restore();
  ctx.lineJoin = "round";
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = Math.max(2, Math.round(4 * s));
  ctx.stroke();
  plate(Math.round(7 * s));
  ctx.lineWidth = Math.max(1, Math.round(2 * s));
  ctx.stroke();

  let cy = y + pad;

  // ---- header strip ---------------------------------------------------
  // Bengaluru's boards have no white bars, so the strip is skipped and
  // the names are drawn white on blue instead.
  if (withStrip) {
    // slightly more opaque than the plate: blue-on-translucent-white is
    // the first thing to become unreadable as opacity drops
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.5, config.opacity + 0.2));
    ctx.fillStyle = WHITE;
    ctx.fillRect(x + insetL, cy, contentW, bandH);
    ctx.restore();
  }

  let hx = x + insetL + Math.round(8 * s);
  if (gcc) {
    const gh = style?.logoOnBlue ? Math.round(bandH * 1.05) : emblemH;
    const gw = Math.round(aspect(gcc, 139 / 190) * gh);
    ctx.drawImage(gcc, hx, cy + (bandH - gh) / 2, gw, gh);
    hx += gw + Math.round(10 * s);
  }
  ctx.fillStyle = withStrip ? (style?.plate ?? BLUE) : WHITE;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const place2 = (i: number, n: number) =>
    cy + bandH * (n > 1 ? (i ? 0.68 : 0.32) : 0.5);
  if (tamilLines.length) {
    ctx.font = `700 ${authPx}px ${TAMIL}`;
    tamilLines.forEach((l, i) =>
      ctx.fillText(l, hx, place2(i, tamilLines.length))
    );
  }
  // With no Tamil line the English name carries the strip alone, so it
  // starts at the left instead of hugging a right edge across a gap.
  const soloEnglish = !tamilLines.length;
  ctx.textAlign = soloEnglish ? "left" : "right";
  const rx = soloEnglish ? hx : x + insetL + contentW - Math.round(10 * s);
  ctx.font = `700 ${authPx}px ${LATIN}`;
  engLines.forEach((l, i) =>
    ctx.fillText(l, rx, place2(i, engLines.length))
  );
  cy += bandH;

  // ---- Singara mark (straddling) + QR (right, under the English text) --
  // Drawn after the strip so the upper half sits ON the white.
  const bandBottom = cy;
  if (badgeH) {
    if (singara) {
      const sw = Math.round(aspect(singara, 1) * singaraH);
      ctx.drawImage(
        singara,
        x + insetL + (contentW - sw) / 2,
        bandBottom - singaraH * DIAMOND_MID,
        sw,
        singaraH
      );
    }
    if (qr && qrSize) {
      // white plate so it stays scannable against the blue
      const qx = x + insetL + contentW - qrSize;
      const qy = bandBottom + qrTop;
      ctx.fillStyle = WHITE;
      ctx.fillRect(qx, qy, qrSize, qrSize);
      const ins = Math.round(qrSize * 0.06);
      // nearest-neighbour: smoothing greys the module edges and is the
      // difference between a code that scans and one that only looks right
      const smooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(qr, qx + ins, qy + ins, qrSize - ins * 2, qrSize - ins * 2);
      ctx.imageSmoothingEnabled = smooth;
    }
    cy = bandBottom + badgeH;
  }

  // ---- place name ----------------------------------------------------
  cy += gapS;
  ctx.fillStyle = WHITE;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `700 ${placePx}px ${fontFor(lang)}`;
  ctx.fillText(place, x + insetL + contentW / 2, cy, contentW);
  cy += Math.round(placePx * 1.18);

  // ---- technical rows -------------------------------------------------
  if (rows.length) {
    cy += gapS;
    for (const r of rows) {
      // a clubbed police row is the longest line on the plate; shrink it
      // to fit instead of letting fillText squash it out of shape
      const px = fitText(ctx, r, rowPx, fontFor(lang), contentW, "400");
      ctx.font = `${px}px ${fontFor(lang)}`;
      ctx.fillStyle = r === t.mock ? "#ffd54a" : "rgba(255,255,255,0.95)";
      ctx.fillText(r, x + insetL + contentW / 2, cy + (rowPx - px) / 2);
      cy += rowPx + rowGap;
    }
  }

  // ---- white footer strip ---------------------------------------------
  if (footH) {
    cy += gapS;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.5, config.opacity + 0.2));
    ctx.fillStyle = WHITE;
    ctx.fillRect(x + insetL, cy, contentW, footH);
    ctx.restore();
    const line = footBits.join("  ·  ");
    const fpx = fitText(
      ctx,
      line,
      Math.round(19 * s),
      fontFor(lang),
      contentW - Math.round(16 * s)
    );
    ctx.fillStyle = style?.plate ?? BLUE;
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fpx}px ${fontFor(lang)}`;
    ctx.fillText(line, x + insetL + contentW / 2, cy + footH / 2);
  }

  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  return { height, width };
}
