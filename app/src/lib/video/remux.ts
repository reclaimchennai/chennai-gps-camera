/**
 * Fragmented MP4 → progressive MP4, without ever holding the file.
 *
 * MediaRecorder (Chromium, every platform) writes FRAGMENTED MP4:
 *   ftyp | moov (mvex, empty sample tables) | moof+mdat | moof+mdat | …
 * Players stream that fine, but editors and social-media trimmers index
 * samples from the moov's sample tables (stts/stsz/stsc/stco/stss) — a
 * fragmented file has none, so "trim and upload" posted a corrupted tail
 * and Google Photos refused to edit at all. This rebuilds the file the
 * way a camera app writes it:
 *   ftyp | moov (real sample tables, no mvex) | one contiguous mdat
 *
 * MEMORY IS THE POINT OF THIS VERSION. The previous one began with
 * `new Uint8Array(await blob.arrayBuffer())` — the whole recording in
 * memory, to parse a few kilobytes of box headers — and the steps before
 * it each made another full copy. A ten-minute recording is around a
 * gigabyte, so finishing one asked a phone for several gigabytes at once,
 * the WebView was killed, and because nothing had reached storage yet the
 * video was simply gone. Motorola users reported exactly that.
 *
 * Now the file is walked by its box headers through a small moving
 * window: one read per fragment, jumping over each mdat. Only ftyp, moov
 * and the moofs (a few kilobytes each) are ever read; sample data goes
 * out as Blob slices of the source, which the browser composes lazily on
 * disk. Peak memory is the sample TABLES, not the video.
 *
 * Durations and the GPS atom are written into the rebuilt moov directly,
 * rather than in separate passes over the whole file as before.
 *
 * Also handles two things the old version never had to, because it could
 * never get that far:
 *   - output over 4 GB (an hour at camera bitrates): 64-bit mdat header
 *     and co64 chunk offsets instead of a silently wrapped stco;
 *   - a TRUNCATED input — a recording rebuilt from chunks after the app
 *     died mid-fragment. Everything up to the last complete fragment is
 *     kept; a partial tail is dropped rather than poisoning the file.
 *
 * Any structural surprise returns null and the caller keeps the original
 * file rather than risking a broken video.
 */

interface Box {
  type: string;
  /** offsets RELATIVE to the buffer the box was parsed from */
  start: number;
  content: number;
  end: number;
}

interface TopBox {
  type: string;
  /** absolute file offsets */
  start: number;
  header: number;
  end: number;
  /** bytes of the whole box, for everything except mdat/free/skip */
  bytes?: Uint8Array<ArrayBuffer>;
}

interface Sample {
  offset: number; // absolute file offset of the sample data
  size: number;
  duration: number; // in the track's timescale
  cts: number; // composition offset (signed)
  sync: boolean;
}

interface TrackAcc {
  id: number;
  samples: Sample[];
  /** trak box from the init moov, relative to the moov bytes */
  trak: Box;
}

export interface RemuxOptions {
  /** wall-clock duration, used only if the samples carry none */
  durationMs?: number;
  /** ISO-6709 location atom, as phone cameras write it */
  fix?: { lat: number; lng: number } | null;
}

/** Read window. A moof is a few kilobytes, so this nearly always brings
 *  in the moof and the next box header in one read — one read per
 *  fragment, about 4% of a 1.5 MB fragment rather than all of it. A moof
 *  larger than this is read at exactly its own size. */
const WINDOW = 64 * 1024;
/** A metadata box bigger than this is not something MediaRecorder wrote. */
const MAX_META_BOX = 64 * 1024 * 1024;

async function readSlice(
  blob: Blob,
  start: number,
  end: number
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const fourcc = (b: Uint8Array, p: number) =>
  String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/**
 * Walk the top-level boxes by their headers.
 *
 * `complete` is false when the file ends inside a box — a recording cut
 * off mid-fragment. Every box returned is whole.
 */
export async function scanTopLevel(
  blob: Blob
): Promise<{ boxes: TopBox[]; complete: boolean } | null> {
  const boxes: TopBox[] = [];
  let win: Uint8Array<ArrayBuffer> = new Uint8Array(0);
  let winStart = 0;
  const ensure = async (start: number, len: number) => {
    if (start >= winStart && start + len <= winStart + win.length) return;
    winStart = start;
    win = await readSlice(blob, start, Math.min(blob.size, start + Math.max(WINDOW, len)));
  };

  let off = 0;
  while (off + 8 <= blob.size) {
    await ensure(off, 16);
    const p = off - winStart;
    const dv = new DataView(win.buffer, win.byteOffset, win.byteLength);
    let size = dv.getUint32(p);
    const type = fourcc(win, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > win.length) return { boxes, complete: false };
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = blob.size - off;
    }
    if (size < header) return null; // not an MP4 box stream at all
    if (off + size > blob.size) return { boxes, complete: false };
    const box: TopBox = { type, start: off, header, end: off + size };
    if (type !== "mdat" && type !== "free" && type !== "skip") {
      if (size > MAX_META_BOX) return null;
      await ensure(off, size);
      const q = off - winStart;
      // copied, so the window can move on without dragging this along
      box.bytes = win.slice(q, q + size);
    }
    boxes.push(box);
    off += size;
  }
  return { boxes, complete: off === blob.size };
}

