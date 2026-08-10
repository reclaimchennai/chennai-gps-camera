/**
 * Export the bundled on-device ML assets as one shareable .zip
 * (§ settings).
 *
 * Nothing here is trained on the phone — these are the same files for
 * every install (MediaPipe face + pose, the MediaPipe wasm runtime, and
 * the Tesseract OCR data). They are worth exporting anyway: together they
 * are the bulk of the app, they are what makes face blur and plate OCR
 * work with no network at all, and handing them to someone on a metered
 * or absent connection is otherwise impossible.
 *
 * The archive is written with STORE (no compression) deliberately: every
 * member is already a compressed binary, so deflating them would burn
 * phone CPU for roughly nothing. That also keeps this dependency-free —
 * a stored zip is a header, the bytes, and a central directory.
 */

/** CRC-32, table built once on first use. */
let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array<ArrayBuffer>): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface Member {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  crc: number;
  offset: number;
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

/** Build a STORE-only zip. Parts stay separate so the bytes are never copied. */
export function makeStoredZip(
  entries: { name: string; bytes: Uint8Array<ArrayBuffer> }[]
): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const members: Member[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const local = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, // local file header
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(0), // method: store
      ...u16(0), ...u16(0), // mod time/date (zeroed — reproducible)
      ...u32(crc),
      ...u32(e.bytes.length), // compressed size
      ...u32(e.bytes.length), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra length
      ...nameBytes,
    ]);
    parts.push(local, e.bytes);
    members.push({ name: e.name, bytes: e.bytes, crc, offset });
    offset += local.length + e.bytes.length;
  }

  const dirStart = offset;
  let dirSize = 0;
  for (const m of members) {
    const nameBytes = enc.encode(m.name);
    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, // central directory header
      ...u16(20), ...u16(20),
      ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(m.crc),
      ...u32(m.bytes.length),
      ...u32(m.bytes.length),
      ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), // external attrs
      ...u32(m.offset),
      ...nameBytes,
    ]);
    parts.push(central);
    dirSize += central.length;
  }

  parts.push(
    new Uint8Array([
      0x50, 0x4b, 0x05, 0x06, // end of central directory
      ...u16(0), ...u16(0),
      ...u16(members.length), ...u16(members.length),
      ...u32(dirSize),
      ...u32(dirStart),
      ...u16(0),
    ])
  );

  return new Blob(parts, { type: "application/zip" });
}

/**
 * The assets to ship. Paths are relative to the app root and are fetched
 * from the app's own origin — inside the APK that is the bundled copy, so
 * this works with no network.
 */
export const MODEL_ASSETS: string[] = [
  "models/blaze_face_short_range.tflite",
  "models/pose_landmarker_lite.task",
  "mediapipe/wasm/vision_wasm_internal.js",
  "mediapipe/wasm/vision_wasm_internal.wasm",
  "mediapipe/wasm/vision_wasm_nosimd_internal.js",
  "mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  // OCR needs its worker and core as well as the language data — the
  // traineddata alone cannot run anything. Note the .gz: that is the file
  // Tesseract actually fetches (see detect/plates.ts langPath).
  "ocr/eng.traineddata.gz",
  "ocr/worker.min.js",
  "ocr/tesseract-core-simd-lstm.wasm.js",
  "ocr/tesseract-core-lstm.wasm.js",
];

export interface ModelPackProgress {
  done: number;
  total: number;
  file: string;
}

/** Re-gzip bytes, or null where CompressionStream isn't available. */
async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const CS = (globalThis as { CompressionStream?: typeof CompressionStream })
      .CompressionStream;
    if (!CS) return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new CS("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Fetch every bundled model asset and zip them.
 *
 * A missing asset is skipped rather than fatal — the wasm variants differ
 * between builds, and a pack of six useful files beats an error.
 */
export async function buildModelPack(
  onProgress?: (p: ModelPackProgress) => void
): Promise<{ blob: Blob; included: string[]; missing: string[] }> {
  const base = new URL(".", document.baseURI).href;
  const entries: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
  const missing: string[] = [];
  let done = 0;

  for (const path of MODEL_ASSETS) {
    done++;
    onProgress?.({ done, total: MODEL_ASSETS.length, file: path });
    try {
      const res = await fetch(new URL(path, base).href);
      if (!res.ok) {
        missing.push(path);
        continue;
      }
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) {
        missing.push(path);
        continue;
      }
      let name = path;
      // A .gz asset is served with Content-Encoding: gzip by most static
      // servers, and fetch() ALWAYS decodes that transparently — so what
      // arrives here is the decompressed file under a .gz name. Shipping
      // that would hand someone a mislabelled, unusable asset (Tesseract
      // asks for eng.traineddata.gz). Put the gzip wrapper back; if the
      // platform can't, at least stop lying about the name.
      if (path.endsWith(".gz") && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
        const recompressed = await gzip(bytes);
        if (recompressed) bytes = recompressed;
        else name = path.slice(0, -3);
      }
      entries.push({ name: `gpscam-models/${name}`, bytes });
    } catch {
      missing.push(path);
    }
  }

  entries.push({
    name: "gpscam-models/README.txt",
    bytes: new TextEncoder().encode(
      [
        "Chennai GPS Camera — on-device model files",
        "",
        "These are the models the app uses for face detection (blur),",
        "pose landmarks and licence-plate OCR. Everything runs on the",
        "device; none of these files phone home.",
        "",
        "They are identical for every install — this archive exists so",
        "they can be shared without a download. Drop the folders into a",
        "self-hosted copy of the app under public/.",
        "",
        "MediaPipe tasks-vision: Apache-2.0.  Tesseract data: Apache-2.0.",
      ].join("\n")
    ),
  });

  return { blob: makeStoredZip(entries), included: entries.map((e) => e.name), missing };
}
