/**
 * Container-level fixes applied to every saved/exported video so the
 * file behaves properly OUTSIDE this app (phone galleries, editors,
 * Google Photos).
 *
 * Every step here works on Blob SLICES and never reads a whole recording
 * into memory. The previous versions each began with blob.arrayBuffer()
 * — a gigabyte for ten minutes — and made further full copies, which is
 * what killed the app at the end of long recordings and lost them. See
 * remux.ts for the full account.
 *
 *
 *  - MP4: inject the standard ISO-6709 location atom (moov/udta/©xyz) —
 *    the same field phone cameras write, which gallery apps read as the
 *    video's location. MP4 recordings are preferred when the browser
 *    supports them (better compatibility than webm everywhere).
 *  - WebM (fallback): MediaRecorder famously writes no Duration header,
 *    which makes players show a blank length and some editors call the
 *    file corrupted — patch it in with the measured duration.
 */
import { remuxFragmentedMp4, scanTopLevel } from "./remux";
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

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;

/** An EBML variable-length integer. Element IDs keep their marker bit;
 *  sizes do not, and a size of all ones means "unknown" (live streams). */
function readVint(
  b: Uint8Array,
  p: number,
  keepMarker: boolean
): { value: number; length: number; unknown: boolean } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length++;
  }
  if (length > 8 || p + length > b.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function encodeVint(value: number, length: number): Uint8Array | null {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

/**
 * MediaRecorder writes WebM with no Duration, so players show a blank
 * length and some editors call the file corrupt. This writes one into the
 * Info element, reading only the first megabyte of the file — the old
 * library read all of it.
 */
export async function fixWebmDurationBounded(blob: Blob, durationMs: number): Promise<Blob> {
  try {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 20)).arrayBuffer());
    const el = (p: number) => {
      const id = readVint(head, p, true);
      if (!id) return null;
      const size = readVint(head, p + id.length, false);
      if (!size) return null;
      return { id: id.value, idLen: id.length, size, data: p + id.length + size.length };
    };
    const ebml = el(0);
    if (!ebml || ebml.id !== ID_EBML || ebml.size.unknown) return blob;
    const segAt = ebml.data + ebml.size.value;
    const seg = el(segAt);
    if (!seg || seg.id !== ID_SEGMENT) return blob;

    // find Info among the Segment's first children
    let p = seg.data;
    let info: NonNullable<ReturnType<typeof el>> | null = null;
    let infoStart = 0;
    while (p < head.length) {
      const c = el(p);
      if (!c) return blob;
      if (c.id === ID_INFO) {
        info = c;
        infoStart = p;
        break;
      }
      if (c.id === ID_CLUSTER || c.size.unknown) return blob; // past the header
      p = c.data + c.size.value;
    }
    if (!info || info.size.unknown) return blob;
    const infoEnd = info.data + info.size.value;
    if (infoEnd > head.length) return blob;

    let scale = 1_000_000;
    const kept: Uint8Array[] = [];
    let q = info.data;
    while (q < infoEnd) {
      const c = el(q);
      if (!c) return blob;
      const end = c.data + c.size.value;
      if (c.id === ID_TIMECODE_SCALE) {
        let v = 0;
        for (let i = c.data; i < end; i++) v = v * 256 + head[i];
        if (v > 0) scale = v;
      }
      if (c.id !== ID_DURATION) kept.push(head.slice(q, end));
      q = end;
    }
    // Duration is a float in TimecodeScale units (nanoseconds / scale)
    const dur = new Uint8Array(11);
    dur[0] = 0x44;
    dur[1] = 0x89;
    dur[2] = 0x88; // size 8
    new DataView(dur.buffer).setFloat64(3, (durationMs * 1e6) / scale);
    kept.push(dur);
    let bodyLen = 0;
    for (const k of kept) bodyLen += k.length;
    const sizeVint = encodeVint(bodyLen, 8);
    if (!sizeVint) return blob;
    const newInfo = new Uint8Array(4 + sizeVint.length + bodyLen);
    newInfo.set(head.subarray(infoStart, infoStart + info.idLen), 0);
    newInfo.set(sizeVint, info.idLen);
    let o = info.idLen + sizeVint.length;
    for (const k of kept) {
      newInfo.set(k, o);
      o += k.length;
    }
    const delta = newInfo.length - (infoEnd - infoStart);

    // a Segment of known size must grow by the same amount, in the same
    // number of bytes — MediaRecorder's is "unknown", which needs nothing
    const before = head.slice(0, infoStart);
    if (!seg.size.unknown) {
      const fresh = encodeVint(seg.size.value + delta, seg.size.length);
      if (!fresh) return blob;
      before.set(fresh, segAt + seg.idLen);
    }
    return new Blob([before, newInfo, blob.slice(infoEnd)], { type: blob.type });
  } catch {
    return blob;
  }
}

