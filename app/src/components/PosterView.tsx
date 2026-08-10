/**
 * Before/after poster builder (§ gallery).
 *
 * PICK: choose two photos — the first is the complaint, the second is the
 * fix; the badge numbers say which is which and tapping a picked photo
 * again releases it. COMPOSE: a live preview of the finished poster with
 * an editable headline, saved through the normal photo pipeline so it
 * lands in the gallery and the auto-save queue like anything else.
 *
 * The preview and the saved file call the SAME renderer at different
 * sizes, so what the user approves is what they get — the watermark's QR
 * taught that two draw paths drift apart the moment they exist.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ArrowRight } from "lucide-react";
import { listMedia, getBlob, putBlob, putMedia, newId } from "../lib/db";
import type { PhotoRecord } from "../types";
import { navigate, goBack } from "../nav";
import { canvasToBlob, makeThumbnail, loadImage } from "../lib/img";
import { writeExif } from "../lib/exif";
import { scheduleDownloads } from "../lib/downloadQueue";
import { isNativeApp } from "../lib/native";
import { useSettingsStore } from "../store";
import { fmtWard } from "../lib/geo/format";
import { usePeek } from "./peek";
import { blurOnEnter } from "./ui";
import { renderPoster, type PosterPhoto } from "../lib/poster";
import { groupHandles } from "../lib/watermark/socialStrip";
import { signStyle } from "../lib/watermark/chennaiSign";
import { loadCrest } from "../lib/watermark/crests";
import { getProfilePhoto } from "../lib/capture";

/** Export size: square, big enough to stay sharp when a platform recompresses. */
const OUT = 1440;
/** Preview size — the same renderer, a quarter of the pixels. */
const PREVIEW = 720;

const DEFAULT_HEADLINE = "Before & After";

interface Cell {
  rec: PhotoRecord;
  url: string | null;
}