function readBoxes(dv: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(
      dv.getUint8(off + 4),
      dv.getUint8(off + 5),
      dv.getUint8(off + 6),
      dv.getUint8(off + 7)
    );
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) break;
    out.push({ type, start: off, content: off + header, end: off + size });
    off += size;
  }
  return out;
}

const find = (boxes: Box[], type: string): Box | undefined =>
  boxes.find((b) => b.type === type);

// ---- byte building -------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function makeBox(type: string, ...children: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(children);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(body, 8);
  return out;
}

/** A full box's version+flags, then a table: `cells` u32 per entry. */
function tableBox(
  type: string,
  entries: number,
  cells: number,
  fill: (dv: DataView, at: number) => void
): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(4 + 4 + entries * cells * 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(4, entries);
  fill(dv, 8);
  return makeBox(type, body);
}

/** ISO-6709 "+13.0405+080.2337/" in moov/udta/©xyz, as phone cameras write it. */
function locationUdta(lat: number, lng: number): Uint8Array<ArrayBuffer> {
  const latStr = `${lat >= 0 ? "+" : "-"}${Math.abs(lat).toFixed(4).padStart(7, "0")}`;
  const lngStr = `${lng >= 0 ? "+" : "-"}${Math.abs(lng).toFixed(4).padStart(8, "0")}`;
  const loc = new TextEncoder().encode(`${latStr}${lngStr}/`);
  const payload = new Uint8Array(4 + loc.length);
  payload[0] = (loc.length >> 8) & 0xff;
  payload[1] = loc.length & 0xff;
  payload[2] = 0x15; // packed ISO-639 "eng"
  payload[3] = 0xc7;
  payload.set(loc, 4);
  return makeBox("udta", makeBox("\xa9xyz", payload));
}

/** Write a duration into an mvhd/mdhd (same layout) or a tkhd, in place. */
function setDuration(box: Uint8Array, kind: "mvhd" | "mdhd" | "tkhd", value: number): void {
  const dv = new DataView(box.buffer, box.byteOffset, box.byteLength);
  const cs = 8; // these are never large-size boxes
  const v1 = box[cs] === 1;
  const at = kind === "tkhd" ? (v1 ? 28 : 20) : v1 ? 24 : 16;
  if (v1) dv.setBigUint64(cs + at, BigInt(Math.round(value)));
  else dv.setUint32(cs + at, Math.min(0xffffffff, Math.round(value)) >>> 0);
}

function timescaleOf(box: Uint8Array): number {
  const dv = new DataView(box.buffer, box.byteOffset, box.byteLength);
  return box[8] === 1 ? dv.getUint32(8 + 20) : dv.getUint32(8 + 12);
}

// ---- the remux -------------------------------------------------------------