/**
 * Fallback for an MP4 the remuxer will not rebuild: write the measured
 * duration into moov IN PLACE. Fixed-size fields, so nothing after the
 * moov shifts, and only the moov is ever read.
 */
async function patchMp4DurationBounded(blob: Blob, durationMs: number): Promise<Blob> {
  try {
    const scan = await scanTopLevel(blob);
    const moov = scan?.boxes.find((b) => b.type === "moov");
    if (!moov?.bytes || moov.header !== 8) return blob;
    const buf = moov.bytes.slice();
    const dv = new DataView(buf.buffer);
    const durSec = durationMs / 1000;
    const kids = (start: number, end: number) => {
      const out: { type: string; s: number; e: number }[] = [];
      let off = start;
      while (off + 8 <= end) {
        const size = dv.getUint32(off);
        if (size < 8 || off + size > end) break;
        out.push({ type: String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]), s: off, e: off + size });
        off += size;
      }
      return out;
    };
    const top = kids(8, buf.length);
    const mvhd = top.find((k) => k.type === "mvhd");
    if (!mvhd) return blob;
    const ts = (cs: number) => (buf[cs] === 1 ? dv.getUint32(cs + 20) : dv.getUint32(cs + 12));
    const movieTs = ts(mvhd.s + 8);
    if (!movieTs) return blob;
    const put = (cs: number, at0: number, at1: number, val: number) => {
      if (buf[cs] === 1) dv.setBigUint64(cs + at1, BigInt(Math.round(val)));
      else dv.setUint32(cs + at0, Math.round(val) >>> 0);
    };
    put(mvhd.s + 8, 16, 24, durSec * movieTs);
    for (const trak of top.filter((k) => k.type === "trak")) {
      for (const k of kids(trak.s + 8, trak.e)) {
        if (k.type === "tkhd") put(k.s + 8, 20, 28, durSec * movieTs);
        if (k.type === "mdia") {
          for (const m of kids(k.s + 8, k.e)) {
            if (m.type === "mdhd") put(m.s + 8, 16, 24, durSec * ts(m.s + 8));
          }
        }
      }
    }
    return new Blob([blob.slice(0, moov.start), buf, blob.slice(moov.end)], { type: blob.type });
  } catch {
    return blob;
  }
}

/** All post-recording container fixes in one place, in bounded memory. */
export async function finalizeVideoBlob(
  blob: Blob,
  durationMs: number,
  fix: Fix | null
): Promise<Blob> {
  if (blob.type.includes("mp4")) {
    // Fragmented -> progressive, with real durations and the GPS atom
    // written into the rebuilt moov: editors and social-media trimmers
    // index samples from it, and galleries read the location from it.
    const progressive = await remuxFragmentedMp4(blob, {
      durationMs,
      fix: fix ? { lat: fix.lat, lng: fix.lng } : null,
    });
    if (progressive) return progressive;
    return durationMs > 0 ? patchMp4DurationBounded(blob, durationMs) : blob;
  }
  if (blob.type.includes("webm") && durationMs > 0) {
    return fixWebmDurationBounded(blob, durationMs);
  }
  return blob;
}