/** The place line under a print: locality, else ward, else coordinates. */
function placeOf(rec: PhotoRecord): string {
  const d = rec.data;
  if (d.locality) return d.locality.split(",").slice(0, 2).join(",").trim();
  if (d.jurisdiction && d.jurisdiction.scope !== "out" && d.jurisdiction.ward) {
    return `Ward ${fmtWard(d.jurisdiction.ward)}`;
  }
  return d.fix ? `${d.fix.lat.toFixed(4)}°, ${d.fix.lng.toFixed(4)}°` : "";
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB").replace(/\//g, ".");

/**
 * The one crest that identifies the body the photo was taken in. The sign
 * renderer may draw two (a corporation's and a campaign's); a poster has
 * room for one, so prefer the body's own over the campaign mark.
 */
function crestSlot(rec: PhotoRecord): string | null {
  const style = signStyle(rec.data as never);
  if (!style) return null;
  if (style.leftLogo && style.leftLogo !== "gcc") return style.leftLogo;
  if (style.centreLogo && style.centreLogo !== "singara") return style.centreLogo;
  return style.leftLogo || style.centreLogo || null;
}

export default function PosterView() {
  const [phase, setPhase] = useState<"pick" | "compose">("pick");
  const [all, setAll] = useState<Cell[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [busy, setBusy] = useState(false);
  const { bind: bindPeek, layer: peekLayer } = usePeek();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const profile = useSettingsStore((s) => s.profile);

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      const items = (await listMedia()).filter(
        (m): m is PhotoRecord => m.kind === "photo"
      );
      const cells = await Promise.all(
        items.map(async (rec) => {
          const t = await getBlob(rec.id, "thumb");
          const url = t ? URL.createObjectURL(t) : null;
          if (url) urls.push(url);
          return { rec, url };
        })
      );
      if (!cancelled) setAll(cells);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const byId = useMemo(() => {
    const m = new Map<string, Cell>();
    for (const c of all ?? []) m.set(c.rec.id, c);
    return m;
  }, [all]);

  /**
   * Compose into `ctx` at `size`. Shared by the preview and the export;
   * the caller owns the canvas.
   */
  const compose = async (
    ctx: CanvasRenderingContext2D,
    size: number,
    full: boolean
  ): Promise<PhotoRecord | null> => {
    const recs = picked.map((id) => byId.get(id)?.rec).filter(Boolean) as PhotoRecord[];
    if (recs.length < 2) return null;

    const sides: PosterPhoto[] = [];
    for (const [i, rec] of recs.slice(0, 2).entries()) {
      // the preview reads thumbs so switching photos stays instant; the
      // export reads the real file
      const blob =
        (full ? await getBlob(rec.id, "final") : await getBlob(rec.id, "thumb")) ??
        (await getBlob(rec.id, "final"));
      if (!blob) return null;
      const img = await loadImage(blob);
      sides.push({
        img,
        w: img.naturalWidth,
        h: img.naturalHeight,
        label: i === 0 ? "Before" : "After",
        date: fmtDate(rec.createdAt),
        place: placeOf(rec),
      });
    }

    const [crest, photo] = await Promise.all([
      loadCrest(crestSlot(recs[1]) ?? crestSlot(recs[0])),
      getProfilePhoto(),
    ]);

    renderPoster(ctx, size, {
      headline,
      name: profile.displayName ?? "",
      groups: groupHandles(profile.handles),
      profilePhoto: photo,
      crest,
      before: sides[0],
      after: sides[1],
    });
    return recs[0];
  };

  // live preview
  useEffect(() => {
    if (phase !== "compose") return;
    let cancelled = false;
    void (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = PREVIEW * dpr;
      canvas.height = PREVIEW * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx || cancelled) return;
      ctx.scale(dpr, dpr);
      await compose(ctx, PREVIEW, false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, picked, headline, profile]);

  const save = async () => {
    if (busy || picked.length < 2) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const first = await compose(ctx, OUT, true);
      if (!first) return;

      const jpeg = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const withExif = await writeExif(jpeg, first.data);
      const thumb = await makeThumbnail(canvas, canvas.width, canvas.height);
      const { settings } = useSettingsStore.getState();
      const rec: PhotoRecord = {
        id: newId(),
        kind: "photo",
        createdAt: Date.now(),
        width: canvas.width,
        height: canvas.height,
        data: first.data,
        config: first.config,
        backfill: "not-needed",
        hasRaw: false,
        tags: ["poster"],
        download:
          settings.autoSaveToDevice || isNativeApp() ? "queued" : undefined,
      };
      await putBlob(rec.id, "final", withExif);
      await putBlob(rec.id, "thumb", thumb);
      await putMedia(rec);
      scheduleDownloads();
      navigate(`/media/${rec.id}`, { replace: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="screen"
      style={{ position: "fixed", inset: 0, zIndex: 10, background: "var(--bg)" }}
    >
      <header className="screen-header">
        <button
          className="icon-btn"
          onClick={() => (phase === "compose" ? setPhase("pick") : goBack())}
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <h1>
          {phase === "pick"
            ? `Before & after — pick 2 (${picked.length})`
            : "Poster"}
        </h1>
        {phase === "pick" ? (
          <button
            className="icon-btn"
            style={{ marginLeft: "auto" }}
            disabled={picked.length < 2}
            onClick={() => setPhase("compose")}
            aria-label="Compose poster"
          >
            <ArrowRight size={20} />
          </button>
        ) : (
          <button
            className="icon-btn"
            style={{ marginLeft: "auto" }}
            disabled={busy}
            onClick={() => void save()}
            aria-label="Save poster"
          >
            <Check size={20} />
          </button>
        )}
      </header>

      <div className="screen-body" style={{ display: "flex", flexDirection: "column" }}>
        {phase === "pick" && (
          <>
            {/* Same pair of tabs the collage picker shows — this screen is
                reached through the collage icon, so the way back to the
                other mode has to be here too. */}
            <div className="mode-tabs" role="tablist" aria-label="What to make">
              <button
                role="tab"
                aria-selected="false"
                onClick={() => navigate("/gallery/collage", { replace: true })}
              >
                Collage
              </button>
              <button role="tab" aria-selected="true" data-active="true">
                Before &amp; after
              </button>
            </div>
            <div className="hint" style={{ padding: "0 2px 8px" }}>
              Pick the complaint first, then the photo that shows it fixed.
              Hold a photo to preview it.
            </div>
            <div className="gallery-grid">
              {all?.map(({ rec, url }) => {
                const sel = picked.indexOf(rec.id);
                return (
                  <button
                    key={rec.id}
                    className={`gallery-cell${sel >= 0 ? " selected" : ""}`}
                    aria-pressed={sel >= 0}
                    aria-label={
                      [placeOf(rec), fmtDate(rec.createdAt)]
                        .filter(Boolean)
                        .join(", ") || "Photo"
                    }
                    {...bindPeek(rec)}
                    onClick={() =>
                      setPicked((p) =>
                        sel >= 0
                          ? p.filter((x) => x !== rec.id)
                          : p.length >= 2
                            ? [p[1], rec.id]
                            : [...p, rec.id]
                      )
                    }
                  >
                    {url && <img src={url} alt="" loading="lazy" />}
                    {sel >= 0 && (
                      <span className="pick-badge">
                        {sel === 0 ? "Before" : "After"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {phase === "compose" && (
          <>
            <label className="hint" htmlFor="poster-headline" style={{ padding: "0 2px 4px" }}>
              Headline
            </label>
            <input
              id="poster-headline"
              value={headline}
              maxLength={40}
              placeholder={DEFAULT_HEADLINE}
              onChange={(e) => setHeadline(e.target.value)}
              onKeyDown={blurOnEnter}
            />
            <div className="poster-preview">
              <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "auto", display: "block" }}
                aria-label="Poster preview"
              />
            </div>
          </>
        )}
      </div>
      {peekLayer}
    </div>
  );
}
