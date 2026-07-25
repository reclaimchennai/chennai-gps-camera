/**
 * Fragmented MP4 → progressive MP4 remuxer.
 *
 * MediaRecorder (Chromium, every platform) writes FRAGMENTED MP4:
 *   ftyp | moov (mvex, empty sample tables) | moof+mdat | moof+mdat | …
 * Players stream that fine, which is why a full upload always worked. But
 * editors and social-media trimmers index samples from the moov's sample
 * tables (stts/stsz/stsc/stco/stss) — a fragmented file has none, so
 * "trim and upload" silently posted the whole clip with a corrupted tail,
 * and Google Photos refused to edit it at all.
 *
 * This rebuilds the file the way a camera app writes it:
 *   ftyp | moov (real sample tables, no mvex) | one contiguous mdat
 * Sample data is copied verbatim — no re-encoding, so it is fast and
 * lossless; only the container's index is rewritten.
 *
 * Everything is best-effort: any structural surprise returns null and the
 * caller keeps the original file rather than risking a broken video.
 */

interface Box {
  type: string;
  start: number; // box start (header)
  content: number; // first byte after the header
  end: number; // exclusive
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
  /** trak box from the init moov, reused wholesale except its stbl */
  trak: Box;
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

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function box(type: string, ...payloads: number[][]): number[] {
  const body = payloads.flat();
  const size = 8 + body.length;
  return [...u32(size), ...[...type].map((c) => c.charCodeAt(0)), ...body];
}

/** full box header: version 0, flags 0 */
const FULL = [0, 0, 0, 0];

export async function remuxFragmentedMp4(blob: Blob): Promise<Blob | null> {
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const top = readBoxes(dv, 0, buf.length);

    const ftyp = find(top, "ftyp");
    const moov = find(top, "moov");
    const moofs = top.filter((b) => b.type === "moof");
    if (!ftyp || !moov || moofs.length === 0) return null; // not fragmented

    const moovKids = readBoxes(dv, moov.content, moov.end);
    const mvhd = find(moovKids, "mvhd");
    const traks = moovKids.filter((b) => b.type === "trak");
    if (!mvhd || !traks.length) return null;

    // ---- trex defaults (per track), from mvex -------------------------
    const mvex = find(moovKids, "mvex");
    const trexDefaults = new Map<
      number,
      { dur: number; size: number; flags: number }
    >();
    if (mvex) {
      for (const trex of readBoxes(dv, mvex.content, mvex.end)) {
        if (trex.type !== "trex") continue;
        const c = trex.content;
        trexDefaults.set(dv.getUint32(c + 4), {
          dur: dv.getUint32(c + 12),
          size: dv.getUint32(c + 16),
          flags: dv.getUint32(c + 20),
        });
      }
    }

    // ---- collect samples from every moof ------------------------------
    const tracks = new Map<number, TrackAcc>();
    for (const trak of traks) {
      const tkhd = find(readBoxes(dv, trak.content, trak.end), "tkhd");
      if (!tkhd) return null;
      const version = dv.getUint8(tkhd.content);
      const id = dv.getUint32(tkhd.content + (version === 1 ? 20 : 12));
      tracks.set(id, { id, samples: [], trak });
    }

    for (const moof of moofs) {
      for (const traf of readBoxes(dv, moof.content, moof.end)) {
        if (traf.type !== "traf") continue;
        const trafKids = readBoxes(dv, traf.content, traf.end);
        const tfhd = find(trafKids, "tfhd");
        if (!tfhd) continue;
        const tfFlags = dv.getUint32(tfhd.content) & 0xffffff;
        let p = tfhd.content + 4;
        const trackId = dv.getUint32(p);
        p += 4;
        let baseDataOffset = moof.start; // default-base-is-moof
        if (tfFlags & 0x000001) {
          baseDataOffset = Number(dv.getBigUint64(p));
          p += 8;
        }
        if (tfFlags & 0x000002) p += 4; // sample-description-index
        const defaults = trexDefaults.get(trackId) ?? { dur: 0, size: 0, flags: 0 };
        let defDur = defaults.dur;
        let defSize = defaults.size;
        let defFlags = defaults.flags;
        if (tfFlags & 0x000008) {
          defDur = dv.getUint32(p);
          p += 4;
        }
        if (tfFlags & 0x000010) {
          defSize = dv.getUint32(p);
          p += 4;
        }
        if (tfFlags & 0x000020) {
          defFlags = dv.getUint32(p);
          p += 4;
        }

        const acc = tracks.get(trackId);
        if (!acc) continue;

        for (const trun of trafKids) {
          if (trun.type !== "trun") continue;
          const trFlags = dv.getUint32(trun.content) & 0xffffff;
          const trVersion = dv.getUint8(trun.content);
          let q = trun.content + 4;
          const count = dv.getUint32(q);
          q += 4;
          let dataOffset = 0;
          if (trFlags & 0x000001) {
            dataOffset = dv.getInt32(q);
            q += 4;
          }
          let firstFlags = 0;
          const hasFirstFlags = Boolean(trFlags & 0x000004);
          if (hasFirstFlags) {
            firstFlags = dv.getUint32(q);
            q += 4;
          }
          let cursor = baseDataOffset + dataOffset;
          for (let i = 0; i < count; i++) {
            let dur = defDur;
            let size = defSize;
            let flags = i === 0 && hasFirstFlags ? firstFlags : defFlags;
            let cts = 0;
            if (trFlags & 0x000100) {
              dur = dv.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000200) {
              size = dv.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000400) {
              flags = dv.getUint32(q);
              q += 4;
            }
            if (trFlags & 0x000800) {
              cts = trVersion === 0 ? dv.getUint32(q) : dv.getInt32(q);
              q += 4;
            }
            // sample_depends_on == 2 (or non-sync flag clear) means sync
            const nonSync = (flags & 0x00010000) !== 0;
            acc.samples.push({
              offset: cursor,
              size,
              duration: dur,
              cts,
              sync: !nonSync,
            });
            cursor += size;
          }
        }
      }
    }

    const active = [...tracks.values()].filter((t) => t.samples.length);
    if (!active.length) return null;

    // ---- lay out one contiguous mdat ---------------------------------
    // Samples are written track by track (chunk-per-track), which keeps
    // the tables simple and is perfectly legal; players and editors index
    // via stco/stsc regardless of interleaving.
    let mdatSize = 0;
    for (const t of active) for (const s of t.samples) mdatSize += s.size;

    const mdatHeaderSize = 8;

    // ftyp verbatim
    const ftypBytes = Array.from(buf.subarray(ftyp.start, ftyp.end));

    // ---- rebuild each trak with real sample tables --------------------
    const trakBytes: number[][] = [];
    // mdat payload starts after ftyp + moov, but moov's size depends on
    // the tables — so build tables with placeholder chunk offsets first,
    // then patch them once the final moov size is known.
    const chunkOffsetPatch: { arrIndex: number; byteIndex: number; rel: number }[] =
      [];
    let relOffset = 0; // offset within the mdat payload

    for (const t of active) {
      const trakKids = readBoxes(dv, t.trak.content, t.trak.end);
      const tkhd = find(trakKids, "tkhd");
      const mdia = find(trakKids, "mdia");
      if (!tkhd || !mdia) return null;
      const mdiaKids = readBoxes(dv, mdia.content, mdia.end);
      const mdhd = find(mdiaKids, "mdhd");
      const hdlr = find(mdiaKids, "hdlr");
      const minf = find(mdiaKids, "minf");
      if (!mdhd || !hdlr || !minf) return null;
      const minfKids = readBoxes(dv, minf.content, minf.end);
      const stbl = find(minfKids, "stbl");
      if (!stbl) return null;
      const stsd = find(readBoxes(dv, stbl.content, stbl.end), "stsd");
      if (!stsd) return null;

      const total = t.samples.reduce((a, s) => a + s.duration, 0);

      // stts — run-length encoded durations
      const stts: number[][] = [];
      let runCount = 0;
      let runDur = -1;
      for (const s of t.samples) {
        if (s.duration === runDur) runCount++;
        else {
          if (runDur >= 0) stts.push([...u32(runCount), ...u32(runDur)]);
          runDur = s.duration;
          runCount = 1;
        }
      }
      if (runDur >= 0) stts.push([...u32(runCount), ...u32(runDur)]);

      // ctts — only when any composition offset is non-zero
      const anyCts = t.samples.some((s) => s.cts !== 0);
      const cttsEntries: number[][] = [];
      if (anyCts) {
        let cCount = 0;
        let cVal: number | null = null;
        for (const s of t.samples) {
          if (s.cts === cVal) cCount++;
          else {
            if (cVal !== null) cttsEntries.push([...u32(cCount), ...u32(cVal >>> 0)]);
            cVal = s.cts;
            cCount = 1;
          }
        }
        if (cVal !== null) cttsEntries.push([...u32(cCount), ...u32(cVal >>> 0)]);
      }

      // stsz — explicit size per sample
      const stszBody = [
        ...FULL,
        ...u32(0), // sample_size 0 = per-sample table follows
        ...u32(t.samples.length),
        ...t.samples.flatMap((s) => u32(s.size)),
      ];

      // one chunk holding all this track's samples
      const stscBody = [
        ...FULL,
        ...u32(1),
        ...u32(1), // first_chunk
        ...u32(t.samples.length), // samples_per_chunk
        ...u32(1), // sample_description_index
      ];

      // stco — patched after the moov size is known
      const stcoBody = [...FULL, ...u32(1), ...u32(0)];

      // stss — sync sample list (omit when every sample is a keyframe)
      const syncIdx: number[] = [];
      t.samples.forEach((s, i) => {
        if (s.sync) syncIdx.push(i + 1);
      });
      const allSync = syncIdx.length === t.samples.length;

      const stblChildren = [
        Array.from(buf.subarray(stsd.start, stsd.end)),
        box("stts", FULL, u32(stts.length), stts.flat()),
        ...(anyCts
          ? [box("ctts", FULL, u32(cttsEntries.length), cttsEntries.flat())]
          : []),
        box("stsc", stscBody),
        box("stsz", stszBody),
        box("stco", stcoBody),
        ...(allSync ? [] : [box("stss", FULL, u32(syncIdx.length), syncIdx.flatMap(u32))]),
      ];
      const stblBox = box("stbl", stblChildren.flat());

      // minf keeps its own children (vmhd/smhd, dinf) with the new stbl
      const minfChildren: number[][] = [];
      for (const k of minfKids) {
        if (k.type === "stbl") minfChildren.push(stblBox);
        else minfChildren.push(Array.from(buf.subarray(k.start, k.end)));
      }
      const minfBox = box("minf", minfChildren.flat());

      // mdhd with the real duration (keep version/timescale as-is)
      const mdhdBytes = Array.from(buf.subarray(mdhd.start, mdhd.end));
      {
        const v = mdhdBytes[8];
        if (v === 1) {
          // 64-bit duration at content+24 → array index 8 + 24
          const hi = Math.floor(total / 2 ** 32);
          const lo = total >>> 0;
          mdhdBytes.splice(8 + 24, 8, ...u32(hi), ...u32(lo));
        } else {
          mdhdBytes.splice(8 + 16, 4, ...u32(total));
        }
      }

      const mdiaChildren: number[][] = [];
      for (const k of mdiaKids) {
        if (k.type === "mdhd") mdiaChildren.push(mdhdBytes);
        else if (k.type === "minf") mdiaChildren.push(minfBox);
        else mdiaChildren.push(Array.from(buf.subarray(k.start, k.end)));
      }
      const mdiaBox = box("mdia", mdiaChildren.flat());

      const trakChildren: number[][] = [];
      for (const k of trakKids) {
        if (k.type === "mdia") trakChildren.push(mdiaBox);
        else trakChildren.push(Array.from(buf.subarray(k.start, k.end)));
      }
      const trakBox = box("trak", trakChildren.flat());

      // remember where this track's stco value sits so it can be patched
      // once the moov length is final
      const idx = trakBytes.length;
      const stcoValueIndex = trakBox.length - findStcoTailOffset(trakBox);
      chunkOffsetPatch.push({
        arrIndex: idx,
        byteIndex: stcoValueIndex,
        rel: relOffset,
      });
      relOffset += t.samples.reduce((a, s) => a + s.size, 0);
      trakBytes.push(trakBox);
    }

    // mvhd verbatim (its duration was already patched by finalizeVideoBlob)
    const mvhdBytes = Array.from(buf.subarray(mvhd.start, mvhd.end));
    // Carry over EVERY other moov child (udta — where the ISO-6709 GPS
    // atom lives — plus meta, etc.), dropping only mvex, the marker that
    // declares the file fragmented. Note there can be MORE THAN ONE udta:
    // MediaRecorder writes one and the GPS injection appends another, so
    // picking "the" udta would silently drop the coordinates. The atom is
    // injected BEFORE this remux on purpose: doing it after would grow
    // moov and invalidate every chunk offset computed here.
    const extras = moovKids
      .filter((k) => !["mvhd", "trak", "mvex"].includes(k.type))
      .map((k) => Array.from(buf.subarray(k.start, k.end)));
    const moovBox = box("moov", [mvhdBytes, ...trakBytes, ...extras].flat());

    const mdatStart = ftypBytes.length + moovBox.length + mdatHeaderSize;
    // patch each stco to the absolute offset of its track's first sample
    for (const p of chunkOffsetPatch) {
      const arr = trakBytes[p.arrIndex];
      const abs = mdatStart + p.rel;
      arr.splice(p.byteIndex, 4, ...u32(abs));
    }
    // rebuild moov with patched offsets (same length, so mdatStart holds)
    const moovFinal = box("moov", [mvhdBytes, ...trakBytes, ...extras].flat());
    if (moovFinal.length !== moovBox.length) return null;

    // ---- assemble without copying the payload ------------------------
    // Sample data is emitted as Blob SLICES of the source, not as a second
    // in-memory buffer: a long recording can be hundreds of MB, and a full
    // extra copy would OOM the budget phones this app targets. Adjacent
    // samples (the common case inside a fragment) are coalesced into one
    // slice, so a 10-minute clip costs a few hundred slice references
    // rather than a few hundred MB.
    const mdatTotal = mdatHeaderSize + mdatSize;
    const blobParts: BlobPart[] = [
      new Uint8Array(ftypBytes),
      new Uint8Array(moovFinal),
      new Uint8Array([
        ...u32(mdatTotal),
        ...[..."mdat"].map((c) => c.charCodeAt(0)),
      ]),
    ];
    let runStart = -1;
    let runEnd = -1;
    const flushRun = () => {
      if (runStart >= 0) blobParts.push(blob.slice(runStart, runEnd));
      runStart = -1;
      runEnd = -1;
    };
    let written = 0;
    for (const t of active) {
      for (const s of t.samples) {
        if (runStart >= 0 && s.offset === runEnd) {
          runEnd += s.size;
        } else {
          flushRun();
          runStart = s.offset;
          runEnd = s.offset + s.size;
        }
        written += s.size;
      }
    }
    flushRun();
    if (written !== mdatSize) return null;

    return new Blob(blobParts, { type: "video/mp4" });
  } catch {
    return null; // any surprise: keep the original file
  }
}

/** Distance from the END of a built trak to its stco entry value. The
 *  stco box is emitted with a fixed tail layout, so this is stable. */
function findStcoTailOffset(trak: number[]): number {
  // search backwards for the 'stco' type marker
  for (let i = trak.length - 4; i >= 4; i--) {
    if (
      trak[i] === 0x73 && // s
      trak[i + 1] === 0x74 && // t
      trak[i + 2] === 0x63 && // c
      trak[i + 3] === 0x6f // o
    ) {
      // layout: [size][stco][version+flags(4)][entry_count(4)][offset(4)]
      const valueIndex = i + 4 + 4 + 4;
      return trak.length - valueIndex;
    }
  }
  return 0;
}