export async function remuxFragmentedMp4(
  blob: Blob,
  opts: RemuxOptions = {}
): Promise<Blob | null> {
  try {
    const scan = await scanTopLevel(blob);
    if (!scan) return null;
    const top = scan.boxes;
    const ftyp = top.find((b) => b.type === "ftyp");
    const moov = top.find((b) => b.type === "moov");
    const moofs = top.filter((b) => b.type === "moof");
    if (!ftyp?.bytes || !moov?.bytes || moofs.length === 0) return null; // not fragmented
    // Samples may only point inside whole boxes: a fragment whose mdat the
    // file ends inside is dropped, not half-kept.
    const dataEnd = top[top.length - 1].end;

    const mb = moov.bytes;
    const dvM = new DataView(mb.buffer, mb.byteOffset, mb.byteLength);
    const moovKids = readBoxes(dvM, moov.header, mb.length);
    const mvhd = find(moovKids, "mvhd");
    const traks = moovKids.filter((b) => b.type === "trak");
    if (!mvhd || !traks.length) return null;

    // ---- trex defaults (per track), from mvex -------------------------
    const mvex = find(moovKids, "mvex");
    const trexDefaults = new Map<number, { dur: number; size: number; flags: number }>();
    if (mvex) {
      for (const trex of readBoxes(dvM, mvex.content, mvex.end)) {
        if (trex.type !== "trex") continue;
        const c = trex.content;
        trexDefaults.set(dvM.getUint32(c + 4), {
          dur: dvM.getUint32(c + 12),
          size: dvM.getUint32(c + 16),
          flags: dvM.getUint32(c + 20),
        });
      }
    }

    const tracks = new Map<number, TrackAcc>();
    for (const trak of traks) {
      const tkhd = find(readBoxes(dvM, trak.content, trak.end), "tkhd");
      if (!tkhd) return null;
      const version = dvM.getUint8(tkhd.content);
      const id = dvM.getUint32(tkhd.content + (version === 1 ? 20 : 12));
      tracks.set(id, { id, samples: [], trak });
    }

    // ---- collect samples from every moof ------------------------------
    for (const moof of moofs) {
      const fb = moof.bytes!;
      const dvF = new DataView(fb.buffer, fb.byteOffset, fb.byteLength);
      for (const traf of readBoxes(dvF, moof.header, fb.length)) {
        if (traf.type !== "traf") continue;
        const trafKids = readBoxes(dvF, traf.content, traf.end);
        const tfhd = find(trafKids, "tfhd");
        if (!tfhd) continue;
        const tfFlags = dvF.getUint32(tfhd.content) & 0xffffff;
        let p = tfhd.content + 4;
        const trackId = dvF.getUint32(p);
        p += 4;
        let baseDataOffset = moof.start; // default-base-is-moof, absolute
        if (tfFlags & 0x000001) {
          baseDataOffset = Number(dvF.getBigUint64(p));
          p += 8;
        }
        if (tfFlags & 0x000002) p += 4; // sample-description-index
        const defaults = trexDefaults.get(trackId) ?? { dur: 0, size: 0, flags: 0 };
        let defDur = defaults.dur;
        let defSize = defaults.size;
        let defFlags = defaults.flags;
        if (tfFlags & 0x000008) {
          defDur = dvF.getUint32(p);
          p += 4;
        }
        if (tfFlags & 0x000010) {
          defSize = dvF.getUint32(p);
          p += 4;
        }
        if (tfFlags & 0x000020) {
          defFlags = dvF.getUint32(p);
          p += 4;
        }
        const acc = tracks.get(trackId);
        if (!acc) continue;

        for (const trun of trafKids) {
          if (trun.type !== "trun") continue;
          const trFlags = dvF.getUint32(trun.content) & 0xffffff;
          const trVersion = dvF.getUint8(trun.content);
          let q = trun.content + 4;
          const count = dvF.getUint32(q);
          q += 4;
          let dataOffset = 0;
          if (trFlags & 0x000001) {
            dataOffset = dvF.getInt32(q);
            q += 4;
          }
          let firstFlags = 0;
          const hasFirstFlags = Boolean(trFlags & 0x000004);
          if (hasFirstFlags) {
            firstFlags = dvF.getUint32(q);
            q += 4;
          }
          let cursor = baseDataOffset + dataOffset;
          for (let i = 0; i < count; i++) {
            let dur = defDur;
            let size = defSize;
            let flags = i === 0 && hasFirstFlags ? firstFlags : defFlags;
            let cts = 0;
            if (trFlags & 0x000100) {
              dur = dvF.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000200) {
              size = dvF.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000400) {
              flags = dvF.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000800) {
              cts = trVersion === 0 ? dvF.getUint32(q) : dvF.getInt32(q);
              q += 4;
            }
            // a sample past the last whole box belongs to a fragment the
            // recording was cut off inside — keep what is complete
            if (cursor + size <= dataEnd) {
              acc.samples.push({
                offset: cursor,
                size,
                duration: dur,
                cts,
                sync: (flags & 0x00010000) === 0,
              });
            }
            cursor += size;
          }
        }
      }
    }

    const active = [...tracks.values()].filter((t) => t.samples.length);
    if (!active.length) return null;

    // ---- durations ----------------------------------------------------
    const mvhdBytes = mb.slice(mvhd.start, mvhd.end);
    const movieTs = timescaleOf(mvhdBytes);
    if (!movieTs) return null;
    const mediaSeconds = new Map<number, number>();
    for (const t of active) {
      const trakKids = readBoxes(dvM, t.trak.content, t.trak.end);
      const mdia = find(trakKids, "mdia");
      if (!mdia) return null;
      const mdhd = find(readBoxes(dvM, mdia.content, mdia.end), "mdhd");
      if (!mdhd) return null;
      const ts = timescaleOf(mb.slice(mdhd.start, mdhd.end));
      const total = t.samples.reduce((a, s) => a + s.duration, 0);
      mediaSeconds.set(t.id, ts ? total / ts : 0);
    }
    let longest = Math.max(0, ...mediaSeconds.values());
    if (!longest && opts.durationMs) longest = opts.durationMs / 1000;
    setDuration(mvhdBytes, "mvhd", longest * movieTs);

    let mdatSize = 0;
    for (const t of active) for (const s of t.samples) mdatSize += s.size;
    // over 4 GB the 32-bit size and stco offsets would wrap silently
    const large = mdatSize + 16 > 0xffffffff;
    const mdatHeaderSize = large ? 16 : 8;

    // ---- per-track tables -----------------------------------------------
    // Built once, independent of where the mdat lands; only the chunk
    // offset box depends on the final moov size, so the traks are built in
    // two passes rather than patched byte-by-byte afterwards.
    const built = active.map((t) => {
      const trakKids = readBoxes(dvM, t.trak.content, t.trak.end);
      const tkhd = find(trakKids, "tkhd")!;
      const mdia = find(trakKids, "mdia")!;
      const mdiaKids = readBoxes(dvM, mdia.content, mdia.end);
      const mdhd = find(mdiaKids, "mdhd");
      const minf = find(mdiaKids, "minf");
      if (!mdhd || !minf) return null;
      const minfKids = readBoxes(dvM, minf.content, minf.end);
      const stbl = find(minfKids, "stbl");
      if (!stbl) return null;
      const stsd = find(readBoxes(dvM, stbl.content, stbl.end), "stsd");
      if (!stsd) return null;
      const n = t.samples.length;
      const total = t.samples.reduce((a, s) => a + s.duration, 0);

      // stts: run-length encoded durations
      const runs: [number, number][] = [];
      for (const s of t.samples) {
        const last = runs[runs.length - 1];
        if (last && last[1] === s.duration) last[0]++;
        else runs.push([1, s.duration]);
      }
      const stts = tableBox("stts", runs.length, 2, (dv, at) => {
        runs.forEach(([c, d], i) => {
          dv.setUint32(at + i * 8, c);
          dv.setUint32(at + i * 8 + 4, d);
        });
      });

      // ctts: only when any composition offset is non-zero
      let ctts: Uint8Array | null = null;
      if (t.samples.some((s) => s.cts !== 0)) {
        const cRuns: [number, number][] = [];
        for (const s of t.samples) {
          const last = cRuns[cRuns.length - 1];
          if (last && last[1] === s.cts) last[0]++;
          else cRuns.push([1, s.cts]);
        }
        ctts = tableBox("ctts", cRuns.length, 2, (dv, at) => {
          cRuns.forEach(([c, v], i) => {
            dv.setUint32(at + i * 8, c);
            dv.setUint32(at + i * 8 + 4, v >>> 0);
          });
        });
      }

      // stsz: sample_size 0, then one size per sample
      const stszBody = new Uint8Array(12 + n * 4);
      {
        const dv = new DataView(stszBody.buffer);
        dv.setUint32(8, n);
        t.samples.forEach((s, i) => dv.setUint32(12 + i * 4, s.size));
      }
      const stsz = makeBox("stsz", stszBody);

      // one chunk holding all of this track's samples
      const stsc = tableBox("stsc", 1, 3, (dv, at) => {
        dv.setUint32(at, 1); // first_chunk
        dv.setUint32(at + 4, n); // samples_per_chunk
        dv.setUint32(at + 8, 1); // sample_description_index
      });

      // stss: omitted when every sample is a keyframe
      const sync: number[] = [];
      t.samples.forEach((s, i) => {
        if (s.sync) sync.push(i + 1);
      });
      const stss =
        sync.length === n
          ? null
          : tableBox("stss", sync.length, 1, (dv, at) => {
              sync.forEach((v, i) => dv.setUint32(at + i * 4, v));
            });

      const mdhdBytes = mb.slice(mdhd.start, mdhd.end);
      setDuration(mdhdBytes, "mdhd", total);
      const tkhdBytes = mb.slice(tkhd.start, tkhd.end);
      setDuration(tkhdBytes, "tkhd", (mediaSeconds.get(t.id) ?? longest) * movieTs);

      const rebuild = (chunkOffset: number): Uint8Array => {
        const co = large
          ? (() => {
              const b = new Uint8Array(4 + 4 + 8);
              const dv = new DataView(b.buffer);
              dv.setUint32(4, 1);
              dv.setBigUint64(8, BigInt(chunkOffset));
              return makeBox("co64", b);
            })()
          : tableBox("stco", 1, 1, (dv, at) => dv.setUint32(at, chunkOffset));
        const stblBox = makeBox(
          "stbl",
          mb.slice(stsd.start, stsd.end),
          stts,
          ...(ctts ? [ctts] : []),
          stsc,
          stsz,
          co,
          ...(stss ? [stss] : [])
        );
        const minfBox = makeBox(
          "minf",
          ...minfKids.map((k) => (k.type === "stbl" ? stblBox : mb.slice(k.start, k.end)))
        );
        const mdiaBox = makeBox(
          "mdia",
          ...mdiaKids.map((k) =>
            k.type === "mdhd" ? mdhdBytes : k.type === "minf" ? minfBox : mb.slice(k.start, k.end)
          )
        );
        return makeBox(
          "trak",
          ...trakKids.map((k) =>
            k.type === "tkhd" ? tkhdBytes : k.type === "mdia" ? mdiaBox : mb.slice(k.start, k.end)
          )
        );
      };
      return { t, rebuild, bytes: t.samples.reduce((a, s) => a + s.size, 0) };
    });
    if (built.some((b) => b === null)) return null;
    const tracksBuilt = built as NonNullable<(typeof built)[number]>[];

    // Every other moov child carries over (udta, meta…) — except mvex,
    // which is what declares the file fragmented. Our location atom is
    // added as one more udta: there can legitimately be several.
    const extras = moovKids
      .filter((k) => !["mvhd", "trak", "mvex"].includes(k.type))
      .map((k) => mb.slice(k.start, k.end));
    if (opts.fix) extras.push(locationUdta(opts.fix.lat, opts.fix.lng));

    // pass 1 with placeholder offsets fixes the moov's length, pass 2
    // writes the real ones — the length cannot change between them
    const draft = makeBox("moov", mvhdBytes, ...tracksBuilt.map((b) => b.rebuild(0)), ...extras);
    const mdatStart = ftyp.bytes.length + draft.length + mdatHeaderSize;
    let rel = 0;
    const finalTraks = tracksBuilt.map((b) => {
      const trak = b.rebuild(mdatStart + rel);
      rel += b.bytes;
      return trak;
    });
    const moovFinal = makeBox("moov", mvhdBytes, ...finalTraks, ...extras);
    if (moovFinal.length !== draft.length) return null;

    const mdatHeader = new Uint8Array(mdatHeaderSize);
    {
      const dv = new DataView(mdatHeader.buffer);
      if (large) {
        dv.setUint32(0, 1);
        dv.setBigUint64(8, BigInt(mdatHeaderSize + mdatSize));
      } else {
        dv.setUint32(0, mdatHeaderSize + mdatSize);
      }
      for (let i = 0; i < 4; i++) mdatHeader[4 + i] = "mdat".charCodeAt(i);
    }

    // ---- assemble without copying the payload --------------------------
    // Adjacent samples (the common case inside a fragment) are coalesced
    // into one slice, so an hour costs a few thousand slice references,
    // never a second copy of the video.
    const parts: BlobPart[] = [ftyp.bytes, moovFinal, mdatHeader];
    let runStart = -1;
    let runEnd = -1;
    let written = 0;
    for (const b of tracksBuilt) {
      for (const s of b.t.samples) {
        if (runStart >= 0 && s.offset === runEnd) {
          runEnd += s.size;
        } else {
          if (runStart >= 0) parts.push(blob.slice(runStart, runEnd));
          runStart = s.offset;
          runEnd = s.offset + s.size;
        }
        written += s.size;
      }
    }
    if (runStart >= 0) parts.push(blob.slice(runStart, runEnd));
    if (written !== mdatSize) return null;

    return new Blob(parts, { type: "video/mp4" });
  } catch {
    return null; // any surprise: keep the original file
  }
}
