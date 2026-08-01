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
import { langOf, scriptAvailable, stringsFor, fontFor } from "./signboard";

const BLUE = "#0056b3";
const WHITE = "#ffffff";
const LATIN =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif";
const TAMIL = `'Noto Sans Tamil', 'Latha', 'Tamil Sangam MN', ${LATIN}`;

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
  measureOnly = false
): SignMetrics {
  const lang = langOf(config.language);
  const t = stringsFor(ctx, lang);
  const tamilOk = scriptAvailable(ctx, "ta");

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
  const bandH = Math.round(72 * s);
  const emblemH = Math.round(bandH * 0.86);
  const authPx = Math.round(19 * s);

  const place = placeName(data, lang);
  const rowPx0 = Math.round(19 * s);

  // ---- technical rows -----------------------------------------------
  const rowPx = rowPx0;
  const rows: string[] = [];
  const f = config.fields;
  if (f.address && data.address) rows.push(data.address);
  if (f.coords) {
    rows.push(
      data.fix ? fmtCoordsLine(data.fix.lat, data.fix.lng) : t.acquiring
    );
  }
  if (f.digipin && data.fix) {
    const code = data.digipin ?? latLngToDigipin(data.fix.lat, data.fix.lng);
    if (code) rows.push(`${t.digipin}: ${code}`);
  }
  if (f.datetime) rows.push(fmtDateLine(data.timestamp, data.tzOffsetMinutes));
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
  const rowGap = Math.round(rowPx * 0.5);
  const rowsH = rows.length ? rows.length * (rowPx + rowGap) : 0;

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
    const z = fmtZone(j.zone);
    const num = /(\d+)/.exec(z);
    footBits.push(`${t.zone} : ${num ? num[1] : z}`);
  }
  const pin = pincodeOf(data);
  if (pin) footBits.push(`${lang === "ta" ? "அஞ்சல் குறியீடு" : "PIN"} : ${pin}`);
  const footH = footBits.length ? Math.round(40 * s) : 0;

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
  const tamilW = tamilOk
    ? Math.max(
        measure("பெருநகர", authPx, TAMIL, "700"),
        measure("சென்னை மாநகராட்சி", authPx, TAMIL, "700")
      )
    : 0;
  const engW = Math.max(
    measure("Greater", authPx, LATIN, "700"),
    measure("Chennai Corporation", authPx, LATIN, "700")
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
  const needed = Math.max(headerW, placeNatural, rowsNatural, footNatural);
  const contentW = Math.max(
    Math.round(220 * s), // never so narrow the header collapses
    Math.min(availW, Math.ceil(needed))
  );
  const width = insetL + contentW + insetR;
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
  // Sized off the PLATE, not just the font scale. At 78*s a landscape
  // shot produced a ~57 px code — roughly 1.5 device pixels per module,
  // which decoded as an empty string on one card and not at all on the
  // other. It has to stay big enough to survive being photographed.
  const qrSize = qr
    ? Math.round(Math.max(78 * s, Math.min(contentW * 0.1, 170)))
    : 0;
  const qrTop = qr ? Math.round(8 * s) : 0;
  const badgeH = Math.max(overhang, qrTop + qrSize);

  const gapS = Math.round(10 * s);
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
  ctx.fillStyle = BLUE;
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

  // ---- white header strip -------------------------------------------
  // slightly more opaque than the plate: blue-on-translucent-white is the
  // first thing to become unreadable as opacity drops
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0.5, config.opacity + 0.2));
  ctx.fillStyle = WHITE;
  ctx.fillRect(x + insetL, cy, contentW, bandH);
  ctx.restore();

  let hx = x + insetL + Math.round(8 * s);
  if (gcc) {
    const gw = Math.round(aspect(gcc, 139 / 190) * emblemH);
    ctx.drawImage(gcc, hx, cy + (bandH - emblemH) / 2, gw, emblemH);
    hx += gw + Math.round(10 * s);
  }
  ctx.fillStyle = BLUE;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  if (tamilOk) {
    ctx.font = `700 ${authPx}px ${TAMIL}`;
    ctx.fillText("பெருநகர", hx, cy + bandH * 0.32);
    ctx.fillText("சென்னை மாநகராட்சி", hx, cy + bandH * 0.68);
  }
  ctx.textAlign = "right";
  const rx = x + insetL + contentW - Math.round(10 * s);
  ctx.font = `700 ${authPx}px ${LATIN}`;
  ctx.fillText("Greater", rx, cy + bandH * 0.32);
  ctx.fillText("Chennai Corporation", rx, cy + bandH * 0.68);
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
    ctx.fillStyle = BLUE;
    ctx.textBaseline = "middle";
    ctx.font = `700 ${fpx}px ${fontFor(lang)}`;
    ctx.fillText(line, x + insetL + contentW / 2, cy + footH / 2);
  }

  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  return { height, width };
}
