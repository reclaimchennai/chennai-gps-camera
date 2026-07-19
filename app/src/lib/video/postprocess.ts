/**
 * Container-level fixes applied to every saved/exported video so the
 * file behaves properly OUTSIDE this app (phone galleries, editors,
 * Google Photos):
 *
 *  - MP4: inject the standard ISO-6709 location atom (moov/udta/©xyz) —
 *    the same field phone cameras write, which gallery apps read as the
 *    video's location. MP4 recordings are preferred when the browser
 *    supports them (better compatibility than webm everywhere).
 *  - WebM (fallback): MediaRecorder famously writes no Duration header,
 *    which makes players show a blank length and some editors call the
 *    file corrupted — patch it in with the measured duration.
 */
import fixWebmDuration from "fix-webm-duration";
import type { Fix } from "../../types";

/** Recording formats in preference order: MP4 first for compatibility. */
export const RECORD_MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickRecordingMime(): string {
  return (
    RECORD_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? ""
  );
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function makeBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  out[0] = (size >>> 24) & 0xff;
  out[1] = (size >>> 16) & 0xff;
  out[2] = (size >>> 8) & 0xff;
  out[3] = size & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(payload, 8);
  return out;
}

/**
 * MediaRecorder emits FRAGMENTED MP4 (moov + moof/mdat…, optional mfra
 * seek index at the end). Fragments address samples relative to their
 * own moof (Chrome sets default-base-is-moof), so growing moov is safe
 * for playback — but the mfra/tfra index stores ABSOLUTE moof offsets,
 * which must be shifted by the inserted length (or, if its layout ever
 * surprises us, the whole optional mfra is renamed to a `free` box).
 */
function patchMfraOffsets(out: Uint8Array, delta: number): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let off = 0;
  while (off + 8 <= out.length) {
    let size = readU32(out, off);
    const type = String.fromCharCode(
      out[off + 4], out[off + 5], out[off + 6], out[off + 7]
    );
    if (size === 0) size = out.length - off;
    if (size < 8) return;
    if (type === "mfra") {
      try {
        let child = off + 8;
        const mfraEnd = off + size;
        while (child + 8 <= mfraEnd) {
          const cSize = readU32(out, child);
          const cType = String.fromCharCode(
            out[child + 4], out[child + 5], out[child + 6], out[child + 7]
          );
          if (cSize < 8) throw new Error("bad child");
          if (cType === "tfra") {
            const version = out[child + 8];
            const lengthSizes = readU32(out, child + 16);
            const entryTail =
              (((lengthSizes >> 4) & 3) + 1) +
              (((lengthSizes >> 2) & 3) + 1) +
              ((lengthSizes & 3) + 1);
            const count = readU32(out, child + 20);
            let e = child + 24;
            for (let i = 0; i < count; i++) {
              if (version === 1) {
                const moofOff = view.getBigUint64(e + 8);
                view.setBigUint64(e + 8, moofOff + BigInt(delta));
                e += 16 + entryTail;
              } else {
                view.setUint32(e + 4, view.getUint32(e + 4) + delta);
                e += 8 + entryTail;
              }
              if (e > mfraEnd) throw new Error("overrun");
            }
          }
          child += cSize;
        }
      } catch {
        // layout surprise — neutralize the optional index instead
        out[off + 4] = 0x66; // 'f'
        out[off + 5] = 0x72; // 'r'
        out[off + 6] = 0x65; // 'e'
        out[off + 7] = 0x65; // 'e'
      }
    }
    off += size;
  }
}

/**
 * Append moov/udta/©xyz with "+13.0405+080.2337/" (ISO 6709). Returns the
 * original blob untouched on any structural surprise — never corrupts.
 */
export async function injectMp4Location(
  blob: Blob,
  lat: number,
  lng: number
): Promise<Blob> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let off = 0;
    let moovStart = -1;
    let moovSize = 0;
    while (off + 8 <= buf.length) {
      let size = readU32(buf, off);
      const type = String.fromCharCode(
        buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]
      );
      if (size === 1) return blob; // 64-bit boxes — don't touch
      if (size === 0) size = buf.length - off;
      if (size < 8) return blob;
      if (type === "moov") {
        moovStart = off;
        moovSize = size;
        break;
      }
      off += size;
    }
    if (moovStart < 0 || moovStart + moovSize > buf.length) return blob;

    // fragments must not carry absolute base offsets (Chrome never sets
    // them, but verify before shifting anything)
    if (hasAbsoluteBaseOffsets(buf)) return blob;

    const latStr = `${lat >= 0 ? "+" : "-"}${Math.abs(lat).toFixed(4).padStart(7, "0")}`;
    const lngStr = `${lng >= 0 ? "+" : "-"}${Math.abs(lng).toFixed(4).padStart(8, "0")}`;
    const loc = new TextEncoder().encode(`${latStr}${lngStr}/`);
    const payload = new Uint8Array(4 + loc.length);
    payload[0] = (loc.length >> 8) & 0xff;
    payload[1] = loc.length & 0xff;
    payload[2] = 0x15; // packed ISO-639 "eng"
    payload[3] = 0xc7;
    payload.set(loc, 4);
    const udta = makeBox("udta", makeBox("\xa9xyz", payload));

    const newMoovSize = moovSize + udta.length;
    const out = new Uint8Array(buf.length + udta.length);
    out.set(buf.subarray(0, moovStart));
    out[moovStart] = (newMoovSize >>> 24) & 0xff;
    out[moovStart + 1] = (newMoovSize >>> 16) & 0xff;
    out[moovStart + 2] = (newMoovSize >>> 8) & 0xff;
    out[moovStart + 3] = newMoovSize & 0xff;
    out.set(
      buf.subarray(moovStart + 4, moovStart + moovSize),
      moovStart + 4
    );
    out.set(udta, moovStart + moovSize);
    out.set(
      buf.subarray(moovStart + moovSize),
      moovStart + moovSize + udta.length
    );

    patchMfraOffsets(out, udta.length);
    return new Blob([out], { type: blob.type });
  } catch {
    return blob;
  }
}

