/**
 * EXPERIMENTAL on-device licence-plate OCR.
 *
 * Fully local: a lazily-created tesseract.js worker whose engine, wasm
 * core and English traineddata are all vendored under /ocr (nothing is
 * fetched from a CDN; excluded from the SW precache like the face
 * models). The tesseract library itself is code-split via dynamic import
 * so the main bundle stays lean when the feature is off.
 *
 * Recognition is tuned for plates: uppercase+digits whitelist, then the
 * raw text is scanned with Indian registration formats — the standard
 * `SS RR L NNNN` series and the newer Bharat `YY BH NNNN LL` series.
 * Best-effort by design: misreads happen (O/0, I/1); results are shown
 * as removable chips, never asserted as authoritative.
 */

let workerPromise: Promise<import("tesseract.js").Worker | null> | null = null;
/** why the engine failed to start, for the Settings self-test / details */
let engineError: string | null = null;

/** Turn silent hangs into reportable errors — a stalled wasm fetch or a
 *  worker that never answers used to leave scans "pending" forever. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      window.setTimeout(
        () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
        ms
      )
    ),
  ]);
}

function getWorker(): Promise<import("tesseract.js").Worker | null> {
  workerPromise ??= (async () => {
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await withTimeout(createWorker("eng", 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr/tesseract-core-simd-lstm.wasm.js",
        langPath: "/ocr", // fetches /ocr/eng.traineddata.gz
        // load the worker script DIRECTLY (same-origin) instead of the
        // default blob-URL wrapper — blob workers are unreliable in some
        // Android WebViews and were the likely cause of the reader doing
        // nothing at all on device
        workerBlobURL: false,
        errorHandler: (e: unknown) => {
          engineError = String(e).slice(0, 300);
        },
      }), 90_000, "OCR engine start");
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.",
      });
      engineError = null;
      return worker;
    } catch (e) {
      engineError = String(e).slice(0, 300);
      // allow a later retry (a transient fetch failure shouldn't wedge
      // the engine for the whole session)
      workerPromise = null;
      return null;
    }
  })();
  return workerPromise;
}

// standard: TN 09 AB 1234 (letters section optional-length, 3–4 digits)
const STD = /\b([A-Z]{2})[ .-]?(\d{1,2})[ .-]?([A-Z]{1,3})[ .-]?(\d{3,4})\b/g;
// Bharat series: 22 BH 1234 AA
const BH = /\b(\d{2})[ .-]?(BH)[ .-]?(\d{4})[ .-]?([A-Z]{1,2})\b/g;

/** Pull normalized plate strings out of raw OCR text. */
export function extractPlates(text: string): string[] {
  const up = text.toUpperCase();
  const found = new Set<string>();
  for (const m of up.matchAll(STD)) {
    found.add(`${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  }
  for (const m of up.matchAll(BH)) {
    found.add(`${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  }
  return [...found];
}

/** OCR an image and return any licence plates found (may be several).
 *  THROWS when the engine itself is unavailable/broken, so callers can
 *  record the failure instead of mistaking it for "no plates found". */
/** Downscale big inputs before OCR: recognising a full-resolution photo
 *  in a phone WebView can take minutes and looks exactly like a hang.
 *  ~1600px keeps plate glyphs comfortably readable at a fraction of the
 *  cost and memory. */
async function ocrSource(
  image: Blob | HTMLCanvasElement
): Promise<HTMLCanvasElement> {
  const MAX = 1600;
  const bmp =
    image instanceof Blob ? await createImageBitmap(image) : null;
  const sw = bmp ? bmp.width : (image as HTMLCanvasElement).width;
  const sh = bmp ? bmp.height : (image as HTMLCanvasElement).height;
  const scale = Math.min(1, MAX / Math.max(sw, sh));
  if (!bmp && scale === 1) return image as HTMLCanvasElement;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  c.getContext("2d")?.drawImage(bmp ?? (image as HTMLCanvasElement), 0, 0, c.width, c.height);
  bmp?.close();
  return c;
}

export async function detectPlates(
  image: Blob | HTMLCanvasElement
): Promise<string[]> {
  const worker = await getWorker();
  if (!worker) {
    throw new Error(engineError ?? "OCR engine failed to start");
  }
  const src = await ocrSource(image);
  const { data } = await withTimeout(
    worker.recognize(src),
    90_000,
    "OCR recognition"
  );
  return extractPlates(data.text ?? "");
}

/** Warm the engine in the background (called when the setting turns on)
 *  so the first real scan isn't also the multi-MB engine download. */
export function warmPlateReader(): void {
  void getWorker();
}

/** Settings self-test: OCR a synthetic plate and report exactly what
 *  happened — proves the whole engine path works on THIS device. */
export async function testPlateReader(): Promise<{
  ok: boolean;
  detail: string;
}> {
  try {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 200;
    const x = c.getContext("2d");
    if (!x) return { ok: false, detail: "canvas unavailable" };
    x.fillStyle = "#fff";
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#111";
    x.font = "bold 72px sans-serif";
    x.fillText("TN 09 AB 1234", 40, 120);
    const plates = await detectPlates(c);
    return plates.includes("TN 09 AB 1234")
      ? { ok: true, detail: "Working — read the test plate correctly" }
      : {
          ok: false,
          detail: `Engine runs but misread the test plate (${plates.join(", ") || "nothing"})`,
        };
  } catch (e) {
    return { ok: false, detail: `Engine error: ${String(e).slice(0, 200)}` };
  }
}