/** True if any moof/traf/tfhd uses base-data-offset (absolute addressing). */
function hasAbsoluteBaseOffsets(buf: Uint8Array): boolean {
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = readU32(buf, off);
    const type = String.fromCharCode(
      buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]
    );
    if (size === 0) size = buf.length - off;
    if (size < 8) return true; // malformed — treat as unsafe
    if (type === "moof") {
      // scan for tfhd boxes inside (moof/traf/tfhd)
      for (let i = off + 8; i + 12 <= off + size; i++) {
        if (
          buf[i] === 0x74 && buf[i + 1] === 0x66 &&
          buf[i + 2] === 0x68 && buf[i + 3] === 0x64 // "tfhd"
        ) {
          const flags = readU32(buf, i + 4) & 0xffffff;
          if (flags & 0x000001) return true;
        }
      }
    }
    off += size;
  }
  return false;
}

/** Iterate the immediate child boxes in [start, end), calling cb with the
 *  box type and its start/content/end offsets. Content start is after the
 *  8-byte header (these full boxes never use the 64-bit size form). */
function eachChildBox(
  buf: Uint8Array,
  dv: DataView,
  start: number,
  end: number,
  cb: (type: string, boxStart: number, contentStart: number, boxEnd: number) => void
): void {
  let off = start;
  while (off + 8 <= end) {
    let size = readU32(buf, off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) return;
    cb(type, off, off + 8, off + size);
    off += size;
  }
}

/**
 * MediaRecorder's fragmented MP4 leaves the moov track durations at 0 — the
 * real timing lives in the fragments — so phone galleries and pickers that
 * read only the moov show a bogus (short) length. Patch the measured total
 * into mvhd/tkhd (movie timescale) and each mdhd (its own media timescale),
 * IN PLACE: these are fixed-size fields, so nothing shifts and the mfra
 * seek index stays valid. Any structural surprise → return the blob as-is.
 */
export async function patchMp4Duration(blob: Blob, durationMs: number): Promise<Blob> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const durSec = durationMs / 1000;

    let moov: { s: number; cs: number; e: number } | null = null;
    eachChildBox(buf, dv, 0, buf.length, (type, s, cs, e) => {
      if (type === "moov") moov = { s, cs, e };
    });
    if (!moov) return blob;
    const { cs: moovContent, e: moovEnd } = moov;

    // movie timescale from mvhd (needed for mvhd + every tkhd duration)
    let movieTs = 0;
    eachChildBox(buf, dv, moovContent, moovEnd, (type, _s, cs) => {
      if (type === "mvhd") {
        const v = buf[cs];
        movieTs = v === 1 ? dv.getUint32(cs + 20) : dv.getUint32(cs + 12);
      }
    });
    if (!movieTs) return blob;

    // mvhd/mdhd share a layout: duration at cs+16 (v0, u32) or cs+24 (v1, u64)
    const writeMvhdLike = (cs: number, ts: number) => {
      if (!ts) return;
      const val = Math.round(durSec * ts);
      if (buf[cs] === 1) dv.setBigUint64(cs + 24, BigInt(val));
      else dv.setUint32(cs + 16, val >>> 0);
    };
    // tkhd: duration at cs+20 (v0, u32) or cs+28 (v1, u64), movie timescale
    const writeTkhd = (cs: number) => {
      const val = Math.round(durSec * movieTs);
      if (buf[cs] === 1) dv.setBigUint64(cs + 28, BigInt(val));
      else dv.setUint32(cs + 20, val >>> 0);
    };

    eachChildBox(buf, dv, moovContent, moovEnd, (type, s, cs, e) => {
      if (type === "mvhd") {
        writeMvhdLike(cs, movieTs);
      } else if (type === "trak") {
        eachChildBox(buf, dv, s + 8, e, (t2, s2, cs2, e2) => {
          if (t2 === "tkhd") {
            writeTkhd(cs2);
          } else if (t2 === "mdia") {
            eachChildBox(buf, dv, s2 + 8, e2, (t3, _s3, cs3) => {
              if (t3 === "mdhd") {
                const v = buf[cs3];
                const mediaTs = v === 1 ? dv.getUint32(cs3 + 20) : dv.getUint32(cs3 + 12);
                writeMvhdLike(cs3, mediaTs);
              }
            });
          }
        });
      }
    });

    return new Blob([buf], { type: blob.type });
  } catch {
    return blob;
  }
}

/** All post-recording container fixes in one place. */
export async function finalizeVideoBlob(
  blob: Blob,
  durationMs: number,
  fix: Fix | null
): Promise<Blob> {
  if (blob.type.includes("mp4")) {
    let out = blob;
    if (durationMs > 0) out = await patchMp4Duration(out, durationMs);
    if (fix) out = await injectMp4Location(out, fix.lat, fix.lng);
    return out;
  }
  if (blob.type.includes("webm") && durationMs > 0) {
    try {
      return await fixWebmDuration(blob, durationMs, { logger: false });
    } catch {
      return blob;
    }
  }
  return blob;
}
